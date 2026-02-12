const gifInput = document.getElementById('gifInput');
const columnsInput = document.getElementById('columnsInput');
const gapInput = document.getElementById('gapInput');
const bgInput = document.getElementById('bgInput');
const transparentBgInput = document.getElementById('transparentBgInput');
const fixedSizeInput = document.getElementById('fixedSizeInput');
const canvasWidthInput = document.getElementById('canvasWidthInput');
const canvasHeightInput = document.getElementById('canvasHeightInput');
const fpsInput = document.getElementById('fpsInput');
const presetNameInput = document.getElementById('presetNameInput');
const savePresetBtn = document.getElementById('savePresetBtn');
const presetSelect = document.getElementById('presetSelect');
const loadPresetBtn = document.getElementById('loadPresetBtn');
const deletePresetBtn = document.getElementById('deletePresetBtn');

const previewBtn = document.getElementById('previewBtn');
const generateBtn = document.getElementById('generateBtn');
const statusEl = document.getElementById('status');
const metaList = document.getElementById('metaList');
const downloadEl = document.getElementById('download');
const debugLogEl = document.getElementById('debugLog');
const previewCanvas = document.getElementById('previewCanvas');
const previewCtx = previewCanvas.getContext('2d');

const GIFJS_PRIMARY = 'https://cdn.jsdelivr.net/npm/gif.js.optimized/dist/gif.js';
const GIFJS_FALLBACK = 'https://unpkg.com/gif.js.optimized/dist/gif.js';
const GIF_WORKER_PRIMARY = 'https://cdn.jsdelivr.net/npm/gif.js.optimized/dist/gif.worker.js';
const GIF_WORKER_FALLBACK = 'https://unpkg.com/gif.js.optimized/dist/gif.worker.js';
const GIF_WORKER_LOCAL = './gif.worker.js';
const GIF_TRANSPARENT_KEY_HEX = '#00ff00';
const GIF_TRANSPARENT_KEY_NUM = 0x00ff00;
const GIF_QUALITY_FIXED = 1;
const PRESET_STORAGE_KEY = 'gif-layout-presets-v1';
const RESOLUTION_WARN_PIXELS = 1920 * 1080 * 2;
const WORKLOAD_WARN_PIXELS = 240_000_000;
const MAX_COLUMNS = 30;

const state = {
  sources: [],
  outputUrl: null,
  previewTimerId: null,
  previewDebounceTimerId: null,
  workerBlobUrl: null,
  dragSourceIndex: null,
  presets: {},
  previewRuntime: null,
  canvasDrag: null
};

function logDebug(message, detail) {
  const timestamp = new Date().toLocaleTimeString();
  const suffix = typeof detail === 'undefined' ? '' : ` ${JSON.stringify(detail)}`;
  const line = `[${timestamp}] ${message}${suffix}`;
  console.log(line);

  if (debugLogEl) {
    debugLogEl.textContent += `${line}\n`;
    debugLogEl.scrollTop = debugLogEl.scrollHeight;
  }
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#c53030' : '#2b6cb0';
}

function clearDownloadLink() {
  cleanupOutputUrl();
  downloadEl.innerHTML = '';
}

function cleanupOutputUrl() {
  if (state.outputUrl) {
    URL.revokeObjectURL(state.outputUrl);
    state.outputUrl = null;
  }
}

function cleanupWorkerBlobUrl() {
  if (state.workerBlobUrl) {
    URL.revokeObjectURL(state.workerBlobUrl);
    state.workerBlobUrl = null;
  }
}

