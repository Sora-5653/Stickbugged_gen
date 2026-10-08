import { SEGMENT_COUNT, segmentLength, type Placement, type RGB, type Segment } from './timeline.ts';

/** 編集画面に必要な表示情報（main から渡す） */
export interface EditorView {
  image: ImageBitmap;
  placement: Placement;
  width: number;
  height: number;
  imgBgColor: RGB;
  lineColor: RGB;
}

type Drag =
  | { kind: 'endpoint'; index: number; end: 0 | 1 }
  | { kind: 'draw'; start: [number, number]; end: [number, number] }
  | null;

const css = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;

function distToSegment(px: number, py: number, s: Segment): number {
  const [x1, y1, x2, y2] = s;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * 9本の線分を編集する。座標はすべて画像の元の画素座標で持ち、描画時に出力キャンバスへ写す。
 * 操作:
 *  - 端点のドラッグで移動
 *  - 採用中の線をクリックで選択
 *  - 候補の線をクリック: 選択中の線をその候補に差し替え（未選択なら空きに追加）
 *  - 描画モード: ドラッグで新しい線を引く
 */
export class SegmentEditor {
  candidates: Segment[] = [];
  chosen: Segment[] = [];
  selected: number | null = null;
  drawMode = false;
  showCandidates = true;
  /** 再生中・書き出し中は操作を受け付けない */
  locked = false;
  onChange: () => void = () => {};
  onMessage: (msg: string) => void = () => {};

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private view: EditorView | null = null;
  private drag: Drag = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', () => {
      this.drag = null;
      this.render();
    });
  }

  setView(view: EditorView | null): void {
    this.view = view;
    this.render();
  }

  /** 9本をまとめて置き換える（自動選択の結果を入れる） */
  setChosen(segs: Segment[]): void {
    this.chosen = segs.slice(0, SEGMENT_COUNT).map((s) => [...s] as Segment);
    this.selected = null;
    this.changed();
  }

  move(index: number, delta: -1 | 1): void {
    const j = index + delta;
    if (j < 0 || j >= this.chosen.length) return;
    [this.chosen[index], this.chosen[j]] = [this.chosen[j], this.chosen[index]];
    if (this.selected === index) this.selected = j;
    this.changed();
  }

  remove(index: number): void {
    this.chosen.splice(index, 1);
    this.selected = null;
    this.changed();
  }

  select(index: number | null): void {
    this.selected = index;
    this.changed();
  }

  private changed(): void {
    this.render();
    this.onChange();
  }

  // --- 座標変換 ---

  private get scale(): number {
    return this.view ? this.view.placement.w / this.view.image.width : 1;
  }

  /** 画像座標 → キャンバス座標 */
  toCanvas(s: Segment): Segment {
    const p = this.view!.placement;
    const k = this.scale;
    return [s[0] * k + p.x, s[1] * k + p.y, s[2] * k + p.x, s[3] * k + p.y, s[4] * k];
  }

  private toImage(x: number, y: number): [number, number] {
    const p = this.view!.placement;
    const k = this.scale;
    return [(x - p.x) / k, (y - p.y) / k];
  }

  private pointer(e: PointerEvent): { x: number; y: number; px: number } {
    const r = this.canvas.getBoundingClientRect();
    const px = this.canvas.width / r.width; // 画面1px あたりのキャンバス px
    return { x: (e.clientX - r.left) * px, y: (e.clientY - r.top) * px, px };
  }

  // --- 操作 ---

  private onDown(e: PointerEvent): void {
    if (!this.view || this.locked) return;
    const { x, y, px } = this.pointer(e);
    this.canvas.setPointerCapture(e.pointerId);

    if (this.drawMode) {
      const p = this.toImage(x, y);
      this.drag = { kind: 'draw', start: p, end: p };
      return;
    }

    // 端点（選択中の線を優先）
    const order = this.chosen.map((_, i) => i).sort((a, b) => (a === this.selected ? -1 : b === this.selected ? 1 : 0));
    for (const i of order) {
      const c = this.toCanvas(this.chosen[i]);
      for (const end of [0, 1] as const) {
        if (Math.hypot(x - c[end * 2], y - c[end * 2 + 1]) < 12 * px) {
          this.selected = i;
          this.drag = { kind: 'endpoint', index: i, end };
          this.render();
          return;
        }
      }
    }

    // 採用中の線
    for (let i = 0; i < this.chosen.length; i++) {
      if (distToSegment(x, y, this.toCanvas(this.chosen[i])) < 8 * px) {
        this.select(this.selected === i ? null : i);
        return;
      }
    }

    // 候補の線
    if (this.showCandidates) {
      let best = -1;
      let bestD = 8 * px;
      this.candidates.forEach((s, i) => {
        const d = distToSegment(x, y, this.toCanvas(s));
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      if (best >= 0) {
        this.place([...this.candidates[best]] as Segment);
        return;
      }
    }

    this.select(null);
  }

  private onMove(e: PointerEvent): void {
    if (!this.drag || !this.view) return;
    const { x, y } = this.pointer(e);
    const p = this.toImage(x, y);
    if (this.drag.kind === 'endpoint') {
      const s = this.chosen[this.drag.index];
      s[this.drag.end * 2] = p[0];
      s[this.drag.end * 2 + 1] = p[1];
    } else {
      this.drag.end = p;
    }
    this.render();
  }

  private onUp(e: PointerEvent): void {
    if (!this.drag) return;
    const drag = this.drag;
    this.drag = null;
    if (drag.kind === 'draw') {
      const s: Segment = [drag.start[0], drag.start[1], drag.end[0], drag.end[1], 3 / this.scale];
      if (segmentLength(s) * this.scale >= 5) this.place(s);
      else this.render();
    } else {
      this.changed();
    }
    this.canvas.releasePointerCapture(e.pointerId);
  }

  /** 選択中の線を置き換える。未選択なら空きに追加する */
  private place(s: Segment): void {
    if (this.selected !== null) {
      this.chosen[this.selected] = s;
    } else if (this.chosen.length < SEGMENT_COUNT) {
      this.chosen.push(s);
      this.selected = this.chosen.length - 1;
    } else {
      this.onMessage('9本そろっています。置き換える線を先に選んでください');
      return;
    }
    this.changed();
  }

  // --- 描画 ---

  render(): void {
    const ctx = this.ctx;
    const v = this.view;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!v) return;
    const p = v.placement;
    ctx.fillStyle = css(v.imgBgColor);
    ctx.fillRect(0, 0, v.width, v.height);
    ctx.drawImage(v.image, p.x, p.y, p.w, p.h);
    ctx.lineCap = 'round';
    const px = this.canvas.width / Math.max(1, this.canvas.getBoundingClientRect().width);

    if (this.showCandidates) {
      ctx.strokeStyle = 'rgba(0, 200, 255, 0.55)';
      ctx.lineWidth = 1.5 * px;
      for (const s of this.candidates) {
        const c = this.toCanvas(s);
        ctx.beginPath();
        ctx.moveTo(c[0], c[1]);
        ctx.lineTo(c[2], c[3]);
        ctx.stroke();
      }
    }

    this.chosen.forEach((s, i) => {
      const c = this.toCanvas(s);
      const sel = i === this.selected;
      if (sel) {
        ctx.strokeStyle = 'rgba(255, 60, 120, 0.9)';
        ctx.lineWidth = Math.max(1, c[4]) + 6 * px;
        ctx.beginPath();
        ctx.moveTo(c[0], c[1]);
        ctx.lineTo(c[2], c[3]);
        ctx.stroke();
      }
      ctx.strokeStyle = css(v.lineColor);
      ctx.lineWidth = Math.max(1, c[4]);
      ctx.beginPath();
      ctx.moveTo(c[0], c[1]);
      ctx.lineTo(c[2], c[3]);
      ctx.stroke();

      // 端点のつまみ
      for (const end of [0, 1]) {
        ctx.fillStyle = sel ? 'rgb(255, 60, 120)' : 'rgba(255,255,255,0.9)';
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 1.5 * px;
        ctx.beginPath();
        ctx.arc(c[end * 2], c[end * 2 + 1], 5 * px, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      // 番号
      const mx = (c[0] + c[2]) / 2;
      const my = (c[1] + c[3]) / 2;
      ctx.font = `bold ${13 * px}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = sel ? 'rgb(255, 60, 120)' : 'rgba(0,0,0,0.75)';
      ctx.beginPath();
      ctx.arc(mx, my, 10 * px, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(String(i + 1), mx, my + 0.5 * px);
    });

    if (this.drag?.kind === 'draw') {
      const s = this.toCanvas([...this.drag.start, ...this.drag.end, 3 / this.scale] as Segment);
      ctx.strokeStyle = 'rgb(255, 60, 120)';
      ctx.lineWidth = 3 * px;
      ctx.setLineDash([8 * px, 6 * px]);
      ctx.beginPath();
      ctx.moveTo(s[0], s[1]);
      ctx.lineTo(s[2], s[3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}
