import { buildSoundtrack, loadAssets, type Assets } from './audio.ts';
import { DEFAULT_DETECT_PARAMS, detectSegments, type DetectParams } from './detect.ts';
import { SegmentEditor } from './editor.ts';
import { exportVideo, type ExportFormat } from './export.ts';
import { Player } from './player.ts';
import { DEFAULT_SELECT_PARAMS, selectSegments, type SelectParams } from './select.ts';
import { AUTO_MIN_STRETCH_RATIO, type FitMode } from './stretch.ts';
import {
  DEFAULT_TRANSFORM_FRAMES,
  FPS,
  SEGMENT_COUNT,
  fitContain,
  makeTimeline,
  segmentLength,
  stickBugTargets,
  type Easing,
  type RGB,
  type Scene,
} from './timeline.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  stage: $<HTMLCanvasElement>('stage'),
  dropZone: $('dropZone'),
  placeholder: $('placeholder'),
  fileInput: $<HTMLInputElement>('fileInput'),
  timeLabel: $('timeLabel'),
  hint: $('hint'),
  scale: $<HTMLInputElement>('scale'),
  scaleVal: $('scaleVal'),
  minLen: $<HTMLInputElement>('minLen'),
  minLenVal: $('minLenVal'),
  spacing: $<HTMLInputElement>('spacing'),
  spacingVal: $('spacingVal'),
  contrastW: $<HTMLInputElement>('contrastW'),
  contrastWVal: $('contrastWVal'),
  showCandidates: $<HTMLInputElement>('showCandidates'),
  drawBtn: $<HTMLButtonElement>('drawBtn'),
  resetBtn: $<HTMLButtonElement>('resetBtn'),
  segList: $<HTMLOListElement>('segList'),
  tfFrames: $<HTMLInputElement>('tfFrames'),
  tfVal: $('tfVal'),
  tfSeconds: $<HTMLInputElement>('tfSeconds'),
  tfDefault: $<HTMLButtonElement>('tfDefault'),
  fitMode: $<HTMLSelectElement>('fitMode'),
  fitInfo: $('fitInfo'),
  easing: $<HTMLSelectElement>('easing'),
  resolution: $<HTMLSelectElement>('resolution'),
  imgBg: $<HTMLInputElement>('imgBg'),
  lineColor: $<HTMLInputElement>('lineColor'),
  lineBg: $<HTMLInputElement>('lineBg'),
  playBtn: $<HTMLButtonElement>('playBtn'),
  mp4Btn: $<HTMLButtonElement>('mp4Btn'),
  webmBtn: $<HTMLButtonElement>('webmBtn'),
  progress: $<HTMLProgressElement>('progress'),
  status: $('status'),
};

const state = {
  assets: null as Assets | null,
  image: null as ImageBitmap | null,
  width: 720,
  height: 720,
  imgBg: [0, 0, 0] as RGB,
  lineColor: [255, 255, 211] as RGB,
  lineBg: [125, 115, 119] as RGB,
  detect: { ...DEFAULT_DETECT_PARAMS } as DetectParams,
  select: { ...DEFAULT_SELECT_PARAMS } as SelectParams,
  /** editor.candidates と同じ順の輪郭の強さ */
  contrast: [] as number[],
  transformFrames: DEFAULT_TRANSFORM_FRAMES,
  fitMode: 'auto' as FitMode,
  easing: 'linear' as Easing,
  busy: false,
};

const editor = new SegmentEditor(el.stage);
const ctx = el.stage.getContext('2d')!;
let player: Player | null = null;

// ---------- 小物 ----------

const toHex = (c: RGB) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;

function setStatus(msg: string, error = false): void {
  el.status.textContent = msg;
  el.status.classList.toggle('error', error);
}

let hintTimer = 0;
function flashHint(msg: string): void {
  el.hint.textContent = msg;
  clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => (el.hint.textContent = ''), 3000);
}

function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t = 0;
  return (...a: A) => {
    clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  };
}

// ---------- シーンと音声 ----------

function timeline() {
  return makeTimeline(state.transformFrames / FPS, state.assets?.tailSeconds ?? 8);
}

function buildScene(): Scene | null {
  const { image, assets } = state;
  if (!image || !assets || editor.chosen.length !== SEGMENT_COUNT) return null;
  return {
    width: state.width,
    height: state.height,
    image,
    imagePlacement: fitContain(image.width, image.height, state.width, state.height),
    segments: editor.chosen.map((s) => editor.toCanvas(s)),
    targets: stickBugTargets(state.width, state.height, assets.videoWidth, assets.videoHeight),
    imgBgColor: state.imgBg,
    lineColor: state.lineColor,
    lineBgColor: state.lineBg,
    easing: state.easing,
    timeline: timeline(),
  };
}