function clampInteger(value, min, max, fallback) {
  const num = Number.parseInt(value, 10);
  if (Number.isNaN(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function isTransparentBackgroundEnabled() {
  return Boolean(transparentBgInput?.checked);
}

function isFixedCanvasSizeEnabled() {
  return Boolean(fixedSizeInput?.checked);
}

function getCurrentSettings() {
  return {
    columns: clampInteger(columnsInput.value, 1, MAX_COLUMNS, 5),
    gap: clampInteger(gapInput.value, 0, 100, 0),
    bgColor: bgInput.value || '#ffffff',
    transparentBg: isTransparentBackgroundEnabled(),
    fixedSize: isFixedCanvasSizeEnabled(),
    canvasWidth: clampInteger(canvasWidthInput.value, 64, 4096, 1920),
    canvasHeight: clampInteger(canvasHeightInput.value, 64, 4096, 1080),
    fps: clampInteger(fpsInput.value, 5, 30, 15)
  };
}

function applySettings(settings) {
  columnsInput.value = String(clampInteger(settings.columns, 1, MAX_COLUMNS, 5));
  gapInput.value = String(clampInteger(settings.gap, 0, 100, 0));
  bgInput.value = settings.bgColor || '#ffffff';
  transparentBgInput.checked = Boolean(settings.transparentBg);
  fixedSizeInput.checked = Boolean(settings.fixedSize);
  canvasWidthInput.value = String(clampInteger(settings.canvasWidth, 64, 4096, 1920));
  canvasHeightInput.value = String(clampInteger(settings.canvasHeight, 64, 4096, 1080));
  fpsInput.value = String(clampInteger(settings.fps, 5, 30, 15));
  syncControlEnabledStates();
}

function syncControlEnabledStates() {
  bgInput.disabled = transparentBgInput.checked;
  canvasWidthInput.disabled = !fixedSizeInput.checked;
  canvasHeightInput.disabled = !fixedSizeInput.checked;
}

function paintBackground(ctx, width, height, bgColor, transparent, forGifOutput = false) {
  if (transparent) {
    if (forGifOutput) {
      ctx.fillStyle = GIF_TRANSPARENT_KEY_HEX;
      ctx.fillRect(0, 0, width, height);
    } else {
      ctx.clearRect(0, 0, width, height);
    }
    return;
  }

  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, width, height);
}

function scheduleAutoPreview() {
  if (state.previewDebounceTimerId !== null) {
    clearTimeout(state.previewDebounceTimerId);
  }

  state.previewDebounceTimerId = setTimeout(() => {
    state.previewDebounceTimerId = null;
    if (state.sources.length > 0) {
      updatePreview();
    }
  }, 160);
}

function calculateOptimalFpsFromSources(sources, minFps = 5, maxFps = 30) {
  if (!sources?.length) {
    return 15;
  }

  const delays = [];
  for (const source of sources) {
    for (const frame of source.frames) {
      if (Number.isFinite(frame.delayMs) && frame.delayMs > 0) {
        delays.push(frame.delayMs);
      }
    }
  }

  if (!delays.length) {
    return 15;
  }

  let bestFps = minFps;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let fps = minFps; fps <= maxFps; fps += 1) {
    const frameMs = 1000 / fps;
    let score = 0;

    for (const delay of delays) {
      const steps = Math.max(1, Math.round(delay / frameMs));
      score += Math.abs(steps * frameMs - delay);
    }

    if (score < bestScore || (score === bestScore && fps > bestFps)) {
      bestScore = score;
      bestFps = fps;
    }
  }

  return bestFps;
}

function getBaseLayoutMetrics(sources, columns, gap) {
  const cellWidth = Math.max(...sources.map((source) => source.width));
  const cellHeight = Math.max(...sources.map((source) => source.height));
  const rows = Math.ceil(sources.length / columns);
  const contentWidth = columns * cellWidth + Math.max(0, columns - 1) * gap;
  const contentHeight = rows * cellHeight + Math.max(0, rows - 1) * gap;

  return {
    cellWidth,
    cellHeight,
    rows,
    contentWidth,
    contentHeight
  };
}

function getLayoutMetrics(sources, settings) {
  const base = getBaseLayoutMetrics(sources, settings.columns, settings.gap);
  const width = settings.fixedSize ? settings.canvasWidth : base.contentWidth;
  const height = settings.fixedSize ? settings.canvasHeight : base.contentHeight;

  const drawScale = settings.fixedSize
    ? Math.min(1, width / base.contentWidth, height / base.contentHeight)
    : 1;

  const scaledContentWidth = base.contentWidth * drawScale;
  const scaledContentHeight = base.contentHeight * drawScale;
  const originX = Math.floor((width - scaledContentWidth) / 2);
  const originY = Math.floor((height - scaledContentHeight) / 2);

  return {
    ...base,
    width,
    height,
    drawScale,
    scaledContentWidth,
    scaledContentHeight,
    originX,
    originY
  };
}

function getItemBasePosition(index, settings, metrics) {
  const col = index % settings.columns;
  const row = Math.floor(index / settings.columns);

  const scaledCellWidth = metrics.cellWidth * metrics.drawScale;
  const scaledCellHeight = metrics.cellHeight * metrics.drawScale;
  const scaledGap = settings.gap * metrics.drawScale;

  return {
    x: metrics.originX + col * (scaledCellWidth + scaledGap),
    y: metrics.originY + row * (scaledCellHeight + scaledGap)
  };
}

function drawFrameOnContext(ctx, source, frameIndex, x, y, drawScale = 1) {
  const frame = source.frames[frameIndex];
  source.blitCtx.putImageData(frame.imageData, 0, 0);

  const drawWidth = Math.max(1, Math.round(source.width * drawScale));
  const drawHeight = Math.max(1, Math.round(source.height * drawScale));
  ctx.drawImage(source.blitCanvas, Math.round(x), Math.round(y), drawWidth, drawHeight);
}

function getCanvasPointFromMouseEvent(event) {
  const rect = previewCanvas.getBoundingClientRect();
  const scaleX = previewCanvas.width / rect.width;
  const scaleY = previewCanvas.height / rect.height;

  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY
  };
}

