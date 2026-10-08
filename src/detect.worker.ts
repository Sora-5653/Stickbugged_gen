/// <reference lib="webworker" />
import { lsd, type LsdOptions, type LsdSegment } from './lsd.ts';
import { edgeContrast } from './select.ts';

export interface DetectRequest {
  id: number;
  gray: Float32Array;
  width: number;
  height: number;
  options: LsdOptions;
}

export interface DetectResponse {
  id: number;
  segments?: LsdSegment[];
  /** segments と同じ順の、輪郭の強さ（両側の明るさの差の平均） */
  contrast?: number[];
  error?: string;
  ms: number;
}

self.onmessage = (ev: MessageEvent<DetectRequest>) => {
  const { id, gray, width, height, options } = ev.data;
  const t0 = performance.now();
  try {
    const segments = lsd(gray, width, height, options);
    const contrast = segments.map((s) => edgeContrast(gray, width, height, s.x1, s.y1, s.x2, s.y2, s.width));
    (self as DedicatedWorkerGlobalScope).postMessage({ id, segments, contrast, ms: performance.now() - t0 } satisfies DetectResponse);
  } catch (e) {
    (self as DedicatedWorkerGlobalScope).postMessage({ id, error: String(e), ms: performance.now() - t0 } satisfies DetectResponse);
  }
};
