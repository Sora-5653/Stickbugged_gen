/*
 * LSD (Line Segment Detector) の TypeScript 移植。
 *
 * 元: LSD 1.6 "LSD: a Line Segment Detector"
 *   Rafael Grompone von Gioi, Jeremie Jakubowicz, Jean-Michel Morel, Gregory Randall,
 *   Image Processing On Line, 2012. DOI:10.5201/ipol.2012.gjmr-lsd
 *   Copyright (c) 2007-2011 rafael grompone von gioi
 *
 * 元コードは GNU Affero General Public License v3 以降で配布されており、
 * この移植も同じライセンスに従う。
 *
 * 処理の順番と浮動小数点演算の順序は lsd.c に合わせてある
 * （参照出力 chairs.lsd.txt と数値で照合するため）。
 */

export interface LsdOptions {
  /** 画像をこの倍率にガウス縮小してから検出する（lsd.c の既定値 0.8） */
  scale?: number;
  sigmaScale?: number;
  quant?: number;
  /** 勾配方向の許容角（度） */
  angTh?: number;
  logEps?: number;
  densityTh?: number;
  nBins?: number;
}

/** 検出結果1本。座標は入力画像の画素座標（画素(0,0)の中心が原点）。 */
export interface LsdSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  p: number;
  logNfa: number;
}

const NOTDEF = -1024.0;
const M_3_2_PI = 4.71238898038;
const M_2__PI = 6.28318530718;
const M_LN10 = 2.30258509299404568402;
const NOTUSED = 0;
const USED = 1;
const RELATIVE_ERROR_FACTOR = 100.0;
const DBL_EPSILON = 2.220446049250313e-16;
const DBL_MIN = 2.2250738585072014e-308;

interface ImageDouble {
  data: Float64Array;
  xsize: number;
  ysize: number;
}

function doubleEqual(a: number, b: number): boolean {
  if (a === b) return true;
  const absDiff = Math.abs(a - b);
  const aa = Math.abs(a);
  const bb = Math.abs(b);
  let absMax = aa > bb ? aa : bb;
  if (absMax < DBL_MIN) absMax = DBL_MIN;
  return absDiff / absMax <= RELATIVE_ERROR_FACTOR * DBL_EPSILON;
}

function dist(x1: number, y1: number, x2: number, y2: number): number {
  return Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1));
}

/*----------------------------- Gaussian sampler -----------------------------*/

function gaussianKernel(kernel: Float64Array, sigma: number, mean: number): void {
  let sum = 0.0;
  for (let i = 0; i < kernel.length; i++) {
    const val = (i - mean) / sigma;
    kernel[i] = Math.exp(-0.5 * val * val);
    sum += kernel[i];
  }
  if (sum >= 0.0) for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
}

function gaussianSampler(input: ImageDouble, scale: number, sigmaScale: number): ImageDouble {
  const N = Math.ceil(input.xsize * scale);
  const M = Math.ceil(input.ysize * scale);
  const aux: ImageDouble = { data: new Float64Array(N * input.ysize), xsize: N, ysize: input.ysize };
  const out: ImageDouble = { data: new Float64Array(N * M), xsize: N, ysize: M };
  const sigma = scale < 1.0 ? sigmaScale / scale : sigmaScale;

  const prec = 3.0;
  const h = Math.ceil(sigma * Math.sqrt(2.0 * prec * Math.log(10.0)));
  const n = 1 + 2 * h;
  const kernel = new Float64Array(n);

  const doubleXSize = 2 * input.xsize;
  const doubleYSize = 2 * input.ysize;

  // x 方向
  for (let x = 0; x < aux.xsize; x++) {
    const xx = x / scale;
    const xc = Math.floor(xx + 0.5);
    gaussianKernel(kernel, sigma, h + xx - xc);
    for (let y = 0; y < aux.ysize; y++) {
      let sum = 0.0;
      for (let i = 0; i < n; i++) {
        let j = xc - h + i;
        while (j < 0) j += doubleXSize;
        while (j >= doubleXSize) j -= doubleXSize;
        if (j >= input.xsize) j = doubleXSize - 1 - j;
        sum += input.data[j + y * input.xsize] * kernel[i];
      }
      aux.data[x + y * aux.xsize] = sum;
    }
  }

  // y 方向
  for (let y = 0; y < out.ysize; y++) {
    const yy = y / scale;
    const yc = Math.floor(yy + 0.5);
    gaussianKernel(kernel, sigma, h + yy - yc);
    for (let x = 0; x < out.xsize; x++) {
      let sum = 0.0;
      for (let i = 0; i < n; i++) {
        let j = yc - h + i;
        while (j < 0) j += doubleYSize;
        while (j >= doubleYSize) j -= doubleYSize;
        if (j >= input.ysize) j = doubleYSize - 1 - j;
        sum += aux.data[x + j * aux.xsize] * kernel[i];
      }
      out.data[x + y * out.xsize] = sum;
    }
  }
  return out;
}