function findPreviewHit(point) {
  const runtime = state.previewRuntime;
  if (!runtime || !runtime.itemRects?.length) {
    return null;
  }

  for (let i = runtime.itemRects.length - 1; i >= 0; i -= 1) {
    const rect = runtime.itemRects[i];
    const insideX = point.x >= rect.x && point.x <= rect.x + rect.width;
    const insideY = point.y >= rect.y && point.y <= rect.y + rect.height;
    if (insideX && insideY) {
      return rect;
    }
  }

  return null;
}

function moveSourceIndex(from, to, resetOffset = true) {
  if (from === to || from < 0 || to < 0 || from >= state.sources.length || to >= state.sources.length) {
    return;
  }

  const moved = state.sources.splice(from, 1)[0];
  if (resetOffset) {
    moved.offsetX = 0;
    moved.offsetY = 0;
  }
  state.sources.splice(to, 0, moved);
}

function findFrameIndexByTime(source, timeMs) {
  const localTime = source.durationMs === 0 ? 0 : timeMs % source.durationMs;
  for (let i = 0; i < source.timeline.length; i += 1) {
    if (localTime < source.timeline[i]) {
      return i;
    }
  }
  return Math.max(0, source.timeline.length - 1);
}

function stopPreviewAnimation() {
  if (state.previewTimerId !== null) {
    clearInterval(state.previewTimerId);
    state.previewTimerId = null;
  }
}

function getResolutionWarningMessage(metrics, frameCountForEstimate = null) {
  const pixels = metrics.width * metrics.height;
  let message = '';

  if (pixels > RESOLUTION_WARN_PIXELS) {
    logDebug('解像度警告', { width: metrics.width, height: metrics.height, pixels });
    message = '警告: 出力解像度が高いため処理時間が長くなる可能性があります。';
  }

  if (frameCountForEstimate !== null) {
    const workload = pixels * frameCountForEstimate;
    if (workload > WORKLOAD_WARN_PIXELS) {
      logDebug('処理量警告', { pixels, frames: frameCountForEstimate, workload });
      message = '警告: 解像度×フレーム数が大きいため、生成に時間がかかります。';
    }
  }

  return message;
}

function getColumnsLimitWarningMessage() {
  const rawValue = Number.parseInt(columnsInput.value, 10);
  if (Number.isNaN(rawValue)) {
    return '';
  }

  if (rawValue > MAX_COLUMNS) {
    logDebug('列数上限警告', { input: rawValue, max: MAX_COLUMNS });
    return `警告: 列数の上限は${MAX_COLUMNS}です。${MAX_COLUMNS}で処理します。`;
  }

  return '';
}

function areImageDataEqual(imageDataA, imageDataB) {
  if (!imageDataA || !imageDataB) {
    return false;
  }

  if (imageDataA.data.length !== imageDataB.data.length) {
    return false;
  }

  const viewA = new Uint32Array(imageDataA.data.buffer);
  const viewB = new Uint32Array(imageDataB.data.buffer);
  if (viewA.length !== viewB.length) {
    return false;
  }

  for (let i = 0; i < viewA.length; i += 1) {
    if (viewA[i] !== viewB[i]) {
      return false;
    }
  }

  return true;
}

