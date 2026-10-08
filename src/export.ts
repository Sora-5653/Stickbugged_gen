import {
  ALL_FORMATS,
  AudioBufferSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  UrlSource,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
  type AudioCodec,
  type VideoCodec,
} from 'mediabunny';
import { STICK_BUG_URL } from './audio.ts';
import { FPS, drawFrame, type Scene } from './timeline.ts';

export type ExportFormat = 'mp4' | 'webm';

export interface ExportResult {
  blob: Blob;
  videoCodec: VideoCodec;
  audioCodec: AudioCodec;
}

async function pickCodecs(format: ExportFormat, width: number, height: number): Promise<{ video: VideoCodec; audio: AudioCodec }> {
  const videoCandidates: VideoCodec[] = format === 'mp4' ? ['avc', 'hevc', 'av1'] : ['vp9', 'vp8', 'av1'];
  const audioCandidates: AudioCodec[] = format === 'mp4' ? ['aac', 'opus'] : ['opus'];
  let video: VideoCodec | null = null;
  for (const c of videoCandidates) {
    if (await canEncodeVideo(c, { width, height })) {
      video = c;
      break;
    }
  }
  let audio: AudioCodec | null = null;
  for (const c of audioCandidates) {
    if (await canEncodeAudio(c, { numberOfChannels: 2, sampleRate: 48000 })) {
      audio = c;
      break;
    }
  }
  if (!video || !audio) throw new Error(`このブラウザは ${format.toUpperCase()} の書き出しに対応していません（WebCodecs のエンコーダーが見つかりません）`);
  return { video, audio };
}

/**
 * フレームを1枚ずつ描いてエンコードする（実時間の録画ではない）。
 * 棒虫の動画区間は stick_bug.mp4 をデコードしながら順に描く。
 */
export async function exportVideo(
  format: ExportFormat,
  scene: Scene,
  soundtrack: AudioBuffer,
  onProgress: (ratio: number) => void,
  signal?: AbortSignal,
): Promise<ExportResult> {
  const { width, height, timeline: tl } = scene;
  const codecs = await pickCodecs(format, width, height);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const output = new Output({
    format: format === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
    target: new BufferTarget(),
  });
  const videoSource = new CanvasSource(canvas, { codec: codecs.video, bitrate: QUALITY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(videoSource, { frameRate: FPS });
  const audioSource = new AudioBufferSource({ codec: codecs.audio, bitrate: QUALITY_HIGH });
  output.addAudioTrack(audioSource);
  await output.start();

  const input = new Input({ source: new UrlSource(STICK_BUG_URL), formats: ALL_FORMATS });
  try {
    await audioSource.add(soundtrack);

    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error('stick_bug.mp4 に映像がありません');
    const sink = new CanvasSink(videoTrack, { poolSize: 2 });

    const totalFrames = Math.round(tl.duration * FPS);
    const firstTailFrame = Math.ceil(tl.tailStart * FPS - 1e-6);
    const tailTimes = function* () {
      for (let i = firstTailFrame; i < totalFrames; i++) yield i / FPS - tl.tailStart;
    };
    const tailFrames = sink.canvasesAtTimestamps(tailTimes());

    let lastTail: CanvasImageSource | null = null;
    for (let i = 0; i < totalFrames; i++) {
      if (signal?.aborted) throw new DOMException('中止しました', 'AbortError');
      const t = i / FPS;
      if (i >= firstTailFrame) {
        const next = await tailFrames.next();
        if (!next.done && next.value) lastTail = next.value.canvas;
      }
      drawFrame(ctx, scene, i >= firstTailFrame ? Math.max(t, tl.tailStart) : t, lastTail);
      await videoSource.add(t, 1 / FPS);
      if (i % 5 === 0) onProgress(i / totalFrames);
    }
    await tailFrames.return(undefined);

    videoSource.close();
    audioSource.close();
    await output.finalize();
    onProgress(1);
  } catch (e) {
    await output.cancel();
    throw e;
  } finally {
    input.dispose();
  }

  const buffer = output.target.buffer!;
  return {
    blob: new Blob([buffer], { type: format === 'mp4' ? 'video/mp4' : 'video/webm' }),
    videoCodec: codecs.video,
    audioCodec: codecs.audio,
  };
}
