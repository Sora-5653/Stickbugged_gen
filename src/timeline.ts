/*
 * 動画の区間構成と、時刻 t のフレームを描く関数。
 * プレビュー再生と書き出しの両方がこのモジュールだけを使って絵を作る。
 */

export const FPS = 30;

/** gsbl の既定の変形時間（52フレーム / 30fps） */
export const DEFAULT_TRANSFORM_FRAMES = 52;
export const DEFAULT_TRANSFORM_SECONDS = DEFAULT_TRANSFORM_FRAMES / FPS;

export const IMAGE_SECONDS = 1.0;
export const LINE_SECONDS = 0.33;
export const HOLD_SECONDS = 1.0;
export const BG_SWITCH_SECONDS = 0.75;
export const SEGMENT_COUNT = 9;

/** 線分 [x1, y1, x2, y2, width]（出力キャンバスの座標） */
export type Segment = [number, number, number, number, number];

export type RGB = [number, number, number];

/** gsbl の棒虫の形（stick_bug.mp4 のフレーム座標、線幅 8） */
export const STICK_BUG_SEGMENTS: Segment[] = [
  [315, 212, 408, 262, 8],
  [408, 262, 511, 263, 8],
  [236, 266, 332, 223, 8],
  [170, 339, 236, 266, 8],
  [268, 351, 320, 228, 8],
  [319, 297, 372, 247, 8],
  [306, 353, 319, 297, 8],
  [364, 360, 398, 260, 8],
  [494, 370, 489, 264, 8],
];

export interface Timeline {
  linesStart: number;
  holdStart: number;
  bgStart: number;
  transformStart: number;
  transformFrames: number;
  transformSeconds: number;
  tailStart: number;
  duration: number;
}

/** 変形の秒数から各区間の開始時刻を求める。変形はフレーム数単位に丸める */
export function makeTimeline(transformSeconds: number, tailSeconds: number): Timeline {
  const transformFrames = Math.max(2, Math.round(transformSeconds * FPS));
  const linesStart = IMAGE_SECONDS;
  const holdStart = linesStart + LINE_SECONDS * SEGMENT_COUNT;
  const bgStart = holdStart + HOLD_SECONDS;
  const transformStart = bgStart + BG_SWITCH_SECONDS;
  const tailStart = transformStart + transformFrames / FPS;
  return {
    linesStart,
    holdStart,
    bgStart,
    transformStart,
    transformFrames,
    transformSeconds: transformFrames / FPS,
    tailStart,
    duration: tailStart + tailSeconds,
  };
}

export interface Placement {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 内側に収まるよう拡大縮小して中央に置く（切り抜かない） */
export function fitContain(srcW: number, srcH: number, dstW: number, dstH: number): Placement {
  const s = Math.min(dstW / srcW, dstH / srcH);
  const w = srcW * s;
  const h = srcH * s;
  return { x: (dstW - w) / 2, y: (dstH - h) / 2, w, h };
}

/** 棒虫の形を出力キャンバスの座標に変換する（gsbl と同じく動画の配置に合わせる） */
export function stickBugTargets(width: number, height: number, videoW: number, videoH: number): Segment[] {
  const p = fitContain(videoW, videoH, width, height);
  const s = p.w / videoW;
  return STICK_BUG_SEGMENTS.map(([x1, y1, x2, y2, w]) => [x1 * s + p.x, y1 * s + p.y, x2 * s + p.x, y2 * s + p.y, w * s]);
}

export function lerpSegment(a: Segment, b: Segment, t: number): Segment {
  return [0, 1, 2, 3, 4].map((k) => a[k] + (b[k] - a[k]) * t) as Segment;
}

export type Easing = 'linear' | 'ease-in-out';

function ease(t: number, easing: Easing): number {
  if (easing === 'ease-in-out') return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
  return t;
}

export interface Scene {
  width: number;
  height: number;
  image: CanvasImageSource;
  imagePlacement: Placement;
  segments: Segment[];
  targets: Segment[];
  imgBgColor: RGB;
  lineColor: RGB;
  lineBgColor: RGB;
  easing: Easing;
  timeline: Timeline;
}

const css = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;

function drawSegments(ctx: CanvasRenderingContext2D, segs: Segment[], color: RGB): void {
  ctx.strokeStyle = css(color);
  ctx.lineCap = 'round';
  for (const [x1, y1, x2, y2, w] of segs) {
    ctx.lineWidth = Math.max(1, w);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
}

function drawImageScene(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const { imagePlacement: p } = scene;
  ctx.fillStyle = css(scene.imgBgColor);
  ctx.fillRect(0, 0, scene.width, scene.height);
  ctx.drawImage(scene.image, p.x, p.y, p.w, p.h);
}

/** 変形区間の進み具合（0〜1）。書き出しでは最終フレームでちょうど 1 になる */
export function transformProgress(t: number, tl: Timeline): number {
  const span = (tl.transformFrames - 1) / FPS;
  return Math.min(1, Math.max(0, (t - tl.transformStart) / span));
}

/**
 * 時刻 t のフレームを描く。棒虫の動画区間では tailFrame を描く（無ければ背景だけ）。
 */
export function drawFrame(ctx: CanvasRenderingContext2D, scene: Scene, t: number, tailFrame?: CanvasImageSource | null): void {
  const tl = scene.timeline;
  const segs = scene.segments;

  if (t < tl.linesStart) {
    drawImageScene(ctx, scene);
  } else if (t < tl.holdStart) {
    drawImageScene(ctx, scene);
    const shown = Math.min(segs.length, Math.floor((t - tl.linesStart) / LINE_SECONDS) + 1);
    drawSegments(ctx, segs.slice(0, shown), scene.lineColor);
  } else if (t < tl.bgStart) {
    drawImageScene(ctx, scene);
    drawSegments(ctx, segs, scene.lineColor);
  } else if (t < tl.transformStart) {
    ctx.fillStyle = css(scene.lineBgColor);
    ctx.fillRect(0, 0, scene.width, scene.height);
    drawSegments(ctx, segs, scene.lineColor);
  } else if (t < tl.tailStart) {
    const k = ease(transformProgress(t, tl), scene.easing);
    ctx.fillStyle = css(scene.lineBgColor);
    ctx.fillRect(0, 0, scene.width, scene.height);
    drawSegments(ctx, segs.map((s, i) => lerpSegment(s, scene.targets[i], k)), scene.lineColor);
  } else {
    // 棒虫の動画は gsbl と同じく中央に置く。余白は線の背景色で埋める（動画の背景と同じ灰色）
    ctx.fillStyle = css(scene.lineBgColor);
    ctx.fillRect(0, 0, scene.width, scene.height);
    if (tailFrame) {
      const w = (tailFrame as HTMLVideoElement).videoWidth || (tailFrame as HTMLCanvasElement).width;
      const h = (tailFrame as HTMLVideoElement).videoHeight || (tailFrame as HTMLCanvasElement).height;
      const p = fitContain(w as number, h as number, scene.width, scene.height);
      ctx.drawImage(tailFrame, p.x, p.y, p.w, p.h);
    }
  }
}

/** 線分の長さ */
export function segmentLength(s: Segment): number {
  return Math.hypot(s[2] - s[0], s[3] - s[1]);
}