function renderMeta() {
  metaList.innerHTML = '';

  state.sources.forEach((source, idx) => {
    const item = document.createElement('li');
    item.className = 'meta-item';
    item.draggable = true;
    item.dataset.index = String(idx);

    const top = document.createElement('div');
    top.className = 'meta-top';

    const name = document.createElement('div');
    name.textContent = `${idx + 1}. ${source.name} / ${source.width}x${source.height} / ${source.frames.length}f`;

    const dragHandle = document.createElement('span');
    dragHandle.className = 'drag-handle';
    dragHandle.textContent = '↕ 並び替え';

    top.appendChild(name);
    top.appendChild(dragHandle);

    const offsetRow = document.createElement('div');
    offsetRow.className = 'offset-row';

    const offsetXLabel = document.createElement('label');
    offsetXLabel.textContent = 'Xオフセット(px)';
    const offsetXInput = document.createElement('input');
    offsetXInput.type = 'number';
    offsetXInput.value = String(source.offsetX || 0);
    offsetXInput.addEventListener('input', () => {
      source.offsetX = clampInteger(offsetXInput.value, -5000, 5000, 0);
      scheduleAutoPreview();
    });
    offsetXLabel.appendChild(offsetXInput);

    const offsetYLabel = document.createElement('label');
    offsetYLabel.textContent = 'Yオフセット(px)';
    const offsetYInput = document.createElement('input');
    offsetYInput.type = 'number';
    offsetYInput.value = String(source.offsetY || 0);
    offsetYInput.addEventListener('input', () => {
      source.offsetY = clampInteger(offsetYInput.value, -5000, 5000, 0);
      scheduleAutoPreview();
    });
    offsetYLabel.appendChild(offsetYInput);

    offsetRow.appendChild(offsetXLabel);
    offsetRow.appendChild(offsetYLabel);

    item.appendChild(top);
    item.appendChild(offsetRow);

    item.addEventListener('dragstart', () => {
      state.dragSourceIndex = idx;
    });

    item.addEventListener('dragover', (event) => {
      event.preventDefault();
    });

    item.addEventListener('drop', (event) => {
      event.preventDefault();
      const from = state.dragSourceIndex;
      const to = idx;
      if (from === null || from === to) {
        return;
      }

      moveSourceIndex(from, to, true);
      state.dragSourceIndex = null;
      renderMeta();
      updatePreview();
    });

    item.addEventListener('dragend', () => {
      state.dragSourceIndex = null;
    });

    metaList.appendChild(item);
  });
}

function hasGifEncoder() {
  return Boolean(window.GIF);
}

function loadScript(src, id) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    if (id) {
      script.id = id;
    }
    script.onload = () => resolve(src);
    script.onerror = () => reject(new Error(`スクリプト読込失敗: ${src}`));
    document.head.appendChild(script);
  });
}

async function ensureGifEncoderReady() {
  if (hasGifEncoder()) {
    return true;
  }

  try {
    logDebug('gif.js フォールバック読込開始', { src: GIFJS_FALLBACK });
    await loadScript(GIFJS_FALLBACK, 'gifjsFallback');
    logDebug('gif.js フォールバック読込成功');
  } catch (error) {
    logDebug('gif.js フォールバック読込失敗', { message: error.message });
  }

  return hasGifEncoder();
}

