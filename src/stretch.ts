/*
 * 音声の長さをピッチを変えずに合わせる処理。
 *
 * - wsola:   WSOLA（波形の類似度で位置を合わせて重ね合わせる）による伸縮
 * - splice:  ある位置で前後をつなぎ替える。正のジャンプで中抜き、負のジャンプで区間の繰り返し
 * - fitLength: モードに応じて上の2つを組み合わせ、指定サンプル数ちょうどにする
 *
 * どれも DOM に依存しない純粋な関数なので、Node のテストからも呼べる。
 */

export type Channels = Float32Array[];

/** 音声の合わせ方 */
export type FitMode = 'auto' | 'stretch' | 'cut';

/** auto モードで WSOLA だけで縮める下限の比率。これより短くする分は中抜きで補う */
export const AUTO_MIN_STRETCH_RATIO = 0.6;

function mixToMono(ch: Channels): Float32Array {
  const len = ch[0].length;
  const mono = new Float32Array(len);
  for (const c of ch) for (let i = 0; i < len; i++) mono[i] += c[i] / ch.length;
  return mono;
}

/** 2のべき乗で、だいたい ms ミリ秒になるサンプル数 */
function pow2Samples(sampleRate: number, ms: number): number {
  return 2 ** Math.round(Math.log2((sampleRate * ms) / 1000));
}

/**
 * WSOLA で長さを ratio 倍にする（ratio > 1 で伸ばす）。
 * 出力の長さは round(入力の長さ × ratio)。
 */
export function wsola(input: Channels, ratio: number, sampleRate: number): Channels {
  const inLen = input[0].length;
  const outLen = Math.max(1, Math.round(inLen * ratio));
  if (Math.abs(ratio - 1) < 1e-9) return input.map((c) => c.slice());

  const N = pow2Samples(sampleRate, 46); // フレーム長（44.1k/48k で 2048）
  const Hs = N / 2; // 出力側のホップ
  const Ha = Hs / ratio; // 入力側の名目ホップ
  const tol = pow2Samples(sampleRate, 11); // 位置合わせの探索幅 ±（512）
  const corrLen = N / 2; // 類似度を測る長さ

  // 窓は周期的ハン窓（Hs = N/2 で重ねると和がほぼ一定になる）
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

  const mono = mixToMono(input);
  const at = (buf: Float32Array, i: number) => (i >= 0 && i < buf.length ? buf[i] : 0);

  const out = input.map(() => new Float32Array(outLen + N));
  const wsum = new Float32Array(outLen + N);

  let prevPos = 0;
  for (let k = 0; k * Hs < outLen; k++) {
    const nominal = Math.round(k * Ha);
    let pos = nominal;
    if (k > 0) {
      // 直前に置いたフレームの「自然な続き」に最も似た位置を、名目位置の周辺から探す
      const natural = prevPos + Hs;
      const score = (cand: number) => {
        let dot = 0;
        let energy = 1e-9;
        for (let i = 0; i < corrLen; i++) {
          const c = at(mono, cand + i);
          dot += at(mono, natural + i) * c;
          energy += c * c;
        }
        return dot / Math.sqrt(energy);
      };
      // 粗く探してから細かく詰める
      let best = nominal;
      let bestScore = -Infinity;
      for (let d = -tol; d <= tol; d += 8) {
        const s = score(nominal + d);
        if (s > bestScore) {
          bestScore = s;
          best = nominal + d;
        }
      }
      const coarse = best;
      for (let d = -7; d <= 7; d++) {
        const s = score(coarse + d);
        if (s > bestScore) {
          bestScore = s;
          best = coarse + d;
        }
      }
      pos = best;
    }

    const o = k * Hs;
    for (let c = 0; c < input.length; c++) {
      const src = input[c];
      const dst = out[c];
      for (let i = 0; i < N; i++) dst[o + i] += at(src, pos + i) * win[i];
    }
    for (let i = 0; i < N; i++) wsum[o + i] += win[i];
    prevPos = pos;
  }

  // 窓の重なりで正規化する。先頭の半フレームは窓1枚だけなので、割ると元の値に戻る
  return out.map((buf) => {
    const res = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) res[i] = buf[i] / Math.max(wsum[i], 1e-3);
    return res;
  });
}