/*--------------------------------- Gradient ---------------------------------*/

interface AngleResult {
  angles: ImageDouble;
  modgrad: ImageDouble;
  /** 勾配の大きい順（ビン単位の擬似ソート）に並んだ画素の添字 */
  order: Int32Array;
}

function llAngle(input: ImageDouble, threshold: number, nBins: number): AngleResult {
  const n = input.ysize;
  const p = input.xsize;
  const g = new Float64Array(p * n);
  const modgrad = new Float64Array(p * n);
  let maxGrad = 0.0;

  for (let x = 0; x < p; x++) g[(n - 1) * p + x] = NOTDEF;
  for (let y = 0; y < n; y++) g[p * y + p - 1] = NOTDEF;

  const d = input.data;
  for (let x = 0; x < p - 1; x++) {
    for (let y = 0; y < n - 1; y++) {
      const adr = y * p + x;
      const com1 = d[adr + p + 1] - d[adr];
      const com2 = d[adr + 1] - d[adr + p];
      const gx = com1 + com2;
      const gy = com1 - com2;
      const norm2 = gx * gx + gy * gy;
      const norm = Math.sqrt(norm2 / 4.0);
      modgrad[adr] = norm;
      if (norm <= threshold) {
        g[adr] = NOTDEF;
      } else {
        g[adr] = Math.atan2(gx, -gy);
        if (norm > maxGrad) maxGrad = norm;
      }
    }
  }

  // ビンごとの連結リスト（lsd.c と同じく x 外側・y 内側の挿入順を保つ）
  const count = (p - 1) * (n - 1);
  const px = new Int32Array(count);
  const next = new Int32Array(count).fill(-1);
  const binStart = new Int32Array(nBins).fill(-1);
  const binEnd = new Int32Array(nBins).fill(-1);
  let listCount = 0;
  for (let x = 0; x < p - 1; x++) {
    for (let y = 0; y < n - 1; y++) {
      const norm = modgrad[y * p + x];
      let i = maxGrad > 0 ? Math.floor((norm * nBins) / maxGrad) : 0;
      if (i >= nBins) i = nBins - 1;
      const node = listCount++;
      px[node] = y * p + x;
      if (binEnd[i] === -1) binStart[i] = node;
      else next[binEnd[i]] = node;
      binEnd[i] = node;
    }
  }

  const order = new Int32Array(count);
  let k = 0;
  for (let i = nBins - 1; i >= 0; i--) {
    for (let node = binStart[i]; node !== -1; node = next[node]) order[k++] = px[node];
  }

  return {
    angles: { data: g, xsize: p, ysize: n },
    modgrad: { data: modgrad, xsize: p, ysize: n },
    order,
  };
}

function isAligned(x: number, y: number, angles: ImageDouble, theta: number, prec: number): boolean {
  const a = angles.data[x + y * angles.xsize];
  if (a === NOTDEF) return false;
  theta -= a;
  if (theta < 0.0) theta = -theta;
  if (theta > M_3_2_PI) {
    theta -= M_2__PI;
    if (theta < 0.0) theta = -theta;
  }
  return theta <= prec;
}

