/* Standalone NCC solver — captcha/ncc-preview.html */
(function () {
"use strict";

const NCC_RACE_CONF = 0.42;
const NCC_PER_ICON_MIN = 0.38;
const NCC_DEFER_MIN = 0.38;
const NCC_DEFER_FLOOR = 0.38;
const NCC_DEFER_AVG_STRICT = 0.45;
const NCC_Y_DUP_PX = 15;
const NCC_X_DUP_PX = 15;
const NCC_HP_RADIUS = 8;
const NCC_PEAK_MARGIN = 0.08;
const NCC_NEAR_DUP_PX = 20;
const NCC_MASK_RADIUS = 35;
const NCC_FAST = true;
const NCC_SCALES = [1, 2, 4];
const NCC_SCALES_FAST = [1, 2, 4];
const NCC_COARSE_STEP = 6;
const NCC_COARSE_STEP_FAST = 8;
const NCC_MID_STEP = 2;
const NCC_FINE_STEP = 1;
const NCC_REFINE_R = 14;
const NCC_PEAKS_PER_ICON = 6;
const NCC_PEAK_STEP_FAST = 4;
const NCC_COARSE_PEAK_MULT = 3;
const NCC_FINE_RADIUS = 5;
const NCC_SEQ_MASK = false;
const NCC_POOL_FACTOR = 5;
const NCC_TOPK_SEARCH = 4;
const ML_TRAINING_MODE = false;
const BG_REMOVE_ENABLED = false;
const ML_ENABLED = false;
const ML_HUNGARIAN_ASSIGN = false;

function _decodeImg(b64) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, c.width, c.height));
    };
    img.onerror = () => resolve(null);
    img.src = "data:image/jpeg;base64," + b64;
  });
}

function _nccPeakScanTag() {
  const mode = NCC_SEQ_MASK ? "seq" : "indep";
  return NCC_FAST ? `fast+${mode}` : `full+${mode}`;
}
function _nccActiveScales() { return NCC_FAST ? NCC_SCALES_FAST : NCC_SCALES; }
function _nccCoarseStep() { return NCC_FAST ? NCC_COARSE_STEP_FAST : NCC_COARSE_STEP; }
function _nccPeakStep() { return NCC_FAST ? NCC_PEAK_STEP_FAST : NCC_COARSE_STEP; }

function _buildHighPass(g, width, height, r = NCC_HP_RADIUS) {
  const hp = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0, cnt = 0;
      for (let dy = -r; dy <= r; dy += 2) {
        for (let dx = -r; dx <= r; dx += 2) {
          const yy = y + dy, xx = x + dx;
          if (yy >= 0 && yy < height && xx >= 0 && xx < width) {
            sum += g[yy * width + xx];
            cnt++;
          }
        }
      }
      hp[y * width + x] = g[y * width + x] - sum / cnt;
    }
  }
  return hp;
}

function _buildEdgeChannel(g, width, height) {
  const e = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx = g[i + 1] - g[i - 1];
      const gy = g[i + width] - g[i - width];
      e[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return e;
}

function _toClickChannels(imgData) {
  const { data, width, height } = imgData;
  const n = width * height;
  const s = new Float32Array(n);
  const h = new Float32Array(n);
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = data[o] / 255, gv = data[o + 1] / 255, b = data[o + 2] / 255;
    g[i] = r * 0.299 + gv * 0.587 + b * 0.114;
    const max = Math.max(r, gv, b), min = Math.min(r, gv, b);
    const d = max - min;
    s[i] = d;
    if (d < 0.04) { h[i] = 0; continue; }
    let hue;
    if (max === r) hue = (gv - b) / d + (gv < b ? 6 : 0);
    else if (max === gv) hue = (b - r) / d + 2;
    else hue = (r - gv) / d + 4;
    h[i] = hue / 6;
  }
  const e = _buildEdgeChannel(g, width, height);
  const hp = _buildHighPass(g, width, height);
  return { s, h, g, e, hp, width, height };
}

function _toGrayClick(imgData) {
  const { data, width, height } = imgData;
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    gray[i] = data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114;
  }
  return { gray, width, height };
}

function _removeMainBackground(mainImg) {
  if (!BG_REMOVE_ENABLED || !window.EPD_BG_REMOVE?.removeBackground) return mainImg;
  return window.EPD_BG_REMOVE.removeBackground(mainImg).imageData;
}