/**
 * 位置 cut でつなぎ替える。出力は out[n] = n < cut ? in[n] : in[n + jump]、長さは inLen - jump。
 * jump > 0 で中抜き、jump < 0 で直前の区間の繰り返しになる。
 * つなぎ目は前後 xfade サンプルを等パワーでクロスフェードし、
 * cut は searchRadius の範囲で波形が最も揃う位置に動かす。
 */
export function splice(input: Channels, cutCenter: number, jump: number, sampleRate: number): Channels {
  const inLen = input[0].length;
  const outLen = inLen - jump;
  const xfade = Math.max(2, Math.min(Math.round(sampleRate * 0.03), Math.floor(Math.min(outLen, inLen) / 4)));
  const half = xfade >> 1;
  const searchRadius = Math.round(sampleRate * 0.01);
  const mono = mixToMono(input);

  // cut の候補は、クロスフェード区間が入力の範囲内に収まるものだけ
  const lo = Math.max(half, half - jump);
  const hi = Math.min(inLen - half, inLen - half - jump);
  const clamp = (v: number) => Math.min(Math.max(v, lo), hi);

  let cut = clamp(cutCenter);
  let bestScore = -Infinity;
  for (let c = clamp(cutCenter - searchRadius); c <= clamp(cutCenter + searchRadius); c++) {
    let dot = 0;
    let e = 1e-9;
    for (let i = -half; i < half; i++) {
      const a = mono[c + i];
      const b = mono[c + i + jump];
      dot += a * b;
      e += b * b;
    }
    const s = dot / Math.sqrt(e);
    if (s > bestScore) {
      bestScore = s;
      cut = c;
    }
  }

  return input.map((src) => {
    const res = new Float32Array(outLen);
    for (let n = 0; n < outLen; n++) {
      if (n < cut - half) res[n] = src[n];
      else if (n >= cut + half) res[n] = src[n + jump];
      else {
        const t = (n - (cut - half) + 0.5) / xfade;
        res[n] = src[n] * Math.cos((t * Math.PI) / 2) + src[n + jump] * Math.sin((t * Math.PI) / 2);
      }
    }
    return res;
  });
}

/** 中抜き・区間の繰り返しだけで長さを targetLen に合わせる（真ん中でつなぎ替える） */
export function cutToLength(input: Channels, targetLen: number, sampleRate: number): Channels {
  let cur = input;
  // 繰り返しは1回あたり現在の長さの4割までにして、足りなければ何度か繰り返す
  for (let guard = 0; guard < 64 && cur[0].length !== targetLen; guard++) {
    const len = cur[0].length;
    let jump = len - targetLen;
    if (jump < 0) jump = Math.max(jump, -Math.floor(len * 0.4));
    const outLen = len - jump;
    cur = splice(cur, Math.round(outLen / 2), jump, sampleRate);
  }
  return cur;
}

/** 指定サンプル数ちょうどに切りそろえる（WSOLA の丸め誤差の吸収用） */
function exactLength(input: Channels, targetLen: number): Channels {
  return input.map((c) => {
    if (c.length === targetLen) return c;
    const res = new Float32Array(targetLen);
    res.set(c.subarray(0, Math.min(targetLen, c.length)));
    return res;
  });
}

/**
 * 音声 input を、ピッチを保ったまま targetLen サンプルにする。
 * - stretch: WSOLA だけで伸縮する
 * - cut:     中抜き（短くする）／真ん中の繰り返し（長くする）だけで合わせる
 * - auto:    WSOLA で伸縮し、比率が AUTO_MIN_STRETCH_RATIO を下回る分だけ中抜きで縮める
 */
export function fitLength(input: Channels, targetLen: number, sampleRate: number, mode: FitMode): Channels {
  const inLen = input[0].length;
  if (targetLen === inLen) return input.map((c) => c.slice());
  const ratio = targetLen / inLen;

  if (mode === 'stretch') return exactLength(wsola(input, ratio, sampleRate), targetLen);
  if (mode === 'cut') return cutToLength(input, targetLen, sampleRate);

  if (ratio >= AUTO_MIN_STRETCH_RATIO) return exactLength(wsola(input, ratio, sampleRate), targetLen);
  const stretched = wsola(input, AUTO_MIN_STRETCH_RATIO, sampleRate);
  return cutToLength(stretched, targetLen, sampleRate);
}
