import { fitLength, type FitMode } from './stretch.ts';
import { DEFAULT_TRANSFORM_SECONDS, FPS, LINE_SECONDS, SEGMENT_COUNT, type Timeline } from './timeline.ts';

export const SAMPLE_RATE = 48000;

const MEDIA_BASE = `${import.meta.env.BASE_URL}media/`;
export const STICK_BUG_URL = `${MEDIA_BASE}stick_bug.mp4`;

export interface Assets {
  notes: AudioBuffer[]; // note0〜note9
  transform: AudioBuffer;
  tailAudio: AudioBuffer;
  tailVideo: HTMLVideoElement;
  tailSeconds: number;
  videoWidth: number;
  videoHeight: number;
}

async function decode(url: string): Promise<AudioBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} を読み込めませんでした (${res.status})`);
  // 出力と同じ 48kHz に変換して読み込む
  const ctx = new OfflineAudioContext(2, 1, SAMPLE_RATE);
  return ctx.decodeAudioData(await res.arrayBuffer());
}

function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = url;
    v.onloadeddata = () => resolve(v);
    v.onerror = () => reject(new Error(`${url} を読み込めませんでした`));
  });
}

export async function loadAssets(): Promise<Assets> {
  const [notes, transform, tailAudio, tailVideo] = await Promise.all([
    Promise.all(Array.from({ length: 10 }, (_, i) => decode(`${MEDIA_BASE}note${i}.wav`))),
    decode(`${MEDIA_BASE}transform.wav`),
    decode(STICK_BUG_URL),
    loadVideo(STICK_BUG_URL),
  ]);
  return {
    notes,
    transform,
    tailAudio,
    tailVideo,
    tailSeconds: tailVideo.duration,
    videoWidth: tailVideo.videoWidth,
    videoHeight: tailVideo.videoHeight,
  };
}

function channelsOf(buf: AudioBuffer, from: number, to: number): Float32Array[] {
  return Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c).slice(from, to));
}

const fittedCache = new Map<string, AudioBuffer>();

/**
 * 変形区間の音。gsbl が使っている transform.wav の先頭 52 フレーム分を基準の長さとし、
 * それを変形の長さに合わせて伸縮する（ピッチは保つ）。
 */
export function fittedTransform(assets: Assets, frames: number, mode: FitMode): AudioBuffer {
  const key = `${frames}|${mode}`;
  const hit = fittedCache.get(key);
  if (hit) return hit;

  const baseLen = Math.round(DEFAULT_TRANSFORM_SECONDS * SAMPLE_RATE);
  const targetLen = Math.round((frames / FPS) * SAMPLE_RATE);
  const fitted = fitLength(channelsOf(assets.transform, 0, baseLen), targetLen, SAMPLE_RATE, mode);
  const buf = new AudioBuffer({ length: targetLen, numberOfChannels: fitted.length, sampleRate: SAMPLE_RATE });
  fitted.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  fittedCache.set(key, buf);
  return buf;
}

/** タイムラインどおりに効果音と曲を並べ、1本の音声にする */
export async function buildSoundtrack(assets: Assets, tl: Timeline, mode: FitMode): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.ceil(tl.duration * SAMPLE_RATE), SAMPLE_RATE);
  const play = (buf: AudioBuffer, when: number, duration?: number) => {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(when, 0, duration);
  };

  // 線が1本出るたびに音を1つ（gsbl と同じく 0.33 秒で切る）
  for (let i = 0; i < SEGMENT_COUNT; i++) play(assets.notes[i], tl.linesStart + i * LINE_SECONDS, LINE_SECONDS);
  play(assets.notes[9], tl.bgStart);
  play(fittedTransform(assets, tl.transformFrames, mode), tl.transformStart);
  play(assets.tailAudio, tl.tailStart);

  return ctx.startRendering();
}