function angleDiff(a: number, b: number): number {
  a -= b;
  while (a <= -Math.PI) a += M_2__PI;
  while (a > Math.PI) a -= M_2__PI;
  if (a < 0.0) a = -a;
  return a;
}

function angleDiffSigned(a: number, b: number): number {
  a -= b;
  while (a <= -Math.PI) a += M_2__PI;
  while (a > Math.PI) a -= M_2__PI;
  return a;
}

/*----------------------------- NFA computation ------------------------------*/

const LANCZOS_Q = [75122.633153, 80916.6278952, 36308.2951477, 8687.24529705, 1168.92649479, 83.8676043424, 2.50662827511];

function logGammaLanczos(x: number): number {
  let a = (x + 0.5) * Math.log(x + 5.5) - (x + 5.5);
  let b = 0.0;
  for (let n = 0; n < 7; n++) {
    a -= Math.log(x + n);
    b += LANCZOS_Q[n] * Math.pow(x, n);
  }
  return a + Math.log(b);
}

function logGammaWindschitl(x: number): number {
  return 0.918938533204673 + (x - 0.5) * Math.log(x) - x + 0.5 * x * Math.log(x * Math.sinh(1 / x) + 1 / (810.0 * Math.pow(x, 6.0)));
}

function logGamma(x: number): number {
  return x > 15.0 ? logGammaWindschitl(x) : logGammaLanczos(x);
}

function nfa(n: number, k: number, p: number, logNT: number): number {
  const tolerance = 0.1;
  if (n < 0 || k < 0 || k > n || p <= 0.0 || p >= 1.0) throw new Error('nfa: wrong n, k or p values.');
  if (n === 0 || k === 0) return -logNT;
  if (n === k) return -logNT - n * Math.log10(p);

  const pTerm = p / (1.0 - p);
  const log1term = logGamma(n + 1.0) - logGamma(k + 1.0) - logGamma(n - k + 1.0) + k * Math.log(p) + (n - k) * Math.log(1.0 - p);
  let term = Math.exp(log1term);

  if (doubleEqual(term, 0.0)) {
    if (k > n * p) return -log1term / M_LN10 - logNT;
    return -logNT;
  }

  let binTail = term;
  for (let i = k + 1; i <= n; i++) {
    const binTerm = (n - i + 1) * (1.0 / i);
    const multTerm = binTerm * pTerm;
    term *= multTerm;
    binTail += term;
    if (binTerm < 1.0) {
      const err = term * ((1.0 - Math.pow(multTerm, n - i + 1)) / (1.0 - multTerm) - 1.0);
      if (err < tolerance * Math.abs(-Math.log10(binTail) - logNT) * binTail) break;
    }
  }
  return -Math.log10(binTail) - logNT;
}

/*--------------------------- Rectangle structure ----------------------------*/

interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  x: number;
  y: number;
  theta: number;
  dx: number;
  dy: number;
  prec: number;
  p: number;
}

function newRect(): Rect {
  return { x1: 0, y1: 0, x2: 0, y2: 0, width: 0, x: 0, y: 0, theta: 0, dx: 0, dy: 0, prec: 0, p: 0 };
}

function rectCopy(src: Rect, dst: Rect): void {
  Object.assign(dst, src);
}

function interLow(x: number, x1: number, y1: number, x2: number, y2: number): number {
  if (doubleEqual(x1, x2) && y1 < y2) return y1;
  if (doubleEqual(x1, x2) && y1 > y2) return y2;
  return y1 + ((x - x1) * (y2 - y1)) / (x2 - x1);
}

function interHi(x: number, x1: number, y1: number, x2: number, y2: number): number {
  if (doubleEqual(x1, x2) && y1 < y2) return y2;
  if (doubleEqual(x1, x2) && y1 > y2) return y1;
  return y1 + ((x - x1) * (y2 - y1)) / (x2 - x1);
}