let soundtrack: { key: string; buf: Promise<AudioBuffer> } | null = null;
function getSoundtrack(): Promise<AudioBuffer> {
  const key = `${state.transformFrames}|${state.fitMode}`;
  if (!soundtrack || soundtrack.key !== key) {
    soundtrack = { key, buf: buildSoundtrack(state.assets!, timeline(), state.fitMode) };
  }
  return soundtrack.buf;
}

// ---------- 画面の更新 ----------

function refreshView(): void {
  if (state.image) {
    editor.setView({
      image: state.image,
      placement: fitContain(state.image.width, state.image.height, state.width, state.height),
      width: state.width,
      height: state.height,
      imgBgColor: state.imgBg,
      lineColor: state.lineColor,
    });
  } else {
    editor.setView(null);
  }
}

function refreshSegList(): void {
  el.segList.replaceChildren();
  const k = state.image ? fitContain(state.image.width, state.image.height, state.width, state.height).w / state.image.width : 1;
  for (let i = 0; i < SEGMENT_COUNT; i++) {
    const li = document.createElement('li');
    const s = editor.chosen[i];
    const badge = `<span class="num-badge">${i + 1}</span>`;
    if (!s) {
      li.className = 'empty';
      li.innerHTML = `${badge}<span>（空き）</span><span></span>`;
    } else {
      li.className = editor.selected === i ? 'selected' : '';
      li.innerHTML = `${badge}<span class="mono">${(segmentLength(s) * k).toFixed(0)} px</span>
        <span class="ops"><button data-op="up" title="前へ">↑</button> <button data-op="down" title="後へ">↓</button> <button data-op="del" title="削除">✕</button></span>`;
      li.addEventListener('click', (e) => {
        const op = (e.target as HTMLElement).dataset.op;
        if (op === 'up') editor.move(i, -1);
        else if (op === 'down') editor.move(i, 1);
        else if (op === 'del') editor.remove(i);
        else editor.select(editor.selected === i ? null : i);
      });
    }
    el.segList.append(li);
  }
}

function refreshButtons(): void {
  const ready = !!buildScene();
  const playing = player?.playing ?? false;
  editor.locked = playing || state.busy;
  el.playBtn.disabled = !ready || state.busy;
  el.playBtn.textContent = playing ? '■ 停止' : '▶ プレビュー再生';
  el.mp4Btn.disabled = el.webmBtn.disabled = !ready || state.busy || playing;
  if (state.image && editor.chosen.length < SEGMENT_COUNT) {
    setStatus(`線分があと ${SEGMENT_COUNT - editor.chosen.length} 本必要です。候補をクリックするか「線を描く」で追加してください。`, true);
  } else if (state.image && !state.busy && state.assets) {
    setStatus(`準備できました（全体 ${timeline().duration.toFixed(2)} 秒）`);
  }
}

function refreshTransformUI(): void {
  const f = state.transformFrames;
  const sec = f / FPS;
  el.tfFrames.value = String(f);
  el.tfVal.textContent = `${sec.toFixed(2)} 秒（${f} フレーム）`;
  if (document.activeElement !== el.tfSeconds) el.tfSeconds.value = sec.toFixed(2);
  const r = f / DEFAULT_TRANSFORM_FRAMES;
  let info: string;
  if (f === DEFAULT_TRANSFORM_FRAMES) info = '音声: 元のまま';
  else if (state.fitMode === 'stretch') info = `音声: タイムストレッチ ×${r.toFixed(2)}`;
  else if (state.fitMode === 'cut') info = `音声: 真ん中を ${(1.733 - sec).toFixed(2)} 秒抜く`;
  else if (r >= AUTO_MIN_STRETCH_RATIO) info = `音声: タイムストレッチ ×${r.toFixed(2)}`;
  else info = `音声: タイムストレッチ ×${AUTO_MIN_STRETCH_RATIO} ＋ 中抜き ${(1.733 * AUTO_MIN_STRETCH_RATIO - sec).toFixed(2)} 秒`;
  el.fitInfo.textContent = info;
  el.timeLabel.textContent = `0.00 / ${timeline().duration.toFixed(2)} 秒`;
}

editor.onChange = () => {
  refreshSegList();
  refreshButtons();
};
editor.onMessage = flashHint;