async function resolveWorkerScriptUrl() {
  if (location.protocol !== 'file:') {
    return GIF_WORKER_LOCAL;
  }

  if (state.workerBlobUrl) {
    return state.workerBlobUrl;
  }

  const candidates = [GIF_WORKER_LOCAL, GIF_WORKER_PRIMARY, GIF_WORKER_FALLBACK];

  for (const src of candidates) {
    try {
      logDebug('Workerスクリプト取得開始', { src });
      const response = await fetch(src, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const code = await response.text();
      const blob = new Blob([code], { type: 'text/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      state.workerBlobUrl = blobUrl;
      logDebug('Workerスクリプト取得成功', { src, blobUrl });
      return blobUrl;
    } catch (error) {
      logDebug('Workerスクリプト取得失敗', { src, message: error.message });
    }
  }

  return null;
}

function ensureImageDecoderReady() {
  return 'ImageDecoder' in window;
}

async function decodeGifWithImageDecoder(file) {
  const buffer = await file.arrayBuffer();
  const decoder = new ImageDecoder({ data: buffer, type: 'image/gif' });
  await decoder.tracks.ready;

  const track = decoder.tracks.selectedTrack;
  const knownFrameCount = Number.isInteger(track?.frameCount) ? track.frameCount : null;

  const frames = [];
  const timeline = [];
  let totalTime = 0;
  let width = 0;
  let height = 0;

  const workCanvas = document.createElement('canvas');
  const workCtx = workCanvas.getContext('2d');

  if (knownFrameCount !== null) {
    for (let i = 0; i < knownFrameCount; i += 1) {
      const result = await decoder.decode({ frameIndex: i });
      const videoFrame = result.image;

      if (i === 0) {
        width = videoFrame.displayWidth || videoFrame.codedWidth;
        height = videoFrame.displayHeight || videoFrame.codedHeight;
        workCanvas.width = width;
        workCanvas.height = height;
      }

      workCtx.clearRect(0, 0, width, height);
      workCtx.drawImage(videoFrame, 0, 0, width, height);
      const imageData = workCtx.getImageData(0, 0, width, height);
      const delayMs = Math.max(20, Math.round((videoFrame.duration || 100000) / 1000));

      frames.push({ imageData, delayMs });
      totalTime += delayMs;
      timeline.push(totalTime);
      videoFrame.close();
    }
  } else {
    let frameIndex = 0;
    while (true) {
      try {
        const result = await decoder.decode({ frameIndex });
        const videoFrame = result.image;

        if (frameIndex === 0) {
          width = videoFrame.displayWidth || videoFrame.codedWidth;
          height = videoFrame.displayHeight || videoFrame.codedHeight;
          workCanvas.width = width;
          workCanvas.height = height;
        }

        workCtx.clearRect(0, 0, width, height);
        workCtx.drawImage(videoFrame, 0, 0, width, height);
        const imageData = workCtx.getImageData(0, 0, width, height);
        const delayMs = Math.max(20, Math.round((videoFrame.duration || 100000) / 1000));

        frames.push({ imageData, delayMs });
        totalTime += delayMs;
        timeline.push(totalTime);
        videoFrame.close();
        frameIndex += 1;
      } catch {
        break;
      }
    }
  }

  decoder.close();

  if (!frames.length) {
    throw new Error(`${file.name}: フレームを読み込めませんでした。`);
  }

  return {
    name: file.name,
    width,
    height,
    frames,
    timeline,
    durationMs: totalTime,
    offsetX: 0,
    offsetY: 0,
    blitCanvas: Object.assign(document.createElement('canvas'), { width, height }),
    blitCtx: null
  };
}

function prepareSourceBlitBuffers() {
  for (const source of state.sources) {
    source.blitCtx = source.blitCanvas.getContext('2d');
  }
}

async function loadGifs(files) {
  clearDownloadLink();
  stopPreviewAnimation();
  state.sources = [];
  metaList.innerHTML = '';

  if (!files?.length) {
    generateBtn.disabled = true;
    setStatus('GIFファイルを選択してください。', true);
    previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    return;
  }

  if (!ensureImageDecoderReady()) {
    setStatus('このブラウザはImageDecoderに未対応です。Edge/Chrome最新版を使用してください。', true);
    logDebug('ImageDecoder未対応', { userAgent: navigator.userAgent });
    generateBtn.disabled = true;
    return;
  }

  setStatus('GIFを解析中です...');

  const parsedSources = [];
  for (const file of files) {
    if (file.type !== 'image/gif') {
      logDebug('GIF以外をスキップ', { name: file.name, type: file.type });
      continue;
    }

    const source = await decodeGifWithImageDecoder(file);
    parsedSources.push(source);
    logDebug('GIF解析完了', {
      name: source.name,
      width: source.width,
      height: source.height,
      frames: source.frames.length,
      durationMs: source.durationMs
    });
  }

  if (!parsedSources.length) {
    setStatus('有効なGIFを読み込めませんでした。', true);
    generateBtn.disabled = true;
    return;
  }

  state.sources = parsedSources;
  prepareSourceBlitBuffers();

  const optimalFps = calculateOptimalFpsFromSources(parsedSources, 5, 30);
  fpsInput.value = String(optimalFps);
  logDebug('推奨FPSを自動設定', { optimalFps });

  renderMeta();
  generateBtn.disabled = false;
  updatePreview();
}

function updatePreview() {
  stopPreviewAnimation();

  if (!state.sources.length) {
    previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    setStatus('先にGIFを読み込んでください。', true);
    return;
  }

  const settings = getCurrentSettings();
  const metrics = getLayoutMetrics(state.sources, settings);
  const warningMessage = getColumnsLimitWarningMessage() || getResolutionWarningMessage(metrics);

  previewCanvas.width = metrics.width;
  previewCanvas.height = metrics.height;

  const frameDelay = Math.max(10, Math.round(1000 / settings.fps));
  const startedAt = performance.now();
  const runtime = {
    settings,
    metrics,
    startedAt,
    itemRects: [],
    drawTick: null
  };
  state.previewRuntime = runtime;

  const drawTick = () => {
    const elapsed = performance.now() - startedAt;
    paintBackground(previewCtx, metrics.width, metrics.height, settings.bgColor, settings.transparentBg, false);
    const itemRects = [];

    state.sources.forEach((source, idx) => {
      const frameIndex = findFrameIndexByTime(source, elapsed);
      const basePos = getItemBasePosition(idx, settings, metrics);
      const drawX = basePos.x + (source.offsetX || 0);
      const drawY = basePos.y + (source.offsetY || 0);
      drawFrameOnContext(
        previewCtx,
        source,
        frameIndex,
        drawX,
        drawY,
        metrics.drawScale
      );

      itemRects.push({
        index: idx,
        x: drawX,
        y: drawY,
        width: source.width * metrics.drawScale,
        height: source.height * metrics.drawScale
      });
    });

    runtime.itemRects = itemRects;
  };

  runtime.drawTick = drawTick;
  drawTick();
  state.previewTimerId = setInterval(drawTick, frameDelay);
  setStatus(warningMessage || 'プレビューを更新しました。', Boolean(warningMessage));
}

function handlePreviewMouseDown(event) {
  if (!state.sources.length) {
    return;
  }

  const point = getCanvasPointFromMouseEvent(event);
  const hit = findPreviewHit(point);
  if (!hit) {
    return;
  }

  const source = state.sources[hit.index];
  state.canvasDrag = {
    sourceIndex: hit.index,
    startPoint: point,
    startOffsetX: source.offsetX || 0,
    startOffsetY: source.offsetY || 0,
    moved: false
  };

  previewCanvas.style.cursor = 'grabbing';
  event.preventDefault();
}

function handlePreviewMouseMove(event) {
  if (!state.canvasDrag) {
    const point = getCanvasPointFromMouseEvent(event);
    const hit = findPreviewHit(point);
    previewCanvas.style.cursor = hit ? 'grab' : 'default';
    return;
  }

  const drag = state.canvasDrag;
  const source = state.sources[drag.sourceIndex];
  if (!source) {
    return;
  }

  const point = getCanvasPointFromMouseEvent(event);
  const dx = point.x - drag.startPoint.x;
  const dy = point.y - drag.startPoint.y;

  if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
    drag.moved = true;
  }

  source.offsetX = Math.round(drag.startOffsetX + dx);
  source.offsetY = Math.round(drag.startOffsetY + dy);

  if (state.previewRuntime?.drawTick) {
    state.previewRuntime.drawTick();
  }
}

function handlePreviewMouseUp(event) {
  if (!state.canvasDrag) {
    return;
  }

  const drag = state.canvasDrag;
  const sourceIndex = drag.sourceIndex;
  const point = getCanvasPointFromMouseEvent(event);
  const dropHit = findPreviewHit(point);

  if (dropHit && dropHit.index !== sourceIndex && drag.moved) {
    moveSourceIndex(sourceIndex, dropHit.index);
    renderMeta();
    updatePreview();
  } else {
    renderMeta();
    if (state.previewRuntime?.drawTick) {
      state.previewRuntime.drawTick();
    }
  }

  state.canvasDrag = null;
  previewCanvas.style.cursor = 'default';
}

async function generateCombinedGif() {
  const encoderReady = await ensureGifEncoderReady();
  if (!encoderReady) {
    setStatus('GIF生成ライブラリの読み込みに失敗しました。診断ログを確認してください。', true);
    return;
  }

  if (!state.sources.length) {
    setStatus('先にGIFを読み込んでください。', true);
    return;
  }

  clearDownloadLink();

  const settings = getCurrentSettings();
  const metrics = getLayoutMetrics(state.sources, settings);
  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = metrics.width;
  outputCanvas.height = metrics.height;
  const outputCtx = outputCanvas.getContext('2d');

  const frameDelay = Math.max(10, Math.round(1000 / settings.fps));
  const maxDuration = Math.max(...state.sources.map((source) => source.durationMs));
  const totalFrames = Math.max(1, Math.ceil(maxDuration / frameDelay));

  const warningMessage = getResolutionWarningMessage(metrics, totalFrames);
  const columnsWarning = getColumnsLimitWarningMessage();
  if (columnsWarning) {
    setStatus(columnsWarning, true);
  }
  if (warningMessage) {
    setStatus(warningMessage, true);
  }

  setStatus(`最適化準備中... (0/${totalFrames})`);

  const optimizedFrames = [];
  let removedFrames = 0;

  for (let frameNumber = 0; frameNumber < totalFrames; frameNumber += 1) {
    const timeMs = frameNumber * frameDelay;

    paintBackground(outputCtx, metrics.width, metrics.height, settings.bgColor, settings.transparentBg, true);

    state.sources.forEach((source, idx) => {
      const frameIndex = findFrameIndexByTime(source, timeMs);
      const basePos = getItemBasePosition(idx, settings, metrics);
      drawFrameOnContext(
        outputCtx,
        source,
        frameIndex,
        basePos.x + (source.offsetX || 0),
        basePos.y + (source.offsetY || 0),
        metrics.drawScale
      );
    });

    const composite = outputCtx.getImageData(0, 0, metrics.width, metrics.height);

    if (optimizedFrames.length > 0 && areImageDataEqual(optimizedFrames[optimizedFrames.length - 1].imageData, composite)) {
      optimizedFrames[optimizedFrames.length - 1].delay += frameDelay;
      removedFrames += 1;
    } else {
      optimizedFrames.push({ imageData: composite, delay: frameDelay });
    }

    if (frameNumber % 5 === 0 || frameNumber === totalFrames - 1) {
      setStatus(`最適化中... (${frameNumber + 1}/${totalFrames})`);
    }
  }

  logDebug('フレーム最適化完了', {
    inputFrames: totalFrames,
    outputFrames: optimizedFrames.length,
    removedFrames
  });

  const workerScript = await resolveWorkerScriptUrl();
  if (!workerScript) {
    throw new Error('Workerスクリプトを準備できませんでした。ローカルサーバー（http://localhost）で開いて再実行してください。');
  }

  const GIFEncoder = window.GIF;
  const gif = new GIFEncoder({
    workers: 2,
    quality: GIF_QUALITY_FIXED,
    width: metrics.width,
    height: metrics.height,
    workerScript,
    transparent: settings.transparentBg ? GIF_TRANSPARENT_KEY_NUM : null
  });

  logDebug('GIFエンコーダ設定', {
    protocol: location.protocol,
    workers: 2,
    workerScript,
    transparentBg: settings.transparentBg,
    quality: GIF_QUALITY_FIXED
  });

  for (const frame of optimizedFrames) {
    outputCtx.putImageData(frame.imageData, 0, 0);
    gif.addFrame(outputCtx, { copy: true, delay: frame.delay });
  }

  const renderStartedAt = performance.now();
  const blob = await new Promise((resolve, reject) => {
    gif.on('progress', (progress) => {
      const percent = Math.round(progress * 100);
      const elapsedSec = (performance.now() - renderStartedAt) / 1000;
      const etaSec = progress > 0 ? Math.max(0, Math.round((elapsedSec * (1 - progress)) / progress)) : null;
      const etaText = etaSec === null ? '' : ` / 残り約${etaSec}秒`;
      setStatus(`出力GIFを生成中... ${percent}%${etaText}`);
    });
    gif.on('finished', resolve);
    gif.on('abort', () => reject(new Error('GIF生成が中断されました。')));
    gif.on('error', (error) => reject(error instanceof Error ? error : new Error(String(error))));
    gif.render();
  });

  state.outputUrl = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = state.outputUrl;
  link.download = 'combined.gif';
  link.textContent = '生成したGIFをダウンロード';

  downloadEl.innerHTML = '';
  downloadEl.appendChild(link);
  setStatus(`GIF生成が完了しました。最適化: ${removedFrames}フレーム削減`);
}

function loadPresetsFromStorage() {
  try {
    const raw = localStorage.getItem(PRESET_STORAGE_KEY);
    state.presets = raw ? JSON.parse(raw) : {};
  } catch {
    state.presets = {};
  }
}

function persistPresets() {
  localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(state.presets));
}

function refreshPresetSelect() {
  const names = Object.keys(state.presets).sort((a, b) => a.localeCompare(b, 'ja'));
  presetSelect.innerHTML = '<option value="">プリセットを選択</option>';

  names.forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    presetSelect.appendChild(option);
  });
}