/** 長方形の内側にある整数画素を列ごとに走査するイテレータ（lsd.c の rect_iter） */
class RectIter {
  vx = [0, 0, 0, 0];
  vy = [0, 0, 0, 0];
  ys = 0;
  ye = 0;
  x = 0;
  y = 0;

  constructor(r: Rect) {
    const vx = [
      r.x1 - (r.dy * r.width) / 2.0,
      r.x2 - (r.dy * r.width) / 2.0,
      r.x2 + (r.dy * r.width) / 2.0,
      r.x1 + (r.dy * r.width) / 2.0,
    ];
    const vy = [
      r.y1 + (r.dx * r.width) / 2.0,
      r.y2 + (r.dx * r.width) / 2.0,
      r.y2 - (r.dx * r.width) / 2.0,
      r.y1 - (r.dx * r.width) / 2.0,
    ];
    let offset: number;
    if (r.x1 < r.x2 && r.y1 <= r.y2) offset = 0;
    else if (r.x1 >= r.x2 && r.y1 < r.y2) offset = 1;
    else if (r.x1 > r.x2 && r.y1 >= r.y2) offset = 2;
    else offset = 3;
    for (let n = 0; n < 4; n++) {
      this.vx[n] = vx[(offset + n) % 4];
      this.vy[n] = vy[(offset + n) % 4];
    }
    this.x = Math.ceil(this.vx[0]) - 1;
    this.y = Math.ceil(this.vy[0]);
    this.ys = this.ye = -Number.MAX_VALUE;
    this.inc();
  }

  end(): boolean {
    return this.x > this.vx[2];
  }

  inc(): void {
    if (!this.end()) this.y++;
    while (this.y > this.ye && !this.end()) {
      this.x++;
      if (this.end()) return;
      const { vx, vy } = this;
      if (this.x < vx[3]) this.ys = interLow(this.x, vx[0], vy[0], vx[3], vy[3]);
      else this.ys = interLow(this.x, vx[3], vy[3], vx[2], vy[2]);
      if (this.x < vx[1]) this.ye = interHi(this.x, vx[0], vy[0], vx[1], vy[1]);
      else this.ye = interHi(this.x, vx[1], vy[1], vx[2], vy[2]);
      this.y = Math.ceil(this.ys);
    }
  }
}

function rectNfa(rec: Rect, angles: ImageDouble, logNT: number): number {
  let pts = 0;
  let alg = 0;
  for (const i = new RectIter(rec); !i.end(); i.inc()) {
    if (i.x >= 0 && i.y >= 0 && i.x < angles.xsize && i.y < angles.ysize) {
      ++pts;
      if (isAligned(i.x, i.y, angles, rec.theta, rec.prec)) ++alg;
    }
  }
  return nfa(pts, alg, rec.p, logNT);
}

/*---------------------------------- Regions ---------------------------------*/

interface Region {
  x: Int32Array;
  y: Int32Array;
  size: number;
  angle: number;
}

function getTheta(reg: Region, x: number, y: number, modgrad: ImageDouble, regAngle: number, prec: number): number {
  let Ixx = 0.0;
  let Iyy = 0.0;
  let Ixy = 0.0;
  for (let i = 0; i < reg.size; i++) {
    const weight = modgrad.data[reg.x[i] + reg.y[i] * modgrad.xsize];
    Ixx += (reg.y[i] - y) * (reg.y[i] - y) * weight;
    Iyy += (reg.x[i] - x) * (reg.x[i] - x) * weight;
    Ixy -= (reg.x[i] - x) * (reg.y[i] - y) * weight;
  }
  if (doubleEqual(Ixx, 0.0) && doubleEqual(Iyy, 0.0) && doubleEqual(Ixy, 0.0)) throw new Error('get_theta: null inertia matrix.');
  const lambda = 0.5 * (Ixx + Iyy - Math.sqrt((Ixx - Iyy) * (Ixx - Iyy) + 4.0 * Ixy * Ixy));
  let theta = Math.abs(Ixx) > Math.abs(Iyy) ? Math.atan2(lambda - Ixx, Ixy) : Math.atan2(Ixy, lambda - Iyy);
  if (angleDiff(theta, regAngle) > prec) theta += Math.PI;
  return theta;
}