// ---------- 画像と検出 ----------

let detectSeq = 0;
async function runDetect(): Promise<void> {
  if (!state.image) return;
  const seq = ++detectSeq;
  setStatus('線分を検出しています…');
  try {
    const res = await detectSegments(state.image, state.width, state.height, state.imgBg, state.detect);
    if (seq !== detectSeq) return; // 新しい検出が始まっていれば捨てる
    editor.candidates = res.candidates;
    state.contrast = res.contrast;
    applyAutoSelection();
    flashHint(`${res.candidates.length} 本の候補を検出（${res.ms.toFixed(0)} ms）`);
  } catch (e) {
    setStatus(`検出に失敗しました: ${e}`, true);
  }
}
const runDetectSoon = debounce(runDetect, 150);

/** 候補から9本を自動で選ぶ（点数の高い順、中点が近すぎるものは飛ばす） */
function applyAutoSelection(): void {
  if (!state.image) return;
  const p = fitContain(state.image.width, state.image.height, state.width, state.height);
  const k = p.w / state.image.width;
  const cands = editor.candidates.map((s, i) => ({
    length: segmentLength(s) * k,
    mx: ((s[0] + s[2]) / 2) * k + p.x,
    my: ((s[1] + s[3]) / 2) * k + p.y,
    contrast: state.contrast[i] ?? 0,
  }));
  editor.setChosen(selectSegments(cands, state.select, SEGMENT_COUNT).map((i) => editor.candidates[i]));
}

async function loadImage(file: Blob): Promise<void> {
  if (!file.type.startsWith('image/')) {
    flashHint('画像ファイルを選んでください');
    return;
  }
  try {
    player?.stop();
    state.image = await createImageBitmap(file);
    el.placeholder.hidden = true;
    refreshView();
    await runDetect();
  } catch (e) {
    setStatus(`画像を読み込めませんでした: ${e}`, true);
  }
}

el.fileInput.addEventListener('change', () => {
  const f = el.fileInput.files?.[0];
  if (f) void loadImage(f);
  el.fileInput.value = '';
});
el.dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  el.dropZone.classList.add('dragover');
});
el.dropZone.addEventListener('dragleave', () => el.dropZone.classList.remove('dragover'));
el.dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  el.dropZone.classList.remove('dragover');
  const f = e.dataTransfer?.files[0];
  if (f) void loadImage(f);
});
window.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  const f = item?.getAsFile();
  if (f) void loadImage(f);
});

// ---------- 線分の設定 ----------

el.scale.value = String(state.detect.scale);
el.minLen.value = String(state.detect.minLength);
const refreshDetectLabels = () => {
  el.scaleVal.textContent = state.detect.scale.toFixed(2);
  el.minLenVal.textContent = `${state.detect.minLength} px`;
};
refreshDetectLabels();
el.scale.addEventListener('input', () => {
  state.detect.scale = Number(el.scale.value);
  refreshDetectLabels();
  runDetectSoon();
});
el.minLen.addEventListener('input', () => {
  state.detect.minLength = Number(el.minLen.value);
  refreshDetectLabels();
  runDetectSoon();
});
el.showCandidates.addEventListener('change', () => {
  editor.showCandidates = el.showCandidates.checked;
  editor.render();
});
el.drawBtn.addEventListener('click', () => {
  editor.drawMode = !editor.drawMode;
  el.drawBtn.setAttribute('aria-pressed', String(editor.drawMode));
  flashHint(editor.drawMode ? 'ドラッグで線を引きます（選択中の線があれば置き換え）' : '');
});
el.resetBtn.addEventListener('click', () => applyAutoSelection());

el.spacing.value = String(state.select.minSpacing);
el.contrastW.value = String(state.select.contrastWeight);
const refreshSelectLabels = () => {
  el.spacingVal.textContent = state.select.minSpacing === 0 ? '制約なし' : `${state.select.minSpacing} px 以上`;
  el.contrastWVal.textContent = state.select.contrastWeight === 0 ? '長さだけ' : `×${state.select.contrastWeight.toFixed(2)}`;
};
refreshSelectLabels();
el.spacing.addEventListener('input', () => {
  state.select.minSpacing = Number(el.spacing.value);
  refreshSelectLabels();
  applyAutoSelection();
});
el.contrastW.addEventListener('input', () => {
  state.select.contrastWeight = Number(el.contrastW.value);
  refreshSelectLabels();
  applyAutoSelection();
});

// ---------- 変形の設定 ----------

