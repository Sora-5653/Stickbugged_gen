/*
 * 9本の線分の自動選択。
 * - edgeContrast: 線分の両側の明るさの差（輪郭の鮮明さ）を測る
 * - selectSegments: 点数の高い順に、中点が近すぎない線分を選ぶ（ポアソン円盤と同じ考え方）
 * どちらも DOM に依存しない純粋な関数。
 */

export interface SelectParams {
  /** 採用する線分どうしの中点の最小距離（出力キャンバス上の px）。0 で制約なし */
  minSpacing: number;
  /** 輪郭の強さをどれだけ重視するか。0 で長さだけ（gsbl と同じ） */
  contrastWeight: number;
}

export const DEFAULT_SELECT_PARAMS: SelectParams = { minSpacing: 40, contrastWeight: 1 };

export interface Candidate {
  /** 出力キャンバス上の長さ（px） */
  length: number;
  /** 中点（出力キャンバス座標） */
  mx: number;
  my: number;
  /** 両側の明るさの差の平均（0〜255） */
  contrast: number;
}

function bilinear(gray: ArrayLike<number>, w: number, h: number, x: number, y: number): number {
  const cx = Math.min(Math.max(x, 0), w - 1);
  const cy = Math.min(Math.max(y, 0), h - 1);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const a = gray[y0 * w + x0] * (1 - fx) + gray[y0 * w + x1] * fx;
  const b = gray[y1 * w + x0] * (1 - fx) + gray[y1 * w + x1] * fx;
  return a * (1 - fy) + b * fy;
}

/**
 * 線分の両側（法線方向に width/2 + 1 px 離れた位置）の明るさの差の平均。
 * 座標は画素の中心が整数になる座標系（LSD の出力と同じ）。端の1割は角の影響を避けて使わない。
 */
export function edgeContrast(gray: ArrayLike<number>, w: number, h: number, x1: number, y1: number, x2: number, y2: number, width: number): number {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 1e-6) return 0;
  const nx = -(y2 - y1) / len;
  const ny = (x2 - x1) / len;
  const off = Math.max(1.5, width / 2 + 1);
  const n = Math.max(2, Math.ceil(len));
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const t = 0.1 + (0.8 * i) / (n - 1);
    const px = x1 + (x2 - x1) * t;
    const py = y1 + (y2 - y1) * t;
    sum += Math.abs(bilinear(gray, w, h, px + nx * off, py + ny * off) - bilinear(gray, w, h, px - nx * off, py - ny * off));
  }
  return sum / n;
}

export function score(c: Candidate, maxContrast: number, contrastWeight: number): number {
  if (contrastWeight <= 0 || maxContrast <= 0) return c.length;
  return c.length * (c.contrast / maxContrast) ** contrastWeight;
}

/**
 * 点数の高い順に、採用済みの線分と中点が minSpacing 以上離れたものを count 本選ぶ。
 * 足りなければ間隔を 0.8 倍ずつ緩めてやり直す。返り値は候補の添字（点数の高い順）。
 */
export function selectSegments(cands: Candidate[], params: SelectParams, count = 9): number[] {
  const maxContrast = cands.reduce((m, c) => Math.max(m, c.contrast), 0);
  const order = cands
    .map((c, i) => ({ i, s: score(c, maxContrast, params.contrastWeight) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((o) => o.i);

  let spacing = params.minSpacing;
  for (;;) {
    const picked: number[] = [];
    for (const i of order) {
      if (picked.length >= count) break;
      const c = cands[i];
      if (spacing > 0 && picked.some((j) => Math.hypot(cands[j].mx - c.mx, cands[j].my - c.my) < spacing)) continue;
      picked.push(i);
    }
    if (picked.length >= Math.min(count, cands.length) || spacing === 0) return picked;
    // 緩めても足りなければ、最後は制約なしで埋める（中点が重なる候補もありうる）
    spacing = spacing * 0.8 < 1 ? 0 : spacing * 0.8;
  }
}