function region2rect(reg: Region, modgrad: ImageDouble, regAngle: number, prec: number, p: number, rec: Rect): void {
  let x = 0.0;
  let y = 0.0;
  let sum = 0.0;
  for (let i = 0; i < reg.size; i++) {
    const weight = modgrad.data[reg.x[i] + reg.y[i] * modgrad.xsize];
    x += reg.x[i] * weight;
    y += reg.y[i] * weight;
    sum += weight;
  }
  if (sum <= 0.0) throw new Error('region2rect: weights sum equal to zero.');
  x /= sum;
  y /= sum;

  const theta = getTheta(reg, x, y, modgrad, regAngle, prec);
  const dx = Math.cos(theta);
  const dy = Math.sin(theta);
  let lMin = 0.0;
  let lMax = 0.0;
  let wMin = 0.0;
  let wMax = 0.0;
  for (let i = 0; i < reg.size; i++) {
    const l = (reg.x[i] - x) * dx + (reg.y[i] - y) * dy;
    const w = -(reg.x[i] - x) * dy + (reg.y[i] - y) * dx;
    if (l > lMax) lMax = l;
    if (l < lMin) lMin = l;
    if (w > wMax) wMax = w;
    if (w < wMin) wMin = w;
  }

  rec.x1 = x + lMin * dx;
  rec.y1 = y + lMin * dy;
  rec.x2 = x + lMax * dx;
  rec.y2 = y + lMax * dy;
  rec.width = wMax - wMin;
  rec.x = x;
  rec.y = y;
  rec.theta = theta;
  rec.dx = dx;
  rec.dy = dy;
  rec.prec = prec;
  rec.p = p;
  if (rec.width < 1.0) rec.width = 1.0;
}

function regionGrow(x: number, y: number, angles: ImageDouble, reg: Region, used: Uint8Array, prec: number): void {
  const xsize = angles.xsize;
  const ysize = angles.ysize;
  reg.size = 1;
  reg.x[0] = x;
  reg.y[0] = y;
  reg.angle = angles.data[x + y * xsize];
  let sumdx = Math.cos(reg.angle);
  let sumdy = Math.sin(reg.angle);
  used[x + y * xsize] = USED;

  for (let i = 0; i < reg.size; i++) {
    const rx = reg.x[i];
    const ry = reg.y[i];
    for (let xx = rx - 1; xx <= rx + 1; xx++) {
      for (let yy = ry - 1; yy <= ry + 1; yy++) {
        if (xx >= 0 && yy >= 0 && xx < xsize && yy < ysize && used[xx + yy * xsize] !== USED && isAligned(xx, yy, angles, reg.angle, prec)) {
          used[xx + yy * xsize] = USED;
          reg.x[reg.size] = xx;
          reg.y[reg.size] = yy;
          ++reg.size;
          sumdx += Math.cos(angles.data[xx + yy * xsize]);
          sumdy += Math.sin(angles.data[xx + yy * xsize]);
          reg.angle = Math.atan2(sumdy, sumdx);
        }
      }
    }
  }
}

