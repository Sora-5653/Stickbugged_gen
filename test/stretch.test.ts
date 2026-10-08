import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitLength, splice, wsola, type FitMode } from '../src/stretch.ts';

const SR = 48000;

function sine(freq: number, seconds: number, channels = 2): Float32Array[] {
  const len = Math.round(SR * seconds);
  return Array.from({ length: channels }, () => {
    const c = new Float32Array(len);
    for (let i = 0; i < len; i++) c[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / SR);
    return c;
  });
}

/** 端を除いた区間のゼロ交差から周波数を推定する */
function estimateFreq(x: Float32Array): number {
  const a = Math.floor(x.length * 0.1);
  const b = Math.floor(x.length * 0.9);
  let crossings = 0;
  for (let i = a + 1; i < b; i++) if (x[i - 1] < 0 && x[i] >= 0) crossings++;
  return crossings / ((b - a) / SR);
}

function rms(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / (to - from));
}

for (const ratio of [0.5, 0.75, 1.5, 2.5]) {
  test(`wsola x${ratio}: 長さが変わり、ピッチと音量は保たれる`, () => {
    const input = sine(440, 1.733);
    const out = wsola(input, ratio, SR);
    assert.equal(out.length, 2);
    assert.equal(out[0].length, Math.round(input[0].length * ratio));
    assert.ok(Math.abs(estimateFreq(out[0]) - 440) < 5, `freq ${estimateFreq(out[0])}`);
    const r = rms(out[0], 4096, out[0].length - 4096);
    assert.ok(Math.abs(r - rms(input[0])) < 0.03, `rms ${r}`);
  });
}

test('splice: 正のジャンプで中抜き、負のジャンプで繰り返し', () => {
  const input = sine(440, 1);
  const cut = splice(input, 24000, 12000, SR);
  assert.equal(cut[0].length, 36000);
  const rep = splice(input, 24000, -12000, SR);
  assert.equal(rep[0].length, 60000);
  // つなぎ目でも音量が大きく落ちない（等パワーかつ位相合わせ済み）
  assert.ok(rms(cut[0], 23000, 25000) > 0.3);
  assert.ok(rms(rep[0], 23000, 25000) > 0.3);
});

for (const mode of ['auto', 'stretch', 'cut'] as FitMode[]) {
  for (const seconds of [0.3, 1.0, 1.733, 3.0, 6.0]) {
    test(`fitLength ${mode} → ${seconds}s: ちょうどの長さでピッチ維持`, () => {
      const input = sine(440, 1.733);
      const target = Math.round(SR * seconds);
      const out = fitLength(input, target, SR, mode);
      assert.equal(out[0].length, target);
      assert.ok(Math.abs(estimateFreq(out[0]) - 440) < 8, `freq ${estimateFreq(out[0])}`);
    });
  }
}

test('既定の長さなら入力と完全に同じ', () => {
  const input = sine(440, 1.733);
  const out = fitLength(input, input[0].length, SR, 'auto');
  assert.deepEqual(out[0], input[0]);
});

test('6秒への伸長が実用的な時間で終わる', () => {
  const input = sine(440, 1.733);
  const t0 = performance.now();
  fitLength(input, SR * 6, SR, 'stretch');
  const ms = performance.now() - t0;
  console.log(`  stretch 1.733s -> 6s: ${ms.toFixed(0)} ms`);
  assert.ok(ms < 3000);
});