function savePreset() {
  const name = (presetNameInput.value || '').trim();
  if (!name) {
    setStatus('プリセット名を入力してください。', true);
    return;
  }

  state.presets[name] = getCurrentSettings();
  persistPresets();
  refreshPresetSelect();
  presetSelect.value = name;
  setStatus(`プリセットを保存しました: ${name}`);
}

function loadPreset() {
  const name = presetSelect.value;
  if (!name || !state.presets[name]) {
    setStatus('読み込むプリセットを選択してください。', true);
    return;
  }

  applySettings(state.presets[name]);
  presetNameInput.value = name;
  scheduleAutoPreview();
  setStatus(`プリセットを読み込みました: ${name}`);
}

function deletePreset() {
  const name = presetSelect.value;
  if (!name || !state.presets[name]) {
    setStatus('削除するプリセットを選択してください。', true);
    return;
  }

  delete state.presets[name];
  persistPresets();
  refreshPresetSelect();
  setStatus(`プリセットを削除しました: ${name}`);
}

function bindSettingAutoPreview() {
  const inputs = [
    columnsInput,
    gapInput,
    bgInput,
    transparentBgInput,
    fixedSizeInput,
    canvasWidthInput,
    canvasHeightInput,
    fpsInput
  ];

  for (const input of inputs) {
    input.addEventListener('input', () => {
      syncControlEnabledStates();
      scheduleAutoPreview();
    });

    input.addEventListener('change', () => {
      syncControlEnabledStates();
      scheduleAutoPreview();
    });
  }
}