function rectImprove(rec: Rect, angles: ImageDouble, logNT: number, logEps: number): number {
  const r = newRect();
  const delta = 0.5;
  const delta2 = delta / 2.0;

  let logNfa = rectNfa(rec, angles, logNT);
  if (logNfa > logEps) return logNfa;

  // より細かい角度精度を試す
  rectCopy(rec, r);
  for (let n = 0; n < 5; n++) {
    r.p /= 2.0;
    r.prec = r.p * Math.PI;
    const v = rectNfa(r, angles, logNT);
    if (v > logNfa) {
      logNfa = v;
      rectCopy(r, rec);
    }
  }
  if (logNfa > logEps) return logNfa;

  // 幅を狭める
  rectCopy(rec, r);
  for (let n = 0; n < 5; n++) {
    if (r.width - delta >= 0.5) {
      r.width -= delta;
      const v = rectNfa(r, angles, logNT);
      if (v > logNfa) {
        rectCopy(r, rec);
        logNfa = v;
      }
    }
  }
  if (logNfa > logEps) return logNfa;

  // 片側を削る
  rectCopy(rec, r);
  for (let n = 0; n < 5; n++) {
    if (r.width - delta >= 0.5) {
      r.x1 += -r.dy * delta2;
      r.y1 += r.dx * delta2;
      r.x2 += -r.dy * delta2;
      r.y2 += r.dx * delta2;
      r.width -= delta;
      const v = rectNfa(r, angles, logNT);
      if (v > logNfa) {
        rectCopy(r, rec);
        logNfa = v;
      }
    }
  }
  if (logNfa > logEps) return logNfa;

  // 反対側を削る
  rectCopy(rec, r);
  for (let n = 0; n < 5; n++) {
    if (r.width - delta >= 0.5) {
      r.x1 -= -r.dy * delta2;
      r.y1 -= r.dx * delta2;
      r.x2 -= -r.dy * delta2;
      r.y2 -= r.dx * delta2;
      r.width -= delta;
      const v = rectNfa(r, angles, logNT);
      if (v > logNfa) {
        rectCopy(r, rec);
        logNfa = v;
      }
    }
  }
  if (logNfa > logEps) return logNfa;

  // さらに細かい角度精度を試す
  rectCopy(rec, r);
  for (let n = 0; n < 5; n++) {
    r.p /= 2.0;
    r.prec = r.p * Math.PI;
    const v = rectNfa(r, angles, logNT);
    if (v > logNfa) {
      logNfa = v;
      rectCopy(r, rec);
    }
  }
  return logNfa;
}

function regionDensity(reg: Region, rec: Rect): number {
  return reg.size / (dist(rec.x1, rec.y1, rec.x2, rec.y2) * rec.width);
}

function reduceRegionRadius(
  reg: Region, modgrad: ImageDouble, regAngle: number, prec: number, p: number,
  rec: Rect, used: Uint8Array, angles: ImageDouble, densityTh: number,
): boolean {
  let density = regionDensity(reg, rec);
  if (density >= densityTh) return true;

  const xc = reg.x[0];
  const yc = reg.y[0];
  const rad1 = dist(xc, yc, rec.x1, rec.y1);
  const rad2 = dist(xc, yc, rec.x2, rec.y2);
  let rad = rad1 > rad2 ? rad1 : rad2;

  while (density < densityTh) {
    rad *= 0.75;
    for (let i = 0; i < reg.size; i++) {
      if (dist(xc, yc, reg.x[i], reg.y[i]) > rad) {
        used[reg.x[i] + reg.y[i] * angles.xsize] = NOTUSED;
        reg.x[i] = reg.x[reg.size - 1];
        reg.y[i] = reg.y[reg.size - 1];
        --reg.size;
        --i;
      }
    }
    if (reg.size < 2) return false;
    region2rect(reg, modgrad, regAngle, prec, p, rec);
    density = regionDensity(reg, rec);
  }
  return true;
}

