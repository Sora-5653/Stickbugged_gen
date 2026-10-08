import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgeContrast, selectSegments, type Candidate } from '../src/select.ts';

const cand = (length: number, mx: number, my: number, contrast: number): Candidate => ({ length, mx, my, contrast });

test('edgeContrast: 明暗の境界に沿う線は高く、平らな所は 0', () => {
  const w = 40;
  const h = 40;
  const gray = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) gray[y * w + x] = x < 20 ? 0 : 200;
  // x = 19.5 の縦の境界に沿う線
  assert.ok(edgeContrast(gray, w, h, 19.5, 5, 19.5, 35, 1) > 190);
  // 明るい側の中を通る線
  assert.equal(edgeContrast(gray, w, h, 30, 5, 30, 35, 1), 0);
});

test('両方 0 なら長い順（gsbl と同じ）', () => {
  const cs = [cand(10, 0, 0, 50), cand(30, 0, 0, 1), cand(20, 0, 0, 100)];
  assert.deepEqual(selectSegments(cs, { minSpacing: 0, contrastWeight: 0 }, 3), [1, 2, 0]);
});

test('コントラストを重視すると、短くても鮮明な線が先に来る', () => {
  const cs = [cand(30, 0, 0, 10), cand(20, 100, 0, 100)];
  assert.deepEqual(selectSegments(cs, { minSpacing: 0, contrastWeight: 1 }, 2), [1, 0]);
});

test('中点が近すぎる線は後回しにする', () => {
  const cs = [cand(100, 0, 0, 100), cand(90, 5, 0, 100), cand(50, 200, 0, 100)];
  assert.deepEqual(selectSegments(cs, { minSpacing: 40, contrastWeight: 0 }, 2), [0, 2]);
});

test('間隔が厳しすぎて足りないときは緩めて必ず埋める', () => {
  const cs = Array.from({ length: 12 }, (_, i) => cand(100 - i, i * 3, 0, 100));
  const picked = selectSegments(cs, { minSpacing: 500, contrastWeight: 1 }, 9);
  assert.equal(picked.length, 9);
  assert.equal(new Set(picked).size, 9);
});

test('候補が9本未満なら全部返す', () => {
  const cs = [cand(10, 0, 0, 1), cand(20, 0, 0, 1)];
  assert.equal(selectSegments(cs, { minSpacing: 100, contrastWeight: 1 }, 9).length, 2);
});