/** Open before/after BG removal preview (debug). */
function _epdPreviewBgRemoved(front) {
  if (!front?.imageBase64 || !window.EPD_BG_REMOVE) return;
  _decodeImg(front.imageBase64).then((mainImg) => {
    if (!mainImg) return;
    const clean = _removeMainBackground(mainImg);
    const w = window.open("", "_blank", "width=920,height=520");
    if (!w) return;
    const origUrl = window.EPD_BG_REMOVE.imageDataToDataUrl(mainImg);
    const cleanUrl = window.EPD_BG_REMOVE.imageDataToDataUrl(clean);
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>EPD BG preview</title>
<style>body{margin:0;background:#111;color:#ddd;font:13px sans-serif}
.row{display:flex;gap:12px;padding:12px;align-items:flex-start}
.col{flex:1;text-align:center} img{max-width:100%;border:1px solid #444;border-radius:4px}
h3{margin:0 0 8px;font-size:14px}</style></head><body>
<div class="row"><div class="col"><h3>Оригинал</h3><img src="${origUrl}"></div>
<div class="col"><h3>Белый фон / чёрные иконки</h3><img src="${cleanUrl}"></div></div>
<p style="padding:0 12px 12px;color:#888">Иконки — чёрные контуры на белом фоне.</p>
</body></html>`);
    w.document.close();
  });
}

function _splitIconChannels(strip, count, stripImg) {
  const { s, h, g, e, hp, width, height } = strip;
  const slices = stripImg && window.EPD_BG_REMOVE?.getStripIconSlices
    ? window.EPD_BG_REMOVE.getStripIconSlices(stripImg, count)
    : null;
  if (slices?.length === count) {
    const icons = [];
    for (const sl of slices) {
      const w = sl.x1 - sl.x0 + 1;
      const icS = new Float32Array(w * height);
      const icH = new Float32Array(w * height);
      const icG = new Float32Array(w * height);
      const icE = new Float32Array(w * height);
      const icHp = new Float32Array(w * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < w; x++) {
          const si = y * width + sl.x0 + x;
          const di = y * w + x;
          icS[di] = s[si];
          icH[di] = h[si];
          icG[di] = g[si];
          icE[di] = e[si];
          icHp[di] = hp[si];
        }
      }
      icons.push(_trimIconChannels({ s: icS, h: icH, g: icG, e: icE, hp: icHp, width: w, height }));
    }
    return icons;
  }
  const iconW = Math.round(width / count);
  const icons = [];
  for (let i = 0; i < count; i++) {
    const x0 = Math.round(i * iconW), w = Math.min(iconW, width - x0);
    const icS = new Float32Array(w * height);
    const icH = new Float32Array(w * height);
    const icG = new Float32Array(w * height);
    const icE = new Float32Array(w * height);
    const icHp = new Float32Array(w * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < w; x++) {
        const si = y * width + x0 + x, di = y * w + x;
        icS[di] = s[si];
        icH[di] = h[si];
        icG[di] = g[si];
        icE[di] = e[si];
        icHp[di] = hp[si];
      }
    }
    icons.push(_trimIconChannels({ s: icS, h: icH, g: icG, e: icE, hp: icHp, width: w, height }));
  }
  return icons;
}

/** Crop strip icon to content bbox — strip cells have padding that skews match size. */
function _trimIconChannels(icon) {
  const { s, h, g, e, hp, width, height } = icon;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (g[i] > 0.03 || s[i] > 0.035 || e[i] > 0.015 || Math.abs(hp[i]) > 0.02) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < x0 || y1 < y0) return icon;
  x0 = Math.max(0, x0 - 1);
  y0 = Math.max(0, y0 - 1);
  x1 = Math.min(width - 1, x1 + 1);
  y1 = Math.min(height - 1, y1 + 1);
  const nw = x1 - x0 + 1, nh = y1 - y0 + 1;
  if (nw < 4 || nh < 4 || (nw === width && nh === height)) return icon;
  const out = (ch) => {
    const arr = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++)
      for (let x = 0; x < nw; x++)
        arr[y * nw + x] = ch[(y0 + y) * width + (x0 + x)];
    return arr;
  };
  return { s: out(s), h: out(h), g: out(g), e: out(e), hp: out(hp), width: nw, height: nh };
}

function _trimIconImage(iconImg) {
  const { data, width, height } = iconImg;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const gray = r * 0.299 + g * 0.587 + b * 0.114;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const sat = max - min;
      if (gray > 0.03 || sat > 0.035) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < x0 || y1 < y0) return iconImg;
  x0 = Math.max(0, x0 - 1);
  y0 = Math.max(0, y0 - 1);
  x1 = Math.min(width - 1, x1 + 1);
  y1 = Math.min(height - 1, y1 + 1);
  const nw = x1 - x0 + 1, nh = y1 - y0 + 1;
  if (nw < 4 || nh < 4 || (nw === width && nh === height)) return iconImg;
  const canvas = document.createElement("canvas");
  canvas.width = nw;
  canvas.height = nh;
  const ctx = canvas.getContext("2d");
  const tmp = document.createElement("canvas");
  tmp.width = width;
  tmp.height = height;
  tmp.getContext("2d").putImageData(iconImg, 0, 0);
  ctx.drawImage(tmp, x0, y0, nw, nh, 0, 0, nw, nh);
  return ctx.getImageData(0, 0, nw, nh);
}

function _splitIconImages(stripImg, count) {
  const norm = window.EPD_BG_REMOVE?.normalizeStripBlackOnWhite
    ? window.EPD_BG_REMOVE.normalizeStripBlackOnWhite(stripImg)
    : stripImg;
  const slices = window.EPD_BG_REMOVE?.getStripIconSlices?.(stripImg, count);
  if (slices?.length === count) {
    const tmp = document.createElement("canvas");
    tmp.width = norm.width;
    tmp.height = norm.height;
    tmp.getContext("2d").putImageData(norm, 0, 0);
    const icons = [];
    for (const sl of slices) {
      const w = sl.x1 - sl.x0 + 1;
      const h = sl.y1 - sl.y0 + 1;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(tmp, sl.x0, sl.y0, w, h, 0, 0, w, h);
      icons.push(_trimIconImage(canvas.getContext("2d").getImageData(0, 0, w, h)));
    }
    return icons;
  }
  const iconW = Math.round(stripImg.width / count);
  const icons = [];
  const tmp = document.createElement("canvas");
  tmp.width = norm.width;
  tmp.height = norm.height;
  tmp.getContext("2d").putImageData(norm, 0, 0);
  for (let i = 0; i < count; i++) {
    const x0 = Math.round(i * iconW);
    const w = Math.min(iconW, stripImg.width - x0);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = stripImg.height;
    canvas.getContext("2d").drawImage(tmp, x0, 0, w, stripImg.height, 0, 0, w, stripImg.height);
    icons.push(_trimIconImage(canvas.getContext("2d").getImageData(0, 0, w, stripImg.height)));
  }
  return icons;
}

function _mlWeights() {
  return { wNcc: ML_W_NCC, wMl: ML_W_ML };
}

async function _mlRefinePeaksIfReady(mainImg, iconImg, peaks, patchW, patchH) {
  if (!ML_ENABLED || !peaks?.length || !window.EPD_ML_SOLVER?.mlIsReady()) return peaks;
  return window.EPD_ML_SOLVER.mlRefinePeaks(mainImg, iconImg, peaks, patchW, patchH, _mlWeights());
}

function _nccScaleTpl(tpl, tW, tH) {
  let out;
  if (tpl.width === tW && tpl.height === tH) {
    out = tpl;
  } else {
    out = {
      s: _resizeChannel(tpl.s, tpl.width, tpl.height, tW, tH),
      h: _resizeChannel(tpl.h, tpl.width, tpl.height, tW, tH),
      g: _resizeChannel(tpl.g, tpl.width, tpl.height, tW, tH),
      e: _resizeChannel(tpl.e, tpl.width, tpl.height, tW, tH),
      hp: _resizeChannel(tpl.hp, tpl.width, tpl.height, tW, tH),
      width: tW,
      height: tH,
    };
  }
  if (!out.mask || out.width !== tW || out.height !== tH) {
    out = { ...out, mask: _nccBuildTplMask(out, tW, tH) };
  }
  return out;
}

function _nccBuildTplMask(tpl, tW, tH) {
  const mask = new Float32Array(tW * tH);
  const { g, s, e, hp } = tpl;
  for (let i = 0; i < tW * tH; i++) {
    if (g[i] > 0.03 || s[i] > 0.035 || e[i] > 0.015 || Math.abs(hp[i]) > 0.02) mask[i] = 1;
  }
  return mask;
}

function _nccChannelAtMasked(srcG, sW, tplG, tplMask, tW, tH, sx, sy) {
  let cnt = 0;
  let tM = 0;
  for (let ty = 0; ty < tH; ty++) {
    for (let tx = 0; tx < tW; tx++) {
      if (tplMask[ty * tW + tx] < 0.5) continue;
      tM += tplG[ty * tW + tx];
      cnt++;
    }
  }
  if (cnt < 4) return _nccChannelAt(srcG, sW, tplG, tW, tH, sx, sy);

  tM /= cnt;
  let tVar = 0;
  for (let ty = 0; ty < tH; ty++) {
    for (let tx = 0; tx < tW; tx++) {
      if (tplMask[ty * tW + tx] < 0.5) continue;
      const tv = tplG[ty * tW + tx] - tM;
      tVar += tv * tv;
    }
  }
  tVar = Math.sqrt(tVar);
  if (tVar < 0.01) return 0;

  let sM = 0;
  for (let ty = 0; ty < tH; ty++) {
    for (let tx = 0; tx < tW; tx++) {
      if (tplMask[ty * tW + tx] < 0.5) continue;
      sM += srcG[(sy + ty) * sW + sx + tx];
    }
  }
  sM /= cnt;

  let num = 0;
  let sVar = 0;
  for (let ty = 0; ty < tH; ty++) {
    for (let tx = 0; tx < tW; tx++) {
      if (tplMask[ty * tW + tx] < 0.5) continue;
      const sv = srcG[(sy + ty) * sW + sx + tx] - sM;
      const tv = tplG[ty * tW + tx] - tM;
      num += sv * tv;
      sVar += sv * sv;
    }
  }
  sVar = Math.sqrt(sVar);
  return sVar > 0.01 ? num / (sVar * tVar) : 0;
}

function _nccCorrAt(srcCh, sW, tplCh, tplMask, tW, tH, sx, sy) {
  return tplMask
    ? _nccChannelAtMasked(srcCh, sW, tplCh, tplMask, tW, tH, sx, sy)
    : _nccChannelAt(srcCh, sW, tplCh, tW, tH, sx, sy);
}

function _resizeChannel(ch, w, h, nw, nh) {
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      out[y * nw + x] = ch[Math.min(h - 1, Math.round(y * h / nh)) * w + Math.min(w - 1, Math.round(x * w / nw))];
    }
  }
  return out;
}

function _nccChannelAt(srcG, sW, tplG, tW, tH, sx, sy) {
  const tN = tW * tH;
  let tM = 0;
  for (let i = 0; i < tN; i++) tM += tplG[i];
  tM /= tN;
  let tVar = 0;
  for (let i = 0; i < tN; i++) tVar += (tplG[i] - tM) ** 2;
  tVar = Math.sqrt(tVar);
  if (tVar < 0.01) return 0;

  let sM = 0;
  for (let ty = 0; ty < tH; ty++)
    for (let tx = 0; tx < tW; tx++)
      sM += srcG[(sy + ty) * sW + sx + tx];
  sM /= tN;
  let num = 0, sVar = 0;
  for (let ty = 0; ty < tH; ty++) {
    for (let tx = 0; tx < tW; tx++) {
      const sv = srcG[(sy + ty) * sW + sx + tx] - sM;
      const tv = tplG[ty * tW + tx] - tM;
      num += sv * tv;
      sVar += sv * sv;
    }
  }
  sVar = Math.sqrt(sVar);
  return sVar > 0.01 ? num / (sVar * tVar) : 0;
}

function _nccTooClose(cx, cy, used) {
  const minSq = NCC_MASK_RADIUS * NCC_MASK_RADIUS;
  for (const p of used) {
    const dx = cx - p.x, dy = cy - p.y;
    if (dx * dx + dy * dy < minSq) return true;
  }
  return false;
}

function _nccRefineCentroid(srcS, srcG, srcE, sW, bx, by, tW, tH) {
  let sumSat = 0, maxE = 0;
  const tN = tW * tH;
  for (let ty = 0; ty < tH; ty++) {
    for (let tx = 0; tx < tW; tx++) {
      const i = (by + ty) * sW + bx + tx;
      sumSat += srcS[i];
      if (srcE[i] > maxE) maxE = srcE[i];
    }
  }
  const avgSat = sumSat / tN;
  let sumX = 0, sumY = 0, sumW = 0;
  const eThr = Math.max(0.008, maxE * 0.35);
  for (let ty = 0; ty < tH; ty++) {
    for (let tx = 0; tx < tW; tx++) {
      const i = (by + ty) * sW + bx + tx;
      const w = avgSat >= 0.06
        ? srcS[i]
        : Math.max(srcG[i], srcE[i] / (eThr || 1) * 0.12);
      if (avgSat >= 0.06 ? w >= 0.06 : (srcE[i] >= eThr || srcG[i] >= 0.04)) {
        sumX += (bx + tx) * w;
        sumY += (by + ty) * w;
        sumW += w;
      }
    }
  }
  if (sumW > 0) return { x: Math.round(sumX / sumW), y: Math.round(sumY / sumW) };
  return { x: bx + Math.round(tW / 2), y: by + Math.round(tH / 2) };
}

function _nccScorePatch(src, tplS, tplH, tplG, tplE, tplHp, tW, tH, sx, sy, fine = false, tplMask = null) {
  const corrG = _nccCorrAt(src.g, src.width, tplG, tplMask, tW, tH, sx, sy);
  const corrHp = _nccCorrAt(src.hp, src.width, tplHp, tplMask, tW, tH, sx, sy);
  if (NCC_FAST && !fine) {
    const corrS = _nccCorrAt(src.s, src.width, tplS, tplMask, tW, tH, sx, sy);
    const base = Math.max(corrG, Math.abs(corrHp));
    return 0.85 * base + 0.15 * Math.max(0, corrS);
  }
  if (NCC_FAST && fine) {
    const corrE = _nccCorrAt(src.e, src.width, tplE, tplMask, tW, tH, sx, sy);
    const corrS = _nccCorrAt(src.s, src.width, tplS, tplMask, tW, tH, sx, sy);
    return 0.45 * corrG + 0.25 * Math.abs(corrHp) + 0.2 * corrE + 0.1 * corrS;
  }
  const corrE = _nccCorrAt(src.e, src.width, tplE, tplMask, tW, tH, sx, sy);
  const corrS = _nccCorrAt(src.s, src.width, tplS, tplMask, tW, tH, sx, sy);
  const corrH = _nccCorrAt(src.h, src.width, tplH, tplMask, tW, tH, sx, sy);
  const color = corrS * 0.65 + corrH * 0.35;
  return Math.max(color, corrG, corrE, Math.abs(corrHp));
}

function _nccScoreFine(step) {
  return step <= NCC_MID_STEP;
}

function _nccScanBox(src, tplS, tplH, tplG, tplE, tplHp, sW, sH, tW, tH, used, x0, y0, x1, y1, step, tplMask = null) {
  let lbest = -1, lbx = x0, lby = y0;
  for (let sy = y0; sy <= y1; sy += step) {
    for (let sx = x0; sx <= x1; sx += step) {
      const cx = sx + (tW >> 1), cy = sy + (tH >> 1);
      if (_nccTooClose(cx, cy, used)) continue;
      const sc = _nccScorePatch(src, tplS, tplH, tplG, tplE, tplHp, tW, tH, sx, sy, _nccScoreFine(step), tplMask);
      if (sc > lbest) { lbest = sc; lbx = sx; lby = sy; }
    }
  }
  return { lbest, lbx, lby };
}

/** Top-K distinct peaks in a scan box (for margin + weak-icon 2nd peak). */
function _nccScanPeaks(src, tplS, tplH, tplG, tplE, tplHp, sW, sH, tW, tH, used, x0, y0, x1, y1, step, k = 2, tplMask = null) {
  const raw = [];
  for (let sy = y0; sy <= y1; sy += step) {
    for (let sx = x0; sx <= x1; sx += step) {
      const cx = sx + (tW >> 1), cy = sy + (tH >> 1);
      if (_nccTooClose(cx, cy, used)) continue;
      const sc = _nccScorePatch(src, tplS, tplH, tplG, tplE, tplHp, tW, tH, sx, sy, _nccScoreFine(step), tplMask);
      raw.push({ sc, lbx: sx, lby: sy, cx, cy });
    }
  }
  raw.sort((a, b) => b.sc - a.sc);
  const picked = [];
  const minDistSq = 20 * 20;
  for (const p of raw) {
    if (picked.length >= k) break;
    if (picked.some(q => (p.cx - q.cx) ** 2 + (p.cy - q.cy) ** 2 < minDistSq)) continue;
    picked.push(p);
  }
  return picked;
}

function _nccApplyPeakMargin(rawConf, secondConf) {
  const second = secondConf ?? 0;
  const margin = Math.max(0, rawConf - second);
  if (margin >= NCC_PEAK_MARGIN) return { conf: rawConf, margin };
  const penalty = NCC_PEAK_MARGIN - margin;
  return { conf: Math.max(0, rawConf - penalty), margin };
}

function _nccRaceReady(confs) {
  if (!confs.length) return false;
  const min = Math.min(...confs);
  if (min < NCC_RACE_CONF) return false;
  return confs.every(c => c >= NCC_PER_ICON_MIN);
}

/** Defer: min≥38%, avg≥45%, y-spread OK. */
function _nccDeferReady(confs, avgConf, yOk) {
  if (!confs.length || !yOk) return false;
  const min = Math.min(...confs);
  if (min < NCC_DEFER_MIN) return false;
  if (avgConf < NCC_DEFER_AVG_STRICT) return false;
  return true;
}

/** SSD shift ±3px on gray+edge, then centroid. */
function _nccSsdRefine(src, tplG, tplE, sW, sH, bx, by, tW, tH) {
  let bestBx = bx, bestBy = by, bestCost = Infinity;
  for (let sy = Math.max(0, by - 3); sy <= Math.min(sH - tH, by + 3); sy++) {
    for (let sx = Math.max(0, bx - 3); sx <= Math.min(sW - tW, bx + 3); sx++) {
      let ssd = 0;
      for (let ty = 0; ty < tH; ty++) {
        for (let tx = 0; tx < tW; tx++) {
          const si = (sy + ty) * sW + sx + tx;
          const ti = ty * tW + tx;
          const dg = src.g[si] - tplG[ti];
          const de = src.e[si] - tplE[ti];
          ssd += dg * dg + de * de * 0.5;
        }
      }
      if (ssd < bestCost) { bestCost = ssd; bestBx = sx; bestBy = sy; }
    }
  }
  return _nccRefineCentroid(src.s, src.g, src.e, sW, bestBx, bestBy, tW, tH);
}

function _nccBestScaleMatch(src, tpl) {
  const sW = src.width, sH = src.height;
  const empty = [];
  let best = -1, bTW = tpl.width, bTH = tpl.height;
  let winTpl = null;

  for (const scale of _nccActiveScales()) {
    const tW = Math.max(4, Math.round(tpl.width * scale));
    const tH = Math.max(4, Math.round(tpl.height * scale));
    if (tW > sW || tH > sH) continue;
    const tplSc = _nccScaleTpl(tpl, tW, tH);

    const coarse = _nccScanBox(src, tplSc.s, tplSc.h, tplSc.g, tplSc.e, tplSc.hp, sW, sH, tW, tH, empty,
      0, 0, sW - tW, sH - tH, _nccCoarseStep(), tplSc.mask);
    let { lbest, lbx, lby } = coarse;

    const mid = _nccScanBox(src, tplSc.s, tplSc.h, tplSc.g, tplSc.e, tplSc.hp, sW, sH, tW, tH, empty,
      Math.max(0, lbx - NCC_REFINE_R), Math.max(0, lby - NCC_REFINE_R),
      Math.min(sW - tW, lbx + NCC_REFINE_R), Math.min(sH - tH, lby + NCC_REFINE_R), NCC_MID_STEP, tplSc.mask);
    if (mid.lbest > lbest) { lbest = mid.lbest; lbx = mid.lbx; lby = mid.lby; }

    if (lbest > best) {
      best = lbest;
      bTW = tW; bTH = tH;
      winTpl = tplSc;
    }
  }
  if (!winTpl) return null;
  return {
    sW, sH, bTW, bTH,
    winTplS: winTpl.s, winTplH: winTpl.h, winTplG: winTpl.g, winTplE: winTpl.e, winTplHp: winTpl.hp,
    winTplMask: winTpl.mask,
  };
}

/** Top-K peaks for one icon (no sequential mask — used for global assign). */
function _nccFindTopPeaks(src, tpl, k = NCC_PEAKS_PER_ICON, cachedMatch = null, used = []) {
  const match = cachedMatch || _nccBestScaleMatch(src, tpl);
  if (!match) return [];
  const { sW, sH, bTW, bTH, winTplS, winTplH, winTplG, winTplE, winTplHp, winTplMask } = match;

  const coarsePeaks = _nccScanPeaks(src, winTplS, winTplH, winTplG, winTplE, winTplHp, sW, sH, bTW, bTH, used,
    0, 0, sW - bTW, sH - bTH, _nccPeakStep(), k * NCC_COARSE_PEAK_MULT, winTplMask);

  const refinedRaw = [];
  for (const p of coarsePeaks) {
    const fine = _nccScanBox(src, winTplS, winTplH, winTplG, winTplE, winTplHp, sW, sH, bTW, bTH, used,
      Math.max(0, p.lbx - NCC_FINE_RADIUS), Math.max(0, p.lby - NCC_FINE_RADIUS),
      Math.min(sW - bTW, p.lbx + NCC_FINE_RADIUS), Math.min(sH - bTH, p.lby + NCC_FINE_RADIUS), NCC_FINE_STEP, winTplMask);
    const pt = _nccSsdRefine(src, winTplG, winTplE, sW, sH, fine.lbx, fine.lby, bTW, bTH);
    refinedRaw.push({ x: pt.x, y: pt.y, rawConf: fine.lbest });
  }
  refinedRaw.sort((a, b) => b.rawConf - a.rawConf);

  const refined = [];
  for (let i = 0; i < refinedRaw.length; i++) {
    const second = refinedRaw[i + 1]?.rawConf ?? 0;
    const { conf, margin } = _nccApplyPeakMargin(refinedRaw[i].rawConf, second);
    refined.push({ x: refinedRaw[i].x, y: refinedRaw[i].y, conf, margin, rawConf: refinedRaw[i].rawConf });
  }

  refined.sort((a, b) => b.conf - a.conf);
  const picked = [];
  const minDistSq = NCC_MASK_RADIUS * NCC_MASK_RADIUS;
  for (const p of refined) {
    if (picked.length >= k) break;
    if (picked.some(q => (p.x - q.x) ** 2 + (p.y - q.y) ** 2 < minDistSq)) continue;
    if (_nccTooClose(p.x, p.y, used)) continue;
    picked.push(p);
  }
  return picked;
}

/** Top-K per icon, без маски ранних пиков — assign отсекает дубли. */
function _nccFindTopPeaksIndep(src, icons, k = NCC_PEAKS_PER_ICON, scaleCache = null) {
  const scales = scaleCache || icons.map(tpl => _nccBestScaleMatch(src, tpl));
  const out = icons.map((tpl, i) => _nccFindTopPeaks(src, tpl, k, scales[i], []));
  return { cands: out, scaleCache: scales, usedMask: [] };
}

/** Top-K per icon with sequential mask — later icons avoid earlier peaks. */
function _nccFindTopPeaksSeq(src, icons, k = NCC_PEAKS_PER_ICON, scaleCache = null) {
  const scales = scaleCache || icons.map(tpl => _nccBestScaleMatch(src, tpl));
  const used = [];
  const out = [];
  for (let i = 0; i < icons.length; i++) {
    const peaks = _nccFindTopPeaks(src, icons[i], k, scales[i], used);
    out.push(peaks);
    for (const p of peaks) used.push({ x: p.x, y: p.y });
  }
  return { cands: out, scaleCache: scales, usedMask: used };
}

function _nccFindTopPeaksAll(src, icons, k = NCC_PEAKS_PER_ICON, scaleCache = null) {
  return NCC_SEQ_MASK
    ? _nccFindTopPeaksSeq(src, icons, k, scaleCache)
    : _nccFindTopPeaksIndep(src, icons, k, scaleCache);
}

/** Kuhn–Munkres min-cost assignment (n×n). Returns col index per row. */
function _hungarianMin(cost) {
  const n = cost.length;
  const u = new Float64Array(n + 1);
  const v = new Float64Array(n + 1);
  const p = new Int32Array(n + 1);
  const way = new Int32Array(n + 1);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(n + 1);
    minv.fill(Infinity);
    const used = new Uint8Array(n + 1);

    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  const assign = new Int32Array(n);
  for (let j = 1; j <= n; j++) {
    if (p[j]) assign[p[j] - 1] = j - 1;
  }
  return assign;
}

function _hungarianMax(score) {
  let maxS = 0;
  for (const row of score) for (const s of row) if (s > maxS) maxS = s;
  const cost = score.map(row => row.map(s => maxS - s));
  return _hungarianMin(cost);
}

/** Rectangular max assignment: nRows icons × nCols pool peaks. */
function _hungarianMaxRect(score) {
  const nRows = score.length;
  const nCols = score[0]?.length || 0;
  if (!nRows || !nCols) return [];
  const n = Math.max(nRows, nCols);
  const NEG = -1e6;
  const padded = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => {
      if (i < nRows && j < nCols) return score[i][j];
      if (i < nRows) return NEG;
      return 0;
    })
  );
  return _hungarianMax(padded).slice(0, nRows);
}

/** Re-score icon template at a candidate center (±6px fine + SSD). */
function _nccRescoreAt(src, tpl, cx, cy, cachedMatch) {
  const match = cachedMatch || _nccBestScaleMatch(src, tpl);
  if (!match) return { x: cx, y: cy, conf: 0, margin: 0, rawConf: 0 };
  const { sW, sH, bTW, bTH, winTplS, winTplH, winTplG, winTplE, winTplHp, winTplMask } = match;
  let bx = Math.round(cx - bTW / 2);
  let by = Math.round(cy - bTH / 2);
  bx = Math.max(0, Math.min(sW - bTW, bx));
  by = Math.max(0, Math.min(sH - bTH, by));

  const fine = _nccScanBox(src, winTplS, winTplH, winTplG, winTplE, winTplHp, sW, sH, bTW, bTH, [],
    Math.max(0, bx - 6), Math.max(0, by - 6),
    Math.min(sW - bTW, bx + 6), Math.min(sH - bTH, by + 6), NCC_FINE_STEP, winTplMask);
  const pt = _nccSsdRefine(src, winTplG, winTplE, sW, sH, fine.lbx, fine.lby, bTW, bTH);
  const peaks = _nccScanPeaks(src, winTplS, winTplH, winTplG, winTplE, winTplHp, sW, sH, bTW, bTH, [],
    Math.max(0, fine.lbx - 3), Math.max(0, fine.lby - 3),
    Math.min(sW - bTW, fine.lbx + 3), Math.min(sH - bTH, fine.lby + 3), 1, 2, winTplMask);
  const rawConf = fine.lbest;
  const { conf, margin } = _nccApplyPeakMargin(rawConf, peaks[1]?.sc ?? 0);
  return { x: pt.x, y: pt.y, conf, margin, rawConf };
}

/** Per-icon top-K peaks → merged pool up to n×NCC_POOL_FACTOR distinct locations. */
function _nccBuildExpandedPool(src, icons, n) {
  const pool = [];
  const minDistSq = NCC_MASK_RADIUS * NCC_MASK_RADIUS;
  const { cands: peakLists, scaleCache } = _nccFindTopPeaksAll(src, icons, NCC_PEAKS_PER_ICON);
  for (let i = 0; i < icons.length; i++) {
    for (const p of peakLists[i]) {
      let merged = false;
      for (const cl of pool) {
        const dx = p.x - cl.x, dy = p.y - cl.y;
        if (dx * dx + dy * dy < minDistSq) {
          if (p.conf > cl.conf) { cl.x = p.x; cl.y = p.y; cl.conf = p.conf; }
          merged = true;
          break;
        }
      }
      if (!merged) pool.push({ x: p.x, y: p.y, conf: p.conf });
    }
  }
  pool.sort((a, b) => b.conf - a.conf);
  const cap = n * NCC_POOL_FACTOR;
  return pool.slice(0, Math.max(n, Math.min(cap, pool.length)));
}

/** ≥2 точек на одной горизонтали (y ±NCC_Y_DUP_PX). */
function _nccYClusterBad(coords) {
  if (!coords || coords.length < 2) return false;
  const ys = coords.map(c => c.y).sort((a, b) => a - b);
  for (let i = 0; i < ys.length; i++) {
    let cnt = 1;
    for (let j = i + 1; j < ys.length && ys[j] - ys[i] <= NCC_Y_DUP_PX; j++) cnt++;
    if (cnt >= 2) return true;
  }
  return false;
}

/** ≥2 точек в одном столбце (x ±NCC_X_DUP_PX). */
function _nccXClusterBad(coords) {
  if (!coords || coords.length < 2) return false;
  const xs = coords.map(c => c.x).sort((a, b) => a - b);
  for (let i = 0; i < xs.length; i++) {
    let cnt = 1;
    for (let j = i + 1; j < xs.length && xs[j] - xs[i] <= NCC_X_DUP_PX; j++) cnt++;
    if (cnt >= 2) return true;
  }
  return false;
}

function _nccClusterBad(coords) {
  return _nccYClusterBad(coords) || _nccXClusterBad(coords);
}

function _nccApplyHungarianAssign(assign, score, refined, n, m) {
  const pick = new Array(n);
  let total = 0;
  const usedCols = new Set();
  for (let i = 0; i < n; i++) {
    const j = assign[i];
    if (j < 0 || j >= m || usedCols.has(j)) return null;
    usedCols.add(j);
    pick[i] = refined[i][j];
    total += score[i][j];
  }
  return { pick, total, cols: assign.slice() };
}

/** Brute top-K peaks per icon — pick best cluster-clean assignment. */
function _nccSearchTopKAssign(src, icons, k = NCC_TOPK_SEARCH) {
  const n = icons.length;
  const { cands: peakLists, scaleCache } = _nccFindTopPeaksAll(src, icons, k);
  const cands = peakLists.map((peaks, i) =>
    peaks.map(p => _nccRescoreAt(src, icons[i], p.x, p.y, scaleCache[i])),
  );
  if (cands.some(c => !c.length)) return null;

  let best = null;
  const picks = [];
  const minDistSq = NCC_MASK_RADIUS * NCC_MASK_RADIUS;

  function dfs(i, total) {
    if (i === n) {
      const coords = picks.map(p => ({ x: p.x, y: p.y }));
      if (_clickHasNearDuplicates(coords, NCC_MASK_RADIUS)) return;
      const clusterOk = !_nccClusterBad(coords);
      if (clusterOk && (!best || !best.clusterOk || total > best.total)) {
        best = { pick: picks.slice(), total, clusterOk: true };
      } else if (!clusterOk && (!best || (!best.clusterOk && total > best.total))) {
        best = { pick: picks.slice(), total, clusterOk: false };
      }
      return;
    }
    for (const p of cands[i]) {
      if (picks.some(q => (q.x - p.x) ** 2 + (q.y - p.y) ** 2 < minDistSq)) continue;
      picks.push(p);
      dfs(i + 1, total + p.conf);
      picks.pop();
    }
  }
  dfs(0, 0);
  return best;
}

function _nccHungarianAssign(src, icons) {
  const n = icons.length;
  const pool = _nccBuildExpandedPool(src, icons, n);
  const m = pool.length;
  if (m < n) return null;

  const scaleCache = icons.map(tpl => _nccBestScaleMatch(src, tpl));
  const score = Array.from({ length: n }, () => new Array(m).fill(0));
  const refined = Array.from({ length: n }, () => new Array(m));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const r = _nccRescoreAt(src, icons[i], pool[j].x, pool[j].y, scaleCache[i]);
      score[i][j] = r.conf;
      refined[i][j] = r;
    }
  }

  const assign = _hungarianMaxRect(score);
  const result = _nccApplyHungarianAssign(assign, score, refined, n, m);
  if (!result) return null;
  return { pick: result.pick, total: result.total, cols: result.cols, pool: m };
}

/** Hungarian vs topK — лучший cluster-clean, иначе лучший dirty. */
function _nccResolveAssignOpts(opts, logTag = "NCC") {
  if (!opts.length) return null;

  const coordsOf = (pick) => pick.map(p => ({ x: p.x, y: p.y }));
  const clean = opts.filter(o => !_nccClusterBad(coordsOf(o.pick)));
  const win = (clean.length ? clean : opts).reduce((a, b) => (b.total > a.total ? b : a));

  if (win.tag === "Hungarian") {
    console.log(`[EPD CLICK:${logTag}] Hungarian pool=${win.pool} cols=[${win.cols.map(c => c + 1).join(",")}] sum=${(win.total * 100).toFixed(0)}%`);
  } else {
    console.log(`[EPD CLICK:${logTag}] ${win.tag} sum=${(win.total * 100).toFixed(0)}%`);
  }
  if (_nccClusterBad(coordsOf(win.pick))) {
    const xBad = _nccXClusterBad(coordsOf(win.pick));
    const yBad = _nccYClusterBad(coordsOf(win.pick));
    console.log(`[EPD CLICK:${logTag}] ⚠️ cluster dup (x=${xBad ? "dup" : "ok"} y=${yBad ? "dup" : "ok"})`);
  } else if (win.tag.includes("ML")) {
    console.log(`[EPD CLICK:${logTag}] ${win.tag} picked over Hungarian (cluster ok)`);
  } else if (win.tag.startsWith("topK")) {
    console.log(`[EPD CLICK:${logTag}] ${win.tag} picked over Hungarian (cluster ok)`);
  }
  return win.pick;
}

function _nccSolveAssign(src, icons) {
  const hung = _nccHungarianAssign(src, icons);
  const topK = _nccSearchTopKAssign(src, icons, NCC_TOPK_SEARCH);
  const opts = [];
  if (hung) opts.push({ ...hung, tag: "Hungarian" });
  if (topK) opts.push({ pick: topK.pick, total: topK.total, tag: `topK×${NCC_TOPK_SEARCH}` });
  return _nccResolveAssignOpts(opts, "NCC");
}

/** Score for assign (NCC conf or ML cosine). */
function _clickPickScore(p) {
  return p?.mlScore ?? p?.conf ?? 0;
}

function _clickConsiderAssignBest(best, pick, total) {
  const coords = pick.map(p => ({ x: p.x, y: p.y }));
  if (_clickHasNearDuplicates(coords, NCC_MASK_RADIUS)) return best;
  const clusterOk = !_nccClusterBad(coords);
  if (!best || total > best.total || (total === best.total && clusterOk && !best.clusterOk)) {
    return { pick: pick.slice(), total, clusterOk };
  }
  return best;
}

/** Global pool: merged peaks → icon×pool assign, max Σ conf. */
function _clickAssignGlobalPool(cands) {
  const n = cands.length;
  if (cands.some(c => !c.length)) return null;

  const pool = [];
  const mergeSq = 18 * 18;
  const scores = Array.from({ length: n }, () => []);
  const peaks = Array.from({ length: n }, () => []);

  for (let i = 0; i < n; i++) {
    for (const p of cands[i]) {
      let j = pool.findIndex(q => (q.x - p.x) ** 2 + (q.y - p.y) ** 2 < mergeSq);
      if (j < 0) {
        j = pool.length;
        pool.push({ x: p.x, y: p.y });
      }
      const s = _clickPickScore(p);
      if (s > (scores[i][j] ?? 0)) {
        scores[i][j] = s;
        peaks[i][j] = p;
      }
    }
  }

  const m = pool.length;
  if (m < n) return null;

  let best = null;
  const used = new Set();
  const picks = [];

  function dfs(i, total) {
    if (i === n) {
      best = _clickConsiderAssignBest(best, picks, total);
      return;
    }
    for (let j = 0; j < m; j++) {
      if (used.has(j)) continue;
      const p = peaks[i][j];
      if (!p || (scores[i][j] ?? 0) <= 0) continue;
      used.add(j);
      picks.push(p);
      dfs(i + 1, total + scores[i][j]);
      picks.pop();
      used.delete(j);
    }
  }
  dfs(0, 0);
  return best;
}

/** Top-K assignment DFS — shared by NCC hybrid and ML-only paths. */
function _clickAssignFromCands(cands) {
  const n = cands.length;
  if (cands.some(c => !c.length)) return null;

  let best = null;
  const picks = [];
  const minDistSq = NCC_MASK_RADIUS * NCC_MASK_RADIUS;

  function dfs(i, total) {
    if (i === n) {
      best = _clickConsiderAssignBest(best, picks, total);
      return;
    }
    for (const p of cands[i]) {
      if (picks.some(q => (q.x - p.x) ** 2 + (q.y - p.y) ** 2 < minDistSq)) continue;
      picks.push(p);
      dfs(i + 1, total + _clickPickScore(p));
      picks.pop();
    }
  }
  dfs(0, 0);
  return best;
}

/** Log why top-K assignment failed — top-1 per icon + pairwise overlaps. */
function _clickLogAssignDiag(cands, reason) {
  console.log(`[EPD CLICK:ML] assign ${reason} — peaks/icon: ${cands.map(c => c.length).join("/")}`);
  const tops = [];
  cands.forEach((list, i) => {
    const p = list[0];
    if (!p) {
      console.log(`[EPD CLICK:ML]   icon${i + 1}: (no peaks)`);
      return;
    }
    tops.push({ i, p });
    const cos = ((p.mlScore ?? p.conf) * 100).toFixed(0);
    console.log(`[EPD CLICK:ML]   icon${i + 1}: (${p.x},${p.y}) cos=${cos}%`);
  });
  for (let a = 0; a < tops.length; a++) {
    for (let b = a + 1; b < tops.length; b++) {
      const d = Math.hypot(tops[a].p.x - tops[b].p.x, tops[a].p.y - tops[b].p.y);
      if (d < NCC_MASK_RADIUS) {
        console.log(
          `[EPD CLICK:ML]   overlap icon${tops[a].i + 1}↔icon${tops[b].i + 1}: ${d.toFixed(0)}px (<${NCC_MASK_RADIUS}px)`,
        );
      }
    }
  }
}

/** Per-icon ML coords + scores (after solve, before manual compare). */
function _clickLogMlPerIcon(logTag, coords, meta = {}) {
  if (!coords?.length) return;
  const { mlScores, confs, method } = meta;
  console.log(`[${logTag}] ML per-icon (${coords.length}, method=${method || "?"})`);
  coords.forEach((p, i) => {
    const pct = mlScores?.[i] != null
      ? (mlScores[i] * 100).toFixed(0)
      : confs?.[i] != null
        ? (confs[i] * 100).toFixed(0)
        : "?";
    console.log(`[${logTag}]   icon${i + 1}: (${p.x},${p.y}) cos=${pct}%`);
  });
}

/** Min-cost assignment manual→auto; separates detection+perm from direct icon# compare. */
function _clickOptimalPermStats(manualCoords, autoCoords) {
  const n = Math.min(manualCoords.length, autoCoords.length);
  if (!n) return null;
  const cost = manualCoords.slice(0, n).map(m =>
    autoCoords.slice(0, n).map(a => Math.hypot(m.x - a.x, m.y - a.y)),
  );
  const assign = _hungarianMin(cost);
  let sum = 0;
  let ok = 0;
  const pairs = [];
  for (let i = 0; i < n; i++) {
    const j = assign[i];
    const d = cost[i][j];
    sum += d;
    if (d < NCC_MASK_RADIUS) ok++;
    pairs.push({ manual: i + 1, auto: j + 1, d });
  }
  return { avg: sum / n, ok, pairs, assign };
}

/** Diff auto coords vs manual per icon; optimal-perm separates assign from detection. */
function _clickLogMlManualDiff(logTag, mlCoords, manualCoords, meta = {}) {
  if (!mlCoords?.length || !manualCoords?.length) return;
  const n = Math.min(mlCoords.length, manualCoords.length);
  const { mlScores, confs, method, nccCands } = meta;
  let totalDist = 0;
  let maxDist = 0;
  let okCount = 0;
  console.log(`[${logTag}] auto vs manual (${n} icons, method=${method || "?"})`);
  for (let i = 0; i < n; i++) {
    const ml = mlCoords[i];
    const man = manualCoords[i];
    const d = Math.hypot(ml.x - man.x, ml.y - man.y);
    totalDist += d;
    if (d > maxDist) maxDist = d;
    if (d < NCC_MASK_RADIUS) okCount++;
    const pct = mlScores?.[i] != null
      ? (mlScores[i] * 100).toFixed(0)
      : confs?.[i] != null
        ? (confs[i] * 100).toFixed(0)
        : "?";
    const flag = d < 15 ? "✓" : d < NCC_MASK_RADIUS ? "~" : "✗";
    console.log(
      `[${logTag}]   icon${i + 1}: auto(${ml.x},${ml.y}) manual(${man.x},${man.y}) Δ=${d.toFixed(0)}px ${flag} conf=${pct}%`,
    );
    if (nccCands?.[i]?.length) {
      const inPool = nccCands[i].find(p => (p.x - man.x) ** 2 + (p.y - man.y) ** 2 <= 35 * 35);
      if (inPool) {
        const pd = Math.hypot(inPool.x - man.x, inPool.y - man.y);
        console.log(`[${logTag}]     manual#${i + 1} in NCC pool@(${inPool.x},${inPool.y}) Δ=${pd.toFixed(0)}px conf=${(inPool.conf * 100).toFixed(0)}%`);
      } else {
        console.log(`[${logTag}]     manual#${i + 1} NOT in NCC top-${nccCands[i].length}`);
      }
    }
  }
  const avg = totalDist / n;
  console.log(
    `[${logTag}] summary: direct avgΔ=${avg.toFixed(0)}px maxΔ=${maxDist.toFixed(0)}px ok<${NCC_MASK_RADIUS}px=${okCount}/${n}`,
  );

  const opt = _clickOptimalPermStats(manualCoords, mlCoords);
  if (opt) {
    const assignStr = opt.pairs.map(p => `m${p.manual}→a${p.auto}(${p.d.toFixed(0)}px)`).join(" ");
    console.log(
      `[${logTag}] optimal-perm: avgΔ=${opt.avg.toFixed(0)}px ok<${NCC_MASK_RADIUS}px=${opt.ok}/${n} | ${assignStr}`,
    );
    const assignGap = avg - opt.avg;
    if (assignGap > 25) {
      console.log(`[${logTag}]   → assign виноват: direct−perm=${assignGap.toFixed(0)}px (точки есть, перестановка)`);
    } else if (opt.avg > 80) {
      console.log(`[${logTag}]   → detection: optimal-perm тоже высокий — NCC/ML не находит пик`);
    }
  }

  const used = new Set();
  for (let i = 0; i < n; i++) {
    let bestJ = -1;
    let bestD = Infinity;
    for (let j = 0; j < n; j++) {
      const d = Math.hypot(manualCoords[i].x - mlCoords[j].x, manualCoords[i].y - mlCoords[j].y);
      if (d < bestD) {
        bestD = d;
        bestJ = j;
      }
    }
    if (bestJ !== i && !used.has(bestJ)) {
      used.add(bestJ);
      console.log(
        `[${logTag}]   perm?: manual#${i + 1} ближе к auto#${bestJ + 1} (${bestD.toFixed(0)}px) — возможна перестановка`,
      );
    }
  }
}

/** Greedy assign: best peak per icon, relax min distance if needed. */
function _clickAssignGreedy(cands, minDistPx = NCC_MASK_RADIUS) {
  const n = cands.length;
  if (cands.some(c => !c.length)) return null;

  const distSteps = [minDistPx, Math.round(minDistPx * 0.7), Math.round(minDistPx * 0.4), 12]
    .filter((d, i, arr) => i === 0 || d !== arr[i - 1]);

  for (const dist of distSteps) {
    const minDistSq = dist * dist;
    const picks = [];
    for (let i = 0; i < n; i++) {
      let chosen = null;
      for (const p of cands[i]) {
        if (dist > 0 && picks.some(q => (q.x - p.x) ** 2 + (q.y - p.y) ** 2 < minDistSq)) continue;
        chosen = p;
        break;
      }
      if (!chosen) break;
      picks.push(chosen);
    }
    if (picks.length !== n) continue;
    const coords = picks.map(p => ({ x: p.x, y: p.y }));
    return {
      pick: picks,
      total: picks.reduce((s, p) => s + p.conf, 0),
      clusterOk: !_nccClusterBad(coords),
      fallback: true,
      minDist: dist,
    };
  }
  return null;
}

/** Merge all per-icon peaks into one pool (dedupe by distance). */
function _clickBuildMlPeakPool(cands) {
  const pool = [];
  const minDistSq = NCC_MASK_RADIUS * NCC_MASK_RADIUS;
  for (const list of cands) {
    for (const p of list) {
      let merged = false;
      for (const cl of pool) {
        const dx = p.x - cl.x;
        const dy = p.y - cl.y;
        if (dx * dx + dy * dy < minDistSq) {
          const s = p.mlScore ?? p.conf ?? 0;
          const cs = cl.mlScore ?? cl.conf ?? 0;
          if (s > cs) Object.assign(cl, p);
          merged = true;
          break;
        }
      }
      if (!merged) pool.push({ ...p });
    }
  }
  pool.sort((a, b) => (b.mlScore ?? b.conf ?? 0) - (a.mlScore ?? a.conf ?? 0));
  const n = cands.length;
  const cap = Math.max(n, Math.min(n * NCC_POOL_FACTOR, pool.length));
  return pool.slice(0, cap);
}

/** Hungarian on full icon×pool ML cosine matrix. */
async function _clickHungarianMlAssign(cands, ctx) {
  const { mainImg, iconImgs, patchSizes } = ctx;
  if (!mainImg || !iconImgs?.length || !window.EPD_ML_SOLVER?.mlScorePoolMatrix) return null;

  const n = cands.length;
  if (cands.some(c => !c.length)) return null;

  const pool = _clickBuildMlPeakPool(cands);
  const m = pool.length;
  if (m < n) return null;

  const t0 = Date.now();
  const score = await window.EPD_ML_SOLVER.mlScorePoolMatrix(mainImg, iconImgs, pool, patchSizes, {
    cands,
    iconEmbs: ctx.iconEmbs,
    patchEmbCache: ctx.patchEmbCache,
  });
  if (!score?.length) return null;

  const assign = _hungarianMaxRect(score);
  const pick = [];
  let total = 0;
  const usedCols = new Set();
  for (let i = 0; i < n; i++) {
    const j = assign[i];
    if (j < 0 || j >= m || usedCols.has(j)) return null;
    usedCols.add(j);
    const mlScore = score[i][j];
    const p = pool[j];
    pick.push({
      x: p.x,
      y: p.y,
      mlScore,
      conf: mlScore,
      nccConf: p.nccConf ?? p.conf,
    });
    total += mlScore;
  }

  const coords = pick.map(p => ({ x: p.x, y: p.y }));
  if (_clickHasNearDuplicates(coords, NCC_MASK_RADIUS)) return null;

  console.log(
    `[EPD CLICK:ML] Hungarian assign ${n}×${m} за ${Date.now() - t0}мс, sum=${(total * 100).toFixed(0)}%`,
  );
  return { pick, total, cols: assign, pool: m, clusterOk: !_nccClusterBad(coords) };
}

/** Soft penalties for assign pick — не отбрасываем Hungarian только из‑за cluster. */
const ML_ASSIGN_CLUSTER_PENALTY = 0.035;
const ML_ASSIGN_NEAR_PENALTY = 0.05;

function _clickAssignEffectiveScore(pick) {
  const coords = pick.map(p => ({ x: p.x, y: p.y }));
  let s = pick.reduce((sum, p) => sum + (p.mlScore ?? p.conf ?? 0), 0);
  if (_nccClusterBad(coords)) s -= ML_ASSIGN_CLUSTER_PENALTY;
  if (_clickHasNearDuplicates(coords, NCC_MASK_RADIUS)) s -= ML_ASSIGN_NEAR_PENALTY;
  return s;
}

function _clickPickMlAssignWinner(opts) {
  if (!opts.length) return null;
  const coordsOf = (pick) => pick.map(p => ({ x: p.x, y: p.y }));
  const scored = opts.map(o => {
    const coords = coordsOf(o.best.pick);
    return {
      ...o,
      clusterOk: !_nccClusterBad(coords),
      nearOk: !_clickHasNearDuplicates(coords, NCC_MASK_RADIUS),
      effective: _clickAssignEffectiveScore(o.best.pick),
    };
  });

  const win = scored.reduce((a, b) => (b.effective > a.effective ? b : a));
  const hung = scored.find(o => o.tag === "Hungarian");
  const dfs = scored.find(o => o.tag === "topK-DFS");
  const winPct = (win.best.total * 100).toFixed(0);
  const effPct = (win.effective * 100).toFixed(0);

  if (win.tag === "Hungarian" && win.best.cols) {
    const extra = hung && dfs && !hung.clusterOk && dfs.clusterOk
      ? ` (eff ${effPct}% vs DFS ${(dfs.effective * 100).toFixed(0)}%, cluster dup tolerated)`
      : "";
    console.log(
      `[EPD CLICK:ML] Hungarian pool=${win.best.pool} cols=[${win.best.cols.map(c => c + 1).join(",")}] sum=${winPct}% eff=${effPct}%${extra}`,
    );
  } else if (win.tag === "topK-DFS" && hung) {
    console.log(
      `[EPD CLICK:ML] topK-DFS picked over Hungarian: DFS eff=${effPct}% sum=${winPct}% | Hung eff=${(hung.effective * 100).toFixed(0)}% sum=${(hung.best.total * 100).toFixed(0)}% cluster=${hung.clusterOk ? "ok" : "dup"}`,
    );
  } else {
    console.log(`[EPD CLICK:ML] ${win.tag} sum=${winPct}% eff=${effPct}%`);
  }
  return win;
}

function _clickResolveMlAssignFallback(cands) {
  let best = _clickAssignGreedy(cands);
  if (best) {
    console.log(`[EPD CLICK:ML] fallback greedy@${best.minDist}px (total=${best.total.toFixed(2)})`);
    return { best, tag: `greedy@${best.minDist}px` };
  }

  _clickLogAssignDiag(cands, "no distinct assignment");
  return null;
}

function _clickResolveMlAssign(cands) {
  const global = _clickAssignGlobalPool(cands);
  if (global) return _clickPickMlAssignWinner([{ best: global, tag: "global-pool" }]);
  const dfs = _clickAssignFromCands(cands);
  if (dfs) return _clickPickMlAssignWinner([{ best: dfs, tag: "topK-DFS" }]);
  _clickLogAssignDiag(cands, "DFS failed");
  return _clickResolveMlAssignFallback(cands);
}

async function _clickResolveMlAssignAsync(cands, ctx = null) {
  if (!ML_HUNGARIAN_ASSIGN) return _clickResolveMlAssign(cands);

  const opts = [];
  if (ctx?.mainImg && ctx?.iconImgs?.length) {
    const hung = await _clickHungarianMlAssign(cands, ctx);
    if (hung) opts.push({ best: hung, tag: "Hungarian" });
  }

  const dfs = _clickAssignFromCands(cands);
  if (dfs) opts.push({ best: dfs, tag: "topK-DFS" });

  const picked = _clickPickMlAssignWinner(opts);
  if (picked) return picked;

  _clickLogAssignDiag(cands, "Hungarian+DFS failed");
  return _clickResolveMlAssignFallback(cands);
}

/** Shared ML assign → coords result (grid or peaks path). */
function _clickFinalizeMlResult(resolved, iconCount, t0, methodBase, logTag = "ML", nccCands = null) {
  if (!resolved) return null;
  const { best, tag: assignTag } = resolved;
  const assigned = best.pick;
  const coords = assigned.map(p => ({ x: p.x, y: p.y }));
  const confs = assigned.map(p => p.conf);
  const mlScores = assigned.map(p => p.mlScore ?? p.conf);
  const minMl = Math.min(...mlScores);
  const avgMl = mlScores.reduce((s, c) => s + c, 0) / mlScores.length;
  const clusterBad = _nccClusterBad(coords);
  const nearDup = _clickHasNearDuplicates(coords);
  const perPct = mlScores.map(c => (c * 100).toFixed(0));
  const mlPct = (minMl * 100).toFixed(0);
  let raceReady = _mlRaceReady(mlScores) && !clusterBad && !nearDup;
  const avgPct = (avgMl * 100).toFixed(0);
  const method = `${methodBase}+${assignTag}`;
  console.log(
    `[EPD CLICK:${logTag}] ${iconCount} icons, assign=${assignTag}, per=${perPct.join("/")}%, min=${mlPct}%, avg=${avgPct}%, cluster=${clusterBad ? "dup" : "ok"}, near=${nearDup ? "dup" : "ok"}, race=${raceReady ? "OK" : "weak"} за ${Date.now() - t0}мс`,
  );

  if (coords.length >= 3 && nearDup && !ML_TRAINING_MODE) {
    console.log(`[EPD CLICK:${logTag}] ⚠️ близкие точки — skip`);
    return null;
  }
  if (coords.length >= 3 && nearDup && ML_TRAINING_MODE) {
    console.log(`[EPD CLICK:${logTag}] ⚠️ близкие точки — train/validate anyway`);
    raceReady = false;
  }
  if (coords.length >= 3 && clusterBad && !ML_TRAINING_MODE) {
    console.log(`[EPD CLICK:${logTag}] ⚠️ cluster dup — validate skip`);
    return null;
  }
  if (coords.length >= 3 && (raceReady || ML_TRAINING_MODE)) {
    return { coords, conf: minMl, confs, mlScores, avgConf: avgMl, raceReady, deferReady: false, clusterBad, method, nccCands };
  }
  if (coords.length >= 3 && minMl >= ML_MIN_COSINE * 0.85) {
    return { coords, conf: minMl, confs, mlScores, avgConf: avgMl, raceReady: false, deferReady: false, weak: true, clusterBad, method, nccCands };
  }
  if (coords.length >= 3 && ML_TRAINING_MODE) {
    console.log(`[EPD CLICK:${logTag}] ⚠️ слабо (min ${mlPct}%) — train/validate anyway`);
    return { coords, conf: minMl, confs, mlScores, avgConf: avgMl, raceReady: false, deferReady: false, weak: true, clusterBad, method, nccCands };
  }
  if (coords.length >= 3) {
    console.log(`[EPD CLICK:${logTag}] ⚠️ слишком слабо (min ${mlPct}%) — skip`);
  }
  return null;
}

/** Top-K assign with batched MobileNet refine on each icon's peak list. */
async function _nccSearchTopKAssignAsync(src, icons, iconImgs, mainImg, k = NCC_TOPK_SEARCH) {
  const { cands: peakLists, scaleCache } = _nccFindTopPeaksAll(src, icons, k);
  let nccCands = peakLists.map((peaks, i) =>
    peaks.map(p => _nccRescoreAt(src, icons[i], p.x, p.y, scaleCache[i])),
  );

  let cands = nccCands;
  if (iconImgs?.[0] && mainImg && window.EPD_ML_SOLVER?.mlIsReady()) {
    const items = icons.map((_, i) => ({
      iconImg: iconImgs[i],
      peaks: nccCands[i],
      patchW: scaleCache[i].bTW,
      patchH: scaleCache[i].bTH,
    }));
    const refine = await window.EPD_ML_SOLVER.mlRefineMultiIcon(mainImg, items, _mlWeights());
    cands = refine.cands ?? refine;
  }
  return _clickAssignFromCands(cands);
}

async function _nccSolveAssignAsync(src, icons, iconImgs, mainImg, pre = null) {
  const hung = pre?.hung ?? _nccHungarianAssign(src, icons);
  let topK;
  if (pre?.mlCands) {
    topK = _clickAssignFromCands(pre.mlCands);
  } else if (pre?.nccCands) {
    topK = _clickAssignFromCands(pre.nccCands);
  } else {
    topK = await _nccSearchTopKAssignAsync(src, icons, iconImgs, mainImg, NCC_TOPK_SEARCH);
  }
  const opts = [];
  if (hung) opts.push({ ...hung, tag: "Hungarian" });
  if (topK) {
    opts.push({
      pick: topK.pick,
      total: topK.total,
      tag: pre?.mlCands ? `topK×${NCC_TOPK_SEARCH}+ML` : `topK×${NCC_TOPK_SEARCH}`,
    });
  }
  return _nccResolveAssignOpts(opts, pre?.mlCands ? "NCC+ML" : "NCC");
}

function _detectIconCount(strip, stripImg) {
  const { width, height } = strip;
  if (stripImg && window.EPD_BG_REMOVE?.detectStripIconCount) {
    return window.EPD_BG_REMOVE.detectStripIconCount(stripImg);
  }
  const est = Math.round(width / height);
  return Math.max(3, Math.min(5, est || 3));
}

async function solveClickNCC(front) {
  if (!front?.imageBase64 || !front?.iconsBase64) return null;
  const t0 = Date.now();
  const mainImg = await _decodeImg(front.imageBase64);
  const stripImg = await _decodeImg(front.iconsBase64);
  if (!mainImg || !stripImg) return null;

  const src = _toClickChannels(mainImg);
  const strip = _toClickChannels(stripImg);
  const iconCount = _detectIconCount(strip, stripImg);
  const icons = _splitIconChannels(strip, iconCount, stripImg);

  const assigned = _nccSolveAssign(src, icons);
  if (!assigned) return null;
  const coords = [];
  const confs = [];
  const margins = [];
  let minConf = 1;
  for (let i = 0; i < assigned.length; i++) {
    const r = assigned[i];
    if (!r) {
      console.log(`[EPD CLICK:NCC] ⚠️ icon ${i + 1}: no peak`);
      return null;
    }
    coords.push({ x: r.x, y: r.y });
    confs.push(r.conf);
    margins.push((r.margin * 100).toFixed(0));
    minConf = Math.min(minConf, r.conf);
  }

  const confPct = (minConf * 100).toFixed(0);
  const racePct = (NCC_RACE_CONF * 100).toFixed(0);
  const perPct = confs.map(c => (c * 100).toFixed(0));
  const avgConf = confs.reduce((s, c) => s + c, 0) / confs.length;
  const clusterBad = _nccClusterBad(coords);
  const xClusterBad = _nccXClusterBad(coords);
  const yClusterBad = _nccYClusterBad(coords);
  let raceReady = _nccRaceReady(confs) && !clusterBad;
  let deferReady = _nccDeferReady(confs, avgConf, !clusterBad);
  const avgPct = (avgConf * 100).toFixed(0);
  const deferAvgPct = (NCC_DEFER_AVG_STRICT * 100).toFixed(0);
  console.log(`[EPD CLICK:NCC v5.3] ${iconCount} icons, per=${perPct.join("/")}%, min=${confPct}%, avg=${avgPct}%, margin=${margins.join("/")}%, x=${xClusterBad ? "dup" : "ok"} y=${yClusterBad ? "dup" : "ok"}, race=${raceReady ? "OK" : deferReady ? "defer" : "weak"} за ${Date.now() - t0}мс`);

  if (coords.length >= 3 && _clickHasNearDuplicates(coords)) {
    console.log(`[EPD CLICK:NCC] ⚠️ близкие точки (<${NCC_NEAR_DUP_PX}px) — skip`);
    return null;
  }

  if (coords.length >= 3 && clusterBad) {
    console.log(`[EPD CLICK:NCC] ⚠️ cluster dup — validate skip`);
    return null;
  }

  if (coords.length >= 3 && (raceReady || deferReady)) {
    if (raceReady) {
      console.log(`[EPD CLICK:NCC] ✅ instant (min ${confPct}% ≥ ${racePct}%, all ≥${(NCC_PER_ICON_MIN * 100).toFixed(0)}%)`);
    } else {
      console.log(`[EPD CLICK:NCC] ✅ defer (min≥${(NCC_DEFER_MIN * 100).toFixed(0)}%, avg ${avgPct}%≥${deferAvgPct}%)`);
    }
    return { coords, conf: minConf, confs, avgConf, raceReady, deferReady, clusterBad, method: "NCC" };
  }

  if (coords.length >= 3 && minConf >= NCC_DEFER_FLOOR) {
    console.log(`[EPD CLICK:NCC] ⏳ weak ${confPct}% — отправляем (NCC-only)`);
    return { coords, conf: minConf, confs, avgConf, raceReady: false, deferReady: false, weak: true, clusterBad, method: "NCC" };
  }

  if (coords.length >= 3) {
    console.log(`[EPD CLICK:NCC] ⚠️ слишком слабо (min ${confPct}% < ${(NCC_DEFER_FLOOR * 100).toFixed(0)}%) — skip`);
  }
  return null;
}

function _mlRaceReady(scores) {
  if (!scores.length) return false;
  return Math.min(...scores) >= ML_RACE_CONF;
}

/** Fast path: один проход NCC → ML refine на тех же peaks (без повторного скана). */
async function solveClickFast(front) {
  if (!front?.imageBase64 || !front?.iconsBase64) return null;
  const t0 = Date.now();
  const mainImg = await _decodeImg(front.imageBase64);
  const stripImg = await _decodeImg(front.iconsBase64);
  if (!mainImg || !stripImg) return null;

  const src = _toClickChannels(mainImg);
  const strip = _toClickChannels(stripImg);
  const iconCount = _detectIconCount(strip, stripImg);
  const icons = _splitIconChannels(strip, iconCount, stripImg);
  const iconImgs = _splitIconImages(stripImg, iconCount);
  const mlReady = ML_ENABLED && window.EPD_ML_SOLVER?.mlIsReady();

  // ── один проход NCC: Hungarian + top-K peaks ──
  const hung = _nccHungarianAssign(src, icons);
  const { cands: peakLists, scaleCache } = _nccFindTopPeaksAll(src, icons, NCC_TOPK_SEARCH);
  const nccCands = peakLists.map((peaks, i) =>
    peaks.map(p => _nccRescoreAt(src, icons[i], p.x, p.y, scaleCache[i])),
  );
  const topKNcc = _clickAssignFromCands(nccCands);

  const nccOpts = [];
  if (hung) nccOpts.push({ ...hung, tag: "Hungarian" });
  if (topKNcc) nccOpts.push({ pick: topKNcc.pick, total: topKNcc.total, tag: `topK×${NCC_TOPK_SEARCH}` });
  const nccPick = _nccResolveAssignOpts(nccOpts, "NCC");

  if (nccPick) {
    const coords = nccPick.map(p => ({ x: p.x, y: p.y }));
    const confs = nccPick.map(p => p.conf);
    const minConf = Math.min(...confs);
    const avgConf = confs.reduce((s, c) => s + c, 0) / confs.length;
    const clusterBad = _nccClusterBad(coords);
    const raceReady = _nccRaceReady(confs) && !clusterBad;
    const deferReady = _nccDeferReady(confs, avgConf, !clusterBad);

    if (coords.length >= 3 && !_clickHasNearDuplicates(coords) && !clusterBad && (raceReady || deferReady)) {
      const perPct = confs.map(c => (c * 100).toFixed(0));
      console.log(`[EPD CLICK:FAST] NCC instant per=${perPct.join("/")}%, min=${(minConf * 100).toFixed(0)}% за ${Date.now() - t0}мс`);
      return { coords, conf: minConf, confs, avgConf, raceReady, deferReady, clusterBad, method: "NCC" };
    }
  }

  let assigned = nccPick;
  let method = "NCC";

  if (mlReady) {
    const items = icons.map((_, i) => ({
      iconImg: iconImgs[i],
      peaks: nccCands[i],
      patchW: scaleCache[i].bTW,
      patchH: scaleCache[i].bTH,
    }));
    const refine = await window.EPD_ML_SOLVER.mlRefineMultiIcon(mainImg, items, _mlWeights());
    const mlCands = refine.cands ?? refine;
    assigned = await _nccSolveAssignAsync(src, icons, iconImgs, mainImg, { hung, nccCands, mlCands }) || nccPick;
    method = "NCC+ML";
  }

  if (!assigned) return null;

  const coords = [];
  const confs = [];
  const mlScores = [];
  let minConf = 1;
  let minMl = 1;
  for (let i = 0; i < assigned.length; i++) {
    const r = assigned[i];
    if (!r) {
      console.log(`[EPD CLICK:FAST] ⚠️ icon ${i + 1}: no peak`);
      return null;
    }
    coords.push({ x: r.x, y: r.y });
    confs.push(r.conf);
    mlScores.push(r.mlScore ?? null);
    minConf = Math.min(minConf, r.conf);
    if (r.mlScore != null) minMl = Math.min(minMl, r.mlScore);
  }

  const confPct = (minConf * 100).toFixed(0);
  const mlPct = minMl < 1 ? (minMl * 100).toFixed(0) : "n/a";
  const perPct = confs.map(c => (c * 100).toFixed(0));
  const avgConf = confs.reduce((s, c) => s + c, 0) / confs.length;
  const clusterBad = _nccClusterBad(coords);
  let raceReady = _nccRaceReady(confs) && !clusterBad;
  let deferReady = _nccDeferReady(confs, avgConf, !clusterBad);
  if (minMl < 1 && minMl < ML_MIN_COSINE) {
    raceReady = false;
    deferReady = deferReady && minMl >= ML_MIN_COSINE * 0.85;
  }
  const tag = method;
  console.log(`[EPD CLICK:FAST] ${iconCount} icons, per=${perPct.join("/")}%, min=${confPct}%, ml_min=${mlPct}%, race=${raceReady ? "OK" : deferReady ? "defer" : "weak"} за ${Date.now() - t0}мс (${tag})`);

  if (coords.length >= 3 && _clickHasNearDuplicates(coords)) {
    console.log(`[EPD CLICK:FAST] ⚠️ близкие точки — skip`);
    return null;
  }
  if (coords.length >= 3 && clusterBad && !ML_TRAINING_MODE) {
    console.log(`[EPD CLICK:FAST] ⚠️ cluster dup — validate skip`);
    return null;
  }
  if (coords.length >= 3 && (raceReady || deferReady)) {
    return { coords, conf: minConf, confs, mlScores, avgConf, raceReady, deferReady, clusterBad, method: tag };
  }
  if (coords.length >= 3 && (minConf >= NCC_DEFER_FLOOR || ML_TRAINING_MODE)) {
    return { coords, conf: minConf, confs, mlScores, avgConf, raceReady: false, deferReady: false, weak: true, clusterBad, method: tag };
  }
  if (coords.length >= 3) {
    console.log(`[EPD CLICK:FAST] ⚠️ слишком слабо (min ${confPct}%) — skip`);
  }
  return null;
}

/** ML-only: grid scan + cosine assignment (медленно, только если ML_ONLY). */
async function solveClickML(front, onProgress = null) {
  if (!front?.imageBase64 || !front?.iconsBase64) return null;
  const t0 = Date.now();
  onProgress?.("декодируем изображения...");
  const mainImg = await _decodeImg(front.imageBase64);
  const stripImg = await _decodeImg(front.iconsBase64);
  if (!mainImg || !stripImg || !window.EPD_ML_SOLVER?.mlIsReady()) return null;

  const strip = _toClickChannels(stripImg);
  const iconCount = _detectIconCount(strip, stripImg);
  const iconImgs = _splitIconImages(stripImg, iconCount);
  onProgress?.(`сканируем ${iconCount} иконок...`);

  const cands = await window.EPD_ML_SOLVER.mlScanIcons(mainImg, iconImgs, NCC_TOPK_SEARCH, onProgress);
  return _clickFinalizeMlResult(
    await _clickResolveMlAssignAsync(cands),
    iconCount, t0, "ML-grid", "ML-grid",
  );
}

/** Log top-K NCC peaks per icon (before assign). */
function _clickLogNccPeaksDiag(cands) {
  cands.forEach((list, i) => {
    if (!list?.length) {
      console.log(`[EPD CLICK:NCC-peaks] icon${i + 1}: (no peaks)`);
      return;
    }
    const tops = list.map(p => `(${p.x},${p.y})${(p.conf * 100).toFixed(0)}%`).join(" | ");
    console.log(`[EPD CLICK:NCC-peaks] icon${i + 1}: ${tops}`);
  });
}

function _clickResolveNccAssign(cands) {
  const global = _clickAssignGlobalPool(cands);
  if (global) return { best: global, tag: "global-pool" };
  const dfs = _clickAssignFromCands(cands);
  if (dfs) return { best: dfs, tag: "topK-DFS" };
  _clickLogAssignDiag(cands, "DFS failed");
  const fb = _clickResolveMlAssignFallback(cands);
  if (fb) return fb;
  return null;
}

function _clickFinalizeNccPeaksResult(resolved, iconCount, t0, nccMs, nccCands = null) {
  if (!resolved) return null;
  const { best, tag: assignTag } = resolved;
  const assigned = best.pick;
  const coords = assigned.map(p => ({ x: p.x, y: p.y }));
  const confs = assigned.map(p => p.conf);
  const minConf = Math.min(...confs);
  const avgConf = confs.reduce((s, c) => s + c, 0) / confs.length;
  const clusterBad = _nccClusterBad(coords);
  const nearDup = _clickHasNearDuplicates(coords);
  const perPct = confs.map(c => (c * 100).toFixed(0));
  const confPct = (minConf * 100).toFixed(0);
  let raceReady = _nccRaceReady(confs) && !clusterBad && !nearDup;
  let deferReady = _nccDeferReady(confs, avgConf, !clusterBad && !nearDup);
  const method = `NCC-peaks+${assignTag}`;
  console.log(
    `[EPD CLICK:NCC-peaks] ${iconCount} icons, ncc=${nccMs}мс, assign=${assignTag}, per=${perPct.join("/")}%, min=${confPct}%, cluster=${clusterBad ? "dup" : "ok"}, near=${nearDup ? "dup" : "ok"}, race=${raceReady ? "OK" : deferReady ? "defer" : "weak"} за ${Date.now() - t0}мс`,
  );

  if (coords.length >= 3 && nearDup && !ML_TRAINING_MODE) {
    console.log(`[EPD CLICK:NCC-peaks] ⚠️ близкие точки — skip`);
    return null;
  }
  if (coords.length >= 3 && clusterBad && !ML_TRAINING_MODE) {
    console.log(`[EPD CLICK:NCC-peaks] ⚠️ cluster dup — skip`);
    return null;
  }
  if (coords.length >= 3 && (raceReady || deferReady || ML_TRAINING_MODE)) {
    return { coords, conf: minConf, confs, mlScores: null, avgConf, raceReady, deferReady, clusterBad, method, nccCands };
  }
  if (coords.length >= 3 && minConf >= NCC_DEFER_FLOOR) {
    return { coords, conf: minConf, confs, mlScores: null, avgConf, raceReady: false, deferReady: false, weak: true, clusterBad, method, nccCands };
  }
  if (coords.length >= 3) {
    console.log(`[EPD CLICK:NCC-peaks] ⚠️ слабо (min ${confPct}%) — skip`);
  }
  return null;
}

/** NCC peaks only — тот же пайплайн пиков что у ML, без ONNX refine. */
async function solveClickNCCPeaks(front, onProgress = null) {
  if (!front?.imageBase64 || !front?.iconsBase64) return null;
  const t0 = Date.now();
  onProgress?.("декодируем...");
  const mainImg = await _decodeImg(front.imageBase64);
  const stripImg = await _decodeImg(front.iconsBase64);
  if (!mainImg || !stripImg) return null;

  const src = _toClickChannels(mainImg);
  const strip = _toClickChannels(stripImg);
  const iconCount = _detectIconCount(strip, stripImg);
  const icons = _splitIconChannels(strip, iconCount, stripImg);

  onProgress?.("NCC peaks...");
  const nccT0 = Date.now();
  const { cands: peakLists, scaleCache } = _nccFindTopPeaksAll(src, icons, NCC_PEAKS_PER_ICON);
  const nccCands = peakLists.map((peaks, i) =>
    peaks.map(p => _nccRescoreAt(src, icons[i], p.x, p.y, scaleCache[i])),
  );
  const nccMs = Date.now() - nccT0;
  const nccTag = _nccPeakScanTag();
  console.log(`[EPD CLICK:NCC-peaks] scan ${nccTag} ${iconCount}×${NCC_PEAKS_PER_ICON} (step${_nccPeakStep()}) за ${nccMs}мс`);
  _clickLogNccPeaksDiag(nccCands);

  return _clickFinalizeNccPeaksResult(_clickResolveNccAssign(nccCands), iconCount, t0, nccMs, nccCands);
}
function _clickHasNearDuplicates(coords, minDistPx = NCC_NEAR_DUP_PX) {
  if (!coords || coords.length < 2) return false;
  const minSq = minDistPx * minDistPx;
  for (let i = 0; i < coords.length; i++) {
    for (let j = i + 1; j < coords.length; j++) {
      const dx = coords[i].x - coords[j].x;
      const dy = coords[i].y - coords[j].y;
      if (dx * dx + dy * dy < minSq) return true;
    }
  }
  return false;
}

async function solveClickNCCPeaksFromImageData(mainImg, stripImg, onProgress = null) {
  const front = {
    imageBase64: imageDataToB64(mainImg),
    iconsBase64: imageDataToB64(stripImg),
  };
  const r = await solveClickNCCPeaks(front, onProgress);
  if (!r) return null;
  const strip = _toClickChannels(stripImg);
  const iconCount = _detectIconCount(strip, stripImg);
  const icons = _splitIconChannels(strip, iconCount, stripImg);
  const { scaleCache } = _nccFindTopPeaksAll(_toClickChannels(mainImg), icons, NCC_PEAKS_PER_ICON);
  r.scaleInfo = icons.map((ic, i) => ({
    icon: i + 1,
    stripW: ic.width,
    stripH: ic.height,
    matchW: scaleCache[i]?.bTW ?? 0,
    matchH: scaleCache[i]?.bTH ?? 0,
    scaleX: scaleCache[i] ? (scaleCache[i].bTW / ic.width).toFixed(2) : "?",
  }));
  r.mainImg = mainImg;
  r.stripImg = stripImg;
  r.iconCount = iconCount;
  return r;
}

function imageDataToB64(imgData) {
  const c = document.createElement("canvas");
  c.width = imgData.width;
  c.height = imgData.height;
  c.getContext("2d").putImageData(imgData, 0, 0);
  return c.toDataURL("image/jpeg", 0.92).split(",")[1];
}

async function solveClickNCCPeaksFromFront(front, onProgress = null) {
  return solveClickNCCPeaks(front, onProgress);
}

async function solvePerScale(mainImg, stripImg, scales) {
  const savedFast = [...NCC_SCALES_FAST];
  const savedFull = [...NCC_SCALES];
  const out = [];
  for (const s of scales) {
    NCC_SCALES_FAST.length = 0;
    NCC_SCALES.length = 0;
    NCC_SCALES_FAST.push(s);
    NCC_SCALES.push(s);
    const r = await solveClickNCCPeaksFromImageData(mainImg, stripImg);
    out.push({ scale: s, result: r });
  }
  NCC_SCALES_FAST.push(...savedFast);
  NCC_SCALES.push(...savedFull);
  return out;
}

window.EPD_NCC_SOLVER = {
  version: "preview-scales-1-2-4",
  scales: [...NCC_SCALES_FAST],
  solveClickNCCPeaks,
  solveClickNCCPeaksFromFront,
  solveClickNCCPeaksFromImageData,
  solvePerScale,
};
})();