function setTransformFrames(f: number): void {
  // 伸ばす方向は実用上の需要がなく音も荒れるので、元の長さ（52フレーム）を上限にする
  state.transformFrames = Math.min(DEFAULT_TRANSFORM_FRAMES, Math.max(9, Math.round(f)));
  refreshTransformUI();
  refreshButtons();
}
el.tfFrames.addEventListener('input', () => setTransformFrames(Number(el.tfFrames.value)));
el.tfSeconds.addEventListener('change', () => {
  const v = Number(el.tfSeconds.value);
  if (Number.isFinite(v)) setTransformFrames(v * FPS);
  el.tfSeconds.value = (state.transformFrames / FPS).toFixed(2);
});
el.tfDefault.addEventListener('click', () => setTransformFrames(DEFAULT_TRANSFORM_FRAMES));
el.fitMode.addEventListener('change', () => {
  state.fitMode = el.fitMode.value as FitMode;
  refreshTransformUI();
});
el.easing.addEventListener('change', () => (state.easing = el.easing.value as Easing));

// ---------- 見た目 ----------

el.imgBg.value = toHex(state.imgBg);
el.lineColor.value = toHex(state.lineColor);
el.lineBg.value = toHex(state.lineBg);
el.imgBg.addEventListener('input', () => {
  state.imgBg = fromHex(el.imgBg.value);
  refreshView();
});
el.lineColor.addEventListener('input', () => {
  state.lineColor = fromHex(el.lineColor.value);
  refreshView();
});
el.lineBg.addEventListener('input', () => (state.lineBg = fromHex(el.lineBg.value)));
el.resolution.addEventListener('change', () => {
  player?.stop();
  const [w, h] = el.resolution.value.split('x').map(Number);
  state.width = el.stage.width = w;
  state.height = el.stage.height = h;
  refreshView();
  refreshSegList();
});

// ---------- 再生と書き出し ----------

async function togglePlay(): Promise<void> {
  if (!player || !state.assets) return;
  if (player.playing) {
    player.stop();
    editor.render();
    refreshButtons();
    return;
  }
  const scene = buildScene();
  if (!scene) return;
  setStatus('音声を準備しています…');
  const buf = await getSoundtrack();
  refreshButtons();
  await player.play(scene, buf);
  refreshButtons();
}

async function doExport(format: ExportFormat): Promise<void> {
  const scene = buildScene();
  if (!scene) return;
  player?.stop();
  state.busy = true;
  refreshButtons();
  el.progress.hidden = false;
  el.progress.value = 0;
  let done: string | null = null;
  try {
    setStatus('音声を準備しています…');
    const buf = await getSoundtrack();
    setStatus(`${format.toUpperCase()} を書き出しています…`);
    const t0 = performance.now();
    const res = await exportVideo(format, scene, buf, (r) => {
      el.progress.value = r;
      setStatus(`${format.toUpperCase()} を書き出しています… ${(r * 100).toFixed(0)}%`);
    });
    const url = URL.createObjectURL(res.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `stick-bugged.${format}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    done = `保存しました（${res.videoCodec} + ${res.audioCodec}、${(res.blob.size / 1e6).toFixed(1)} MB、${((performance.now() - t0) / 1000).toFixed(1)} 秒）`;
  } catch (e) {
    console.error(e);
    setStatus(`書き出しに失敗しました: ${e}`, true);
  } finally {
    state.busy = false;
    el.progress.hidden = true;
    editor.render();
    refreshButtons();
    // refreshButtons が「準備できました」に戻すので、完了メッセージはその後に出す
    if (done) setStatus(done);
  }
}

el.playBtn.addEventListener('click', () => void togglePlay());
el.mp4Btn.addEventListener('click', () => void doExport('mp4'));
el.webmBtn.addEventListener('click', () => void doExport('webm'));

// ---------- 起動 ----------

refreshTransformUI();
refreshSegList();
loadAssets()
  .then((assets) => {
    state.assets = assets;
    player = new Player(ctx, assets.tailVideo);
    player.onTime = (t) => (el.timeLabel.textContent = `${t.toFixed(2)} / ${timeline().duration.toFixed(2)} 秒`);
    player.onEnd = () => {
      editor.render();
      refreshButtons();
    };
    refreshTransformUI();
    setStatus(state.image ? '' : '画像を選んでください');
    refreshButtons();
  })
  .catch((e) => setStatus(`素材を読み込めませんでした: ${e.message ?? e}（public/media/ に gsbl の素材があるか確認してください）`, true));
