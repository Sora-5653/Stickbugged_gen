import type { DetectRequest, DetectResponse } from './detect.worker.ts';
import { fitContain, segmentLength, type RGB, type Segment } from './timeline.ts';

export interface DetectParams {
  /** LSD の内部縮小率（gsbl の --scale） */
  scale: number;
  /** これより短い線分（出力キャンバス上の px）を候補から外す */
  minLength: number;
}

export const DEFAULT_DETECT_PARAMS: DetectParams = { scale: 0.8, minLength: 0 };

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (r: DetectResponse) => void>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./detect.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<DetectResponse>) => {
      pending.get(ev.data.id)?.(ev.data);
      pending.delete(ev.data.id);
    };
  }
  return worker;
}

export interface DetectResult {
  /** 候補の線分（画像の元の画素座標）。長い順 */
  candidates: Segment[];
  /** candidates と同じ順の、輪郭の強さ（0〜255） */
  contrast: number[];
  ms: number;
}

/**
 * 画像を出力解像度に収まる大きさへ縮小し（gsbl と同じ）、LSD で線分を検出する。
 * 結果は画像の元の画素座標で返すので、あとで解像度を変えても線分の編集結果を保てる。
 */
export async function detectSegments(image: ImageBitmap, outW: number, outH: number, bg: RGB, params: DetectParams): Promise<DetectResult> {
  const p = fitContain(image.width, image.height, outW, outH);
  const w = Math.max(1, Math.round(p.w));
  const h = Math.max(1, Math.round(p.h));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  // 透過部分は画像の背景色の上に合成してから輝度にする
  ctx.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(image, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];

  const id = nextId++;
  const res = await new Promise<DetectResponse>((resolve) => {
    pending.set(id, resolve);
    const req: DetectRequest = { id, gray, width: w, height: h, options: { scale: params.scale } };
    getWorker().postMessage(req, [gray.buffer]);
  });
  if (res.error || !res.segments) throw new Error(res.error ?? 'detection failed');

  // LSD の座標は画素の中心が原点なので +0.5 してキャンバス座標にし、画像の元の大きさに戻す
  const k = image.width / w;
  const outScale = p.w / image.width; // 画像座標 → 出力キャンバスの倍率
  const contrast = res.contrast!;
  const rows = res.segments
    .map((s, i) => ({ seg: [(s.x1 + 0.5) * k, (s.y1 + 0.5) * k, (s.x2 + 0.5) * k, (s.y2 + 0.5) * k, s.width * k] as Segment, contrast: contrast[i] }))
    .filter((r) => segmentLength(r.seg) * outScale >= params.minLength)
    .sort((a, b) => segmentLength(b.seg) - segmentLength(a.seg));
  return { candidates: rows.map((r) => r.seg), contrast: rows.map((r) => r.contrast), ms: res.ms };
}
