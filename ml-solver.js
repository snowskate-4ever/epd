"use strict";

// MobileNetV2 ONNX inference for click-captcha ML-only solver.
// Requires ort.wasm.min.js loaded first (sets global `ort`).
// Exposes window.EPD_ML_SOLVER.

(function () {
  const ML_INPUT_SIZE = 224;
  const ML_EMBED_DIM = 1280;
  const ML_MEAN = [0.485, 0.456, 0.406];
  const ML_STD = [0.229, 0.224, 0.225];

  const ML_SCAN_STEP = 72;
  const ML_SCAN_REFINE_RADIUS = 10;
  const ML_SCAN_REFINE_STEP = 14;
  const ML_SCAN_TOP_COARSE = 3;
  const ML_EMBED_BATCH = 16;
  const ML_MODEL_CACHE_KEY = "mobilenetv2-icons-int8-v12";

  const IDB_NAME = "epd_ml_v1";
  const IDB_VER = 1;
  const IDB_STORE = "blobs";

  let _session = null;
  let _initPromise = null;
  let _initFailed = false;
  let _labels = null;
  let _embedQueue = Promise.resolve();
  let _mainCanvas = null;
  let _mainCanvasKey = "";
  let _patchCanvas = null;
  let _patchCtx = null;
  let _lbCanvas = null;
  let _lbCtx = null;
  let _lbTmpCanvas = null;
  let _lbTmpCtx = null;

  function _yieldUI() {
    return new Promise((r) => setTimeout(r, 0));
  }

  function _getUrl(path) {
    try {
      return chrome.runtime.getURL(path);
    } catch (_) {
      return path;
    }
  }

  function _idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VER);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = (e) => {
        if (!e.target.result.objectStoreNames.contains(IDB_STORE)) {
          e.target.result.createObjectStore(IDB_STORE);
        }
      };
    });
  }

  async function _idbGet(key) {
    try {
      const db = await _idbOpen();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readonly");
        const req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch (_) {
      return null;
    }
  }

  async function _idbSet(key, value) {
    try {
      const db = await _idbOpen();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (_) { /* ignore */ }
  }

  async function _idbDel(key) {
    try {
      const db = await _idbOpen();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (_) { /* ignore */ }
  }

  /** ONNX protobuf — reject HTML/404 bodies cached by mistake. */
  function _isValidOnnxBytes(buf) {
    if (!buf || buf.byteLength < 64 * 1024) return false;
    const head = new Uint8Array(buf, 0, Math.min(16, buf.byteLength));
    if (head[0] === 0x3c) return false; // '<' — HTML error page
    return true;
  }

  async function _fetchModelBytes(modelUrl) {
    const resp = await fetch(modelUrl);
    if (!resp.ok) throw new Error(`model fetch HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    if (!_isValidOnnxBytes(buf)) {
      throw new Error(`model file invalid (${buf.byteLength} bytes)`);
    }
    _idbSet(ML_MODEL_CACHE_KEY, buf).catch(() => null);
    return buf;
  }

  async function _loadModelBytes(modelUrl, allowCache = true) {
    if (allowCache) {
      const cached = await _idbGet(ML_MODEL_CACHE_KEY);
      if (cached && _isValidOnnxBytes(cached)) {
        console.log(`[EPD ML] model from IndexedDB cache (${(cached.byteLength / 1024).toFixed(0)}KB)`);
        return cached;
      }
      if (cached) {
        console.warn(`[EPD ML] stale cache (${cached.byteLength} bytes) — удаляем`);
        await _idbDel(ML_MODEL_CACHE_KEY);
      }
    }
    console.log("[EPD ML] fetching model from extension package...");
    return _fetchModelBytes(modelUrl);
  }

  async function _loadLabels() {
    if (_labels) return _labels;
    try {
      const resp = await fetch(_getUrl("models/labels.json"));
      _labels = await resp.json();
    } catch (_) {
      _labels = { inputSize: ML_INPUT_SIZE, embedDim: ML_EMBED_DIM, mean: ML_MEAN, std: ML_STD };
    }
    return _labels;
  }

  async function _createSession(modelBytes) {
    return ort.InferenceSession.create(modelBytes, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
  }

  async function mlClearCache() {
    await _idbDel(ML_MODEL_CACHE_KEY);
    _session = null;
    _initPromise = null;
    _initFailed = false;
    console.log("[EPD ML] cache cleared, call mlInit() to reload");
  }

  async function mlInit() {
    if (_session) return true;
    if (_initFailed) return false;
    if (_initPromise) return _initPromise;

    _initPromise = (async () => {
      try {
        if (typeof ort === "undefined") {
          throw new Error("onnxruntime-web (ort) not loaded");
        }
        await _loadLabels();
        const wasmBase = _getUrl("lib/ort/");
        ort.env.wasm.wasmPaths = {
          "ort-wasm-simd-threaded.wasm": _getUrl("lib/ort/ort-wasm-simd-threaded.wasm"),
          "ort-wasm-simd-threaded.mjs": _getUrl("lib/ort/ort-wasm-simd-threaded.mjs"),
          default: wasmBase,
        };
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.proxy = false;
        ort.env.wasm.simd = true;

        const modelUrl = _getUrl("models/mobilenetv2-icons-int8.onnx");
        const t0 = Date.now();
        let modelBytes = await _loadModelBytes(modelUrl);
        try {
          _session = await _createSession(modelBytes);
        } catch (parseErr) {
          console.warn("[EPD ML] session create failed, retry without cache:", parseErr.message);
          await _idbDel(ML_MODEL_CACHE_KEY);
          modelBytes = await _loadModelBytes(modelUrl, false);
          _session = await _createSession(modelBytes);
        }
        console.log(`[EPD ML] model loaded за ${Date.now() - t0}мс`);
        return true;
      } catch (e) {
        _initFailed = true;
        console.warn("[EPD ML] init failed:", e.message);
        console.warn("[EPD ML] убедитесь что models/mobilenetv2-icons-int8.onnx есть в расширении (python ml/run_pipeline.py --export-only)");
        return false;
      }
    })();
    return _initPromise;
  }

  function mlIsReady() {
    return !!_session;
  }

  function _letterbox224(img) {
    const size = ML_INPUT_SIZE;
    if (!_lbCanvas) {
      _lbCanvas = document.createElement("canvas");
      _lbCanvas.width = size;
      _lbCanvas.height = size;
      _lbCtx = _lbCanvas.getContext("2d", { willReadFrequently: true });
      _lbTmpCanvas = document.createElement("canvas");
      _lbTmpCtx = _lbTmpCanvas.getContext("2d", { willReadFrequently: true });
    }
    if (_lbTmpCanvas.width !== img.width || _lbTmpCanvas.height !== img.height) {
      _lbTmpCanvas.width = img.width;
      _lbTmpCanvas.height = img.height;
    }
    const ctx = _lbCtx;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, size, size);
    const scale = Math.min(size / img.width, size / img.height);
    const dw = Math.max(1, Math.round(img.width * scale));
    const dh = Math.max(1, Math.round(img.height * scale));
    const ox = Math.floor((size - dw) / 2);
    const oy = Math.floor((size - dh) / 2);
    _lbTmpCtx.putImageData(img, 0, 0);
    ctx.drawImage(_lbTmpCanvas, ox, oy, dw, dh);
    return ctx.getImageData(0, 0, size, size);
  }

  function _preprocess(img) {
    const lb = _letterbox224(img);
    const { data, width, height } = lb;
    const n = width * height;
    const out = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const r = data[o] / 255;
      const g = data[o + 1] / 255;
      const b = data[o + 2] / 255;
      out[i] = (r - ML_MEAN[0]) / ML_STD[0];
      out[n + i] = (g - ML_MEAN[1]) / ML_STD[1];
      out[2 * n + i] = (b - ML_MEAN[2]) / ML_STD[2];
    }
    return out;
  }

  function mlCosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    const d = Math.sqrt(na) * Math.sqrt(nb);
    return d < 1e-9 ? 0 : dot / d;
  }

  async function _runSession(input, shape) {
    const run = () => {
      const tensor = new ort.Tensor("float32", input, shape);
      return _session.run({ input: tensor });
    };
    const chained = _embedQueue.then(run, run);
    _embedQueue = chained.catch(() => null);
    const out = await chained;
    const key = Object.keys(out)[0];
    return out[key].data;
  }

  async function mlEmbed(imageData) {
    if (!_session || !imageData) return null;
    const input = _preprocess(imageData);
    const data = await _runSession(input, [1, 3, ML_INPUT_SIZE, ML_INPUT_SIZE]);
    return data;
  }

  /** Batch embed — tries NCHW batch, falls back to parallel singles. */
  async function mlEmbedBatch(imageDatas) {
    if (!_session || !imageDatas?.length) return [];
    if (imageDatas.length === 1) return [await mlEmbed(imageDatas[0])];

    const preprocessed = imageDatas.map(_preprocess);
    const n = preprocessed.length;
    const per = preprocessed[0].length;
    const flat = new Float32Array(n * per);
    for (let i = 0; i < n; i++) flat.set(preprocessed[i], i * per);

    try {
      const data = await _runSession(flat, [n, 3, ML_INPUT_SIZE, ML_INPUT_SIZE]);
      const results = [];
      for (let i = 0; i < n; i++) {
        results.push(data.slice(i * ML_EMBED_DIM, (i + 1) * ML_EMBED_DIM));
      }
      return results;
    } catch (_) {
      const chunks = [];
      for (let i = 0; i < n; i += ML_EMBED_BATCH) {
        const slice = imageDatas.slice(i, i + ML_EMBED_BATCH);
        chunks.push(Promise.all(slice.map((img) => mlEmbed(img))));
      }
      return (await Promise.all(chunks)).flat();
    }
  }

  function _ensureMainCanvas(mainImg) {
    const key = `${mainImg.width}x${mainImg.height}`;
    if (!_mainCanvas || _mainCanvasKey !== key) {
      _mainCanvas = document.createElement("canvas");
      _mainCanvas.width = mainImg.width;
      _mainCanvas.height = mainImg.height;
      _mainCanvas.getContext("2d", { willReadFrequently: true }).putImageData(mainImg, 0, 0);
      _mainCanvasKey = key;
    }
    return _mainCanvas;
  }

  function _ensurePatchCanvas(pw, ph) {
    if (!_patchCanvas || _patchCanvas.width !== pw || _patchCanvas.height !== ph) {
      _patchCanvas = document.createElement("canvas");
      _patchCanvas.width = pw;
      _patchCanvas.height = ph;
      _patchCtx = _patchCanvas.getContext("2d", { willReadFrequently: true });
    }
    return _patchCtx;
  }

  function mlCropPatch(mainImg, cx, cy, patchW, patchH) {
    const pw = Math.max(4, Math.round(patchW));
    const ph = Math.max(4, Math.round(patchH));
    let x0 = Math.round(cx - pw / 2);
    let y0 = Math.round(cy - ph / 2);
    x0 = Math.max(0, Math.min(mainImg.width - pw, x0));
    y0 = Math.max(0, Math.min(mainImg.height - ph, y0));

    const main = _ensureMainCanvas(mainImg);
    const ctx = _ensurePatchCanvas(pw, ph);
    ctx.drawImage(main, x0, y0, pw, ph, 0, 0, pw, ph);
    return ctx.getImageData(0, 0, pw, ph);
  }

  function _dedupePeaks(peaks, k, minDist) {
    const minDistSq = minDist * minDist;
    const picked = [];
    for (const p of peaks) {
      if (picked.length >= k) break;
      if (picked.some((q) => (p.x - q.x) ** 2 + (p.y - q.y) ** 2 < minDistSq)) continue;
      picked.push(p);
    }
    return picked;
  }

  async function _scoreGridPoints(mainImg, iconEmb, points, pw, ph, onProgress) {
    const peaks = [];
    const total = points.length;
    for (let i = 0; i < total; i += ML_EMBED_BATCH) {
      const chunk = points.slice(i, i + ML_EMBED_BATCH);
      const patches = chunk.map(({ cx, cy }) => mlCropPatch(mainImg, cx, cy, pw, ph));
      const embeddings = await mlEmbedBatch(patches);
      for (let j = 0; j < chunk.length; j++) {
        const emb = embeddings[j];
        if (!emb) continue;
        const mlScore = mlCosine(iconEmb, emb);
        peaks.push({
          x: Math.round(chunk[j].cx),
          y: Math.round(chunk[j].cy),
          conf: mlScore,
          mlScore,
          margin: 0,
        });
      }
      if (onProgress && i % (ML_EMBED_BATCH * 4) === 0) {
        onProgress(`grid ${Math.min(i + ML_EMBED_BATCH, total)}/${total}`);
      }
      if (i > 0 && i % (ML_EMBED_BATCH * 8) === 0) await _yieldUI();
    }
    peaks.sort((a, b) => b.mlScore - a.mlScore);
    return peaks;
  }

  function _gridPoints(mainImg, pw, ph, step) {
    const halfW = pw / 2;
    const halfH = ph / 2;
    const points = [];
    for (let cy = halfH; cy <= mainImg.height - halfH; cy += step) {
      for (let cx = halfW; cx <= mainImg.width - halfW; cx += step) {
        points.push({ cx, cy });
      }
    }
    return points;
  }

  /**
   * ML-only icon search: coarse grid + fine refine around top candidates.
   */
  async function mlScanIcon(mainImg, iconImg, patchW, patchH, k = 4, onProgress = null) {
    if (!_session) return [];
    const t0 = Date.now();
    const pw = Math.max(4, Math.round(patchW));
    const ph = Math.max(4, Math.round(patchH));
    onProgress?.("embed icon");
    const iconEmb = await mlEmbed(iconImg);
    if (!iconEmb) return [];
    await _yieldUI();

    const coarsePts = _gridPoints(mainImg, pw, ph, ML_SCAN_STEP);
    onProgress?.(`coarse ${coarsePts.length} pts`);
    const coarse = await _scoreGridPoints(mainImg, iconEmb, coarsePts, pw, ph, onProgress);
    const topCoarse = _dedupePeaks(coarse, ML_SCAN_TOP_COARSE, 28);

    const refinePts = [];
    const seen = new Set();
    for (const p of topCoarse) {
      for (let dy = -ML_SCAN_REFINE_RADIUS; dy <= ML_SCAN_REFINE_RADIUS; dy += ML_SCAN_REFINE_STEP) {
        for (let dx = -ML_SCAN_REFINE_RADIUS; dx <= ML_SCAN_REFINE_RADIUS; dx += ML_SCAN_REFINE_STEP) {
          const cx = p.x + dx;
          const cy = p.y + dy;
          const key = `${cx},${cy}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (cx < pw / 2 || cy < ph / 2 || cx > mainImg.width - pw / 2 || cy > mainImg.height - ph / 2) continue;
          refinePts.push({ cx, cy });
        }
      }
    }

    const refined = refinePts.length
      ? await _scoreGridPoints(mainImg, iconEmb, refinePts, pw, ph, onProgress)
      : [];
    const merged = _dedupePeaks([...refined, ...topCoarse], k, 35);
    const best = merged[0]?.mlScore ?? 0;
    console.log(`[EPD CLICK:ML] icon scan peaks=${merged.length} best_cos=${(best * 100).toFixed(0)}% за ${Date.now() - t0}мс`);
    return merged;
  }

  /** Sequential scan — не блокирует UI параллельным штормом. */
  async function mlScanIcons(mainImg, iconImgs, k = 4, onProgress = null) {
    const t0 = Date.now();
    const results = [];
    for (let i = 0; i < iconImgs.length; i++) {
      const icon = iconImgs[i];
      const prog = (msg) => onProgress?.(`icon ${i + 1}/${iconImgs.length}: ${msg}`);
      prog("start");
      results.push(await mlScanIcon(mainImg, icon, icon.width, icon.height, k, prog));
      await _yieldUI();
    }
    console.log(`[EPD CLICK:ML] all ${iconImgs.length} icons scanned за ${Date.now() - t0}мс`);
    return results;
  }

  /**
   * Batch ML refine for all icons — one ONNX pass for icons + one for patches.
   * items: [{ iconImg, peaks, patchW, patchH }]
   */
  async function mlRefineMultiIcon(mainImg, items, weights = {}) {
    const wNcc = weights.wNcc ?? 0.4;
    const wMl = weights.wMl ?? 0.6;
    if (!_session || !items?.length) {
      const cands = items?.length ? items.map((it) => it.peaks || []) : [];
      return { cands, iconEmbs: [], patchEmbCache: {} };
    }

    const t0 = Date.now();
    const active = items
      .map((it, idx) => ({ ...it, idx, peaks: it.peaks || [] }))
      .filter((it) => it.iconImg && it.peaks.length);

    if (!active.length) {
      return {
        cands: items.map((it) => it.peaks || []),
        iconEmbs: new Array(items.length).fill(null),
        patchEmbCache: {},
      };
    }

    const iconEmbs = await mlEmbedBatch(active.map((it) => it.iconImg));
    const patchJobs = [];
    for (let ai = 0; ai < active.length; ai++) {
      const it = active[ai];
      const pw = Math.max(4, Math.round(it.patchW));
      const ph = Math.max(4, Math.round(it.patchH));
      for (let pi = 0; pi < it.peaks.length; pi++) {
        const p = it.peaks[pi];
        patchJobs.push({
          ai,
          pi,
          patch: mlCropPatch(mainImg, p.x, p.y, pw, ph),
        });
      }
    }

    const patchEmbs = patchJobs.length
      ? await mlEmbedBatch(patchJobs.map((j) => j.patch))
      : [];

    const outByIdx = items.map((it) => (it.peaks || []).map((p) => ({ ...p })));
    const allIconEmbs = new Array(items.length).fill(null);
    const patchEmbCache = {};
    for (let ai = 0; ai < active.length; ai++) {
      allIconEmbs[active[ai].idx] = iconEmbs[ai];
    }
    for (let j = 0; j < patchJobs.length; j++) {
      const { ai, pi } = patchJobs[j];
      const idx = active[ai].idx;
      const src = active[ai].peaks[pi];
      const iconEmb = iconEmbs[ai];
      const patchEmb = patchEmbs[j];
      const mlScore = iconEmb && patchEmb ? mlCosine(iconEmb, patchEmb) : 0;
      const combined = wNcc * src.conf + wMl * mlScore;
      outByIdx[idx][pi] = {
        ...src,
        nccConf: src.conf,
        mlScore,
        combined,
        conf: combined,
      };
      if (patchEmb) patchEmbCache[`${idx}:${src.x}:${src.y}`] = patchEmb;
    }
    for (const arr of outByIdx) arr.sort((a, b) => b.conf - a.conf);

    const hybridTag = wNcc > 0 ? ` hybrid ${(wNcc * 100).toFixed(0)}/${(wMl * 100).toFixed(0)}` : "";
    const bestDbg = active.map((it) => {
      const top = outByIdx[it.idx]?.[0];
      if (!top) return "?";
      return `ncc=${((top.nccConf ?? top.conf) * 100).toFixed(0)} ml=${((top.mlScore ?? 0) * 100).toFixed(0)} comb=${(top.conf * 100).toFixed(0)}`;
    }).join(" | ");
    console.log(
      `[EPD CLICK:ML] multi-refine ${active.length} icons, ${patchJobs.length} patches${hybridTag} за ${Date.now() - t0}мс`,
    );
    if (wNcc > 0 && bestDbg) console.log(`[EPD CLICK:ML] best peaks: ${bestDbg}`);
    return { cands: outByIdx, iconEmbs: allIconEmbs, patchEmbCache };
  }

  function _mlPeakAt(cands, i, x, y) {
    const list = cands?.[i];
    if (!list?.length) return null;
    return list.find((p) => p.x === x && p.y === y)
      || list.find((p) => (p.x - x) ** 2 + (p.y - y) ** 2 <= 64);
  }

  /**
   * Full icon×pool cosine matrix for Hungarian assignment.
   * Reuses icon/patch embeddings from mlRefineMultiIcon when provided in opts.
   */
  async function mlScorePoolMatrix(mainImg, iconImgs, pool, patchSizes, opts = {}) {
    if (!_session || !mainImg || !iconImgs?.length || !pool?.length) return null;
    const t0 = Date.now();
    const n = iconImgs.length;
    const m = pool.length;
    const cands = opts.cands;

    const hasIconCache = opts.iconEmbs?.length === n && opts.iconEmbs.some(Boolean);
    const iconEmbs = hasIconCache ? opts.iconEmbs : await mlEmbedBatch(iconImgs);
    if (!iconEmbs?.length) return null;

    const score = Array.from({ length: n }, () => new Array(m).fill(0));
    const patchJobs = [];
    let fromPeak = 0;
    let fromPatchCache = 0;

    for (let i = 0; i < n; i++) {
      const pw = Math.max(4, Math.round(patchSizes[i]?.w ?? patchSizes[i]?.patchW ?? 32));
      const ph = Math.max(4, Math.round(patchSizes[i]?.h ?? patchSizes[i]?.patchH ?? 32));
      for (let j = 0; j < m; j++) {
        const px = pool[j].x;
        const py = pool[j].y;
        const peak = _mlPeakAt(cands, i, px, py);
        if (peak?.mlScore != null) {
          score[i][j] = peak.mlScore;
          fromPeak++;
          continue;
        }
        const cacheKey = `${i}:${px}:${py}`;
        const cachedPatch = opts.patchEmbCache?.[cacheKey];
        if (cachedPatch && iconEmbs[i]) {
          score[i][j] = mlCosine(iconEmbs[i], cachedPatch);
          fromPatchCache++;
          continue;
        }
        patchJobs.push({
          i,
          j,
          patch: mlCropPatch(mainImg, px, py, pw, ph),
        });
      }
    }

    if (patchJobs.length) {
      const patchEmbs = await mlEmbedBatch(patchJobs.map((job) => job.patch));
      for (let k = 0; k < patchJobs.length; k++) {
        const { i, j } = patchJobs[k];
        score[i][j] = iconEmbs[i] && patchEmbs[k] ? mlCosine(iconEmbs[i], patchEmbs[k]) : 0;
      }
    }

    const totalCells = n * m;
    console.log(
      `[EPD CLICK:ML] pool matrix ${n}×${m}: ${patchJobs.length} embed, ${fromPeak} refine, ${fromPatchCache} cache` +
      `${hasIconCache ? ", icons cached" : ""} за ${Date.now() - t0}мс`,
    );
    if (fromPeak + fromPatchCache + patchJobs.length !== totalCells) {
      console.warn(`[EPD CLICK:ML] pool matrix cell mismatch: ${fromPeak}+${fromPatchCache}+${patchJobs.length} != ${totalCells}`);
    }
    return score;
  }

  /** Refine NCC peaks with MobileNet (kept for hybrid path). */
  async function mlRefinePeaks(mainImg, iconImg, peaks, patchW, patchH, weights = {}) {
    const wNcc = weights.wNcc ?? 0.4;
    const wMl = weights.wMl ?? 0.6;
    if (!_session || !peaks?.length) return peaks;

    const t0 = Date.now();
    const iconEmb = await mlEmbed(iconImg);
    if (!iconEmb) return peaks;

    const patches = peaks.map((p) => mlCropPatch(mainImg, p.x, p.y, patchW, patchH));
    const patchEmbs = await mlEmbedBatch(patches);

    const refined = peaks.map((p, i) => {
      const patchEmb = patchEmbs[i];
      const mlScore = patchEmb ? mlCosine(iconEmb, patchEmb) : 0;
      const combined = wNcc * p.conf + wMl * mlScore;
      return { ...p, mlScore, combined, conf: combined };
    });
    refined.sort((a, b) => b.combined - a.combined);
    console.log(`[EPD CLICK:ML] peaks=${peaks.length} best_cos=${(refined[0]?.mlScore * 100 || 0).toFixed(0)}% combined=${(refined[0]?.combined * 100 || 0).toFixed(0)}% за ${Date.now() - t0}мс`);
    return refined;
  }

  window.EPD_ML_SOLVER = {
    mlInit,
    mlClearCache,
    mlIsReady,
    mlEmbed,
    mlEmbedBatch,
    mlCosine,
    mlCropPatch,
    mlRefinePeaks,
    mlRefineMultiIcon,
    mlScorePoolMatrix,
    mlScanIcon,
    mlScanIcons,
    ML_INPUT_SIZE,
    ML_EMBED_DIM,
  };

  setTimeout(() => mlInit().catch(() => null), 0);
})();
