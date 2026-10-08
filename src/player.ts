import { drawFrame, type Scene } from './timeline.ts';

/**
 * プレビュー再生。音声（AudioContext）の再生位置を時計にして毎フレーム描く。
 * 棒虫の動画区間だけは <video> を再生し、ずれが大きくなったら位置を合わせ直す。
 */
export class Player {
  private audioCtx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private raf = 0;
  private startedAt = 0;
  onEnd: () => void = () => {};
  onTime: (t: number) => void = () => {};

  private ctx: CanvasRenderingContext2D;
  private video: HTMLVideoElement;

  constructor(ctx: CanvasRenderingContext2D, video: HTMLVideoElement) {
    this.ctx = ctx;
    this.video = video;
  }

  get playing(): boolean {
    return this.source !== null;
  }

  async play(scene: Scene, soundtrack: AudioBuffer): Promise<void> {
    this.stop();
    this.audioCtx ??= new AudioContext({ sampleRate: soundtrack.sampleRate });
    await this.audioCtx.resume();
    const src = this.audioCtx.createBufferSource();
    src.buffer = soundtrack;
    src.connect(this.audioCtx.destination);
    // 出力の遅延分だけ映像を遅らせて、音と絵を揃える
    const latency = this.audioCtx.outputLatency || this.audioCtx.baseLatency || 0;
    this.startedAt = this.audioCtx.currentTime + 0.05 + latency;
    src.start(this.audioCtx.currentTime + 0.05);
    this.source = src;

    const tl = scene.timeline;
    const video = this.video;
    video.pause();
    video.currentTime = 0;

    const tick = () => {
      if (!this.audioCtx || !this.source) return;
      const t = Math.max(0, this.audioCtx.currentTime - this.startedAt);
      if (t >= tl.duration) {
        this.stop();
        this.onEnd();
        return;
      }
      if (t >= tl.tailStart) {
        const vt = t - tl.tailStart;
        if (video.paused) {
          video.currentTime = vt;
          void video.play();
        } else if (Math.abs(video.currentTime - vt) > 0.15) {
          video.currentTime = vt;
        }
      }
      drawFrame(this.ctx, scene, t, t >= tl.tailStart ? video : null);
      this.onTime(t);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        /* 既に止まっている */
      }
      this.source.disconnect();
      this.source = null;
    }
    this.video.pause();
  }
}