gifInput.addEventListener('change', async (event) => {
  try {
    const files = Array.from(event.target.files || []);
    logDebug('GIF読み込み開始', { fileCount: files.length, files: files.map((file) => file.name) });
    await loadGifs(files);
  } catch (error) {
    logDebug('読み込み例外', { message: error.message });
    setStatus(`読み込みエラー: ${error.message}`, true);
    generateBtn.disabled = true;
  }
});

previewBtn.addEventListener('click', () => {
  updatePreview();
});

previewCanvas.addEventListener('mousedown', handlePreviewMouseDown);
window.addEventListener('mousemove', handlePreviewMouseMove);
window.addEventListener('mouseup', handlePreviewMouseUp);

generateBtn.addEventListener('click', async () => {
  generateBtn.disabled = true;
  try {
    logDebug('GIF生成開始');
    await generateCombinedGif();
  } catch (error) {
    logDebug('生成例外', { message: error.message });
    setStatus(`生成エラー: ${error.message}`, true);
  } finally {
    generateBtn.disabled = false;
  }
});

savePresetBtn.addEventListener('click', savePreset);
loadPresetBtn.addEventListener('click', loadPreset);
deletePresetBtn.addEventListener('click', deletePreset);

window.addEventListener('error', (event) => {
  logDebug('window error', {
    message: event.message,
    source: event.filename,
    line: event.lineno,
    column: event.colno
  });
});

window.addEventListener('beforeunload', () => {
  stopPreviewAnimation();
  cleanupOutputUrl();
  cleanupWorkerBlobUrl();
});

(() => {
  syncControlEnabledStates();
  bindSettingAutoPreview();
  loadPresetsFromStorage();
  refreshPresetSelect();

  logDebug('アプリ初期化', {
    userAgent: navigator.userAgent,
    protocol: location.protocol,
    imageDecoder: ensureImageDecoderReady(),
    gifjsPrimary: GIFJS_PRIMARY
  });
})();