function refine(
  reg: Region, modgrad: ImageDouble, regAngle: number, prec: number, p: number,
  rec: Rect, used: Uint8Array, angles: ImageDouble, densityTh: number,
): boolean {
  let density = regionDensity(reg, rec);
  if (density >= densityTh) return true;

  // 1回目: 角度の許容幅を狭めて領域を作り直す
  const xc = reg.x[0];
  const yc = reg.y[0];
  const angC = angles.data[reg.x[0] + reg.y[0] * angles.xsize];
  let sum = 0.0;
  let sSum = 0.0;
  let n = 0;
  for (let i = 0; i < reg.size; i++) {
    used[reg.x[i] + reg.y[i] * angles.xsize] = NOTUSED;
    if (dist(xc, yc, reg.x[i], reg.y[i]) < rec.width) {
      const angle = angles.data[reg.x[i] + reg.y[i] * angles.xsize];
      const angD = angleDiffSigned(angle, angC);
      sum += angD;
      sSum += angD * angD;
      ++n;
    }
  }
  const meanAngle = sum / n;
  const tau = 2.0 * Math.sqrt((sSum - 2.0 * meanAngle * sum) / n + meanAngle * meanAngle);

  regionGrow(reg.x[0], reg.y[0], angles, reg, used, tau);
  if (reg.size < 2) return false;
  region2rect(reg, modgrad, reg.angle, prec, p, rec);
  density = regionDensity(reg, rec);

  // 2回目: 領域の半径を縮める
  if (density < densityTh) return reduceRegionRadius(reg, modgrad, reg.angle, prec, p, rec, used, angles, densityTh);
  return true;
}

/*-------------------------- Line Segment Detector ---------------------------*/

/**
 * 輝度画像から線分を検出する。
 * @param img 輝度（0〜255 程度）の配列。画素 (x,y) は img[x + y*width]
 */
export function lsd(img: ArrayLike<number>, width: number, height: number, options: LsdOptions = {}): LsdSegment[] {
  const scale = options.scale ?? 0.8;
  const sigmaScale = options.sigmaScale ?? 0.6;
  const quant = options.quant ?? 2.0;
  const angTh = options.angTh ?? 22.5;
  const logEps = options.logEps ?? 0.0;
  const densityTh = options.densityTh ?? 0.7;
  const nBins = options.nBins ?? 1024;

  if (width <= 0 || height <= 0) throw new Error('invalid image input.');
  if (scale <= 0.0) throw new Error("'scale' value must be positive.");

  const prec = (Math.PI * angTh) / 180.0;
  const p = angTh / 180.0;
  const rho = quant / Math.sin(prec);

  const image: ImageDouble = { data: Float64Array.from(img), xsize: width, ysize: height };
  const source = scale !== 1.0 ? gaussianSampler(image, scale, sigmaScale) : image;
  const { angles, modgrad, order } = llAngle(source, rho, nBins);
  const xsize = angles.xsize;
  const ysize = angles.ysize;

  const logNT = (5.0 * (Math.log10(xsize) + Math.log10(ysize))) / 2.0 + Math.log10(11.0);
  const minRegSize = Math.trunc(-logNT / Math.log10(p));

  const used = new Uint8Array(xsize * ysize);
  const reg: Region = { x: new Int32Array(xsize * ysize), y: new Int32Array(xsize * ysize), size: 0, angle: 0 };
  const rec = newRect();
  const out: LsdSegment[] = [];

  for (let k = 0; k < order.length; k++) {
    const adr = order[k];
    if (used[adr] !== NOTUSED || angles.data[adr] === NOTDEF) continue;
    const x = adr % xsize;
    const y = (adr - x) / xsize;

    regionGrow(x, y, angles, reg, used, prec);
    if (reg.size < minRegSize) continue;

    region2rect(reg, modgrad, reg.angle, prec, p, rec);
    if (!refine(reg, modgrad, reg.angle, prec, p, rec, used, angles, densityTh)) continue;

    const logNfa = rectImprove(rec, angles, logNT, logEps);
    if (logNfa <= logEps) continue;

    // 2x2 の勾配マスクによる半画素のずれを戻し、縮小を元に戻す
    let x1 = rec.x1 + 0.5;
    let y1 = rec.y1 + 0.5;
    let x2 = rec.x2 + 0.5;
    let y2 = rec.y2 + 0.5;
    let w = rec.width;
    if (scale !== 1.0) {
      x1 /= scale;
      y1 /= scale;
      x2 /= scale;
      y2 /= scale;
      w /= scale;
    }
    out.push({ x1, y1, x2, y2, width: w, p: rec.p, logNfa });
  }
  return out;
}
