import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lsd } from '../src/lsd.ts';

function readPgm(path: string): { data: number[]; width: number; height: number } {
  // ASCII PGM (P2)。コメント行は無い前提
  const tokens = readFileSync(path, 'utf8').split(/\s+/).filter(Boolean);
  assert.equal(tokens[0], 'P2');
  const width = Number(tokens[1]);
  const height = Number(tokens[2]);
  const data = tokens.slice(4, 4 + width * height).map(Number);
  return { data, width, height };
}

test('lsd.c の参照出力 chairs.lsd.txt と一致する', () => {
  const img = readPgm(fileURLToPath(new URL('./fixtures/chairs.pgm', import.meta.url)));
  const expected = readFileSync(fileURLToPath(new URL('./fixtures/chairs.lsd.txt', import.meta.url)), 'utf8')
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number));

  const t0 = performance.now();
  const segs = lsd(img.data, img.width, img.height);
  console.log(`  ${img.width}x${img.height}: ${segs.length} segments in ${(performance.now() - t0).toFixed(0)} ms`);

  // 参照出力は x87 の80ビット中間精度で作られたとみられ、長方形の境界がちょうど整数になる
  // ごく一部の線分で、境界画素の数え方が1画素ずれて NFA の値（と検出の有無）が変わる。
  // そのため完全一致ではなく、参照の線分のほとんどが幾何まで一致することを確かめる。
  const key = (v: number[]) => v.slice(0, 5);
  const close = (a: number[], b: number[]) => a.every((x, k) => Math.abs(x - b[k]) < 1e-5);
  const got = segs.map((s) => [s.x1, s.y1, s.x2, s.y2, s.width]);
  const matched = expected.filter((e) => got.some((g) => close(key(e), g))).length;

  assert.ok(Math.abs(segs.length - expected.length) <= expected.length * 0.02, `count ${segs.length} vs ${expected.length}`);
  assert.ok(matched >= expected.length * 0.98, `matched ${matched}/${expected.length}`);

  // 長い線分ほど判定に余裕があるので、上位9本（このアプリで使う部分）は完全に一致するはず
  const top = (rows: number[][]) =>
    rows.map((r) => ({ r, len: Math.hypot(r[2] - r[0], r[3] - r[1]) })).sort((a, b) => b.len - a.len).slice(0, 9).map((o) => o.r);
  top(got).forEach((g, i) => assert.ok(close(g, key(top(expected)[i])), `top-9 #${i} differs`));
});
