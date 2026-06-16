#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const lines = fs.readFileSync(path.join(root, "content.js"), "utf8").split("\n");
const body = lines.slice(1872, 3583).join("\n");

const header = `/* Standalone NCC solver — captcha/ncc-preview.html */
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
  return NCC_FAST ? \`fast+\${mode}\` : \`full+\${mode}\`;
}
function _nccActiveScales() { return NCC_FAST ? NCC_SCALES_FAST : NCC_SCALES; }
function _nccCoarseStep() { return NCC_FAST ? NCC_COARSE_STEP_FAST : NCC_COARSE_STEP; }
function _nccPeakStep() { return NCC_FAST ? NCC_PEAK_STEP_FAST : NCC_COARSE_STEP; }

`;

const footer = `
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
`;

const outPath = path.join(root, "ncc-core.js");
fs.writeFileSync(outPath, header + body + footer, "utf8");
console.log("Wrote", outPath, fs.statSync(outPath).size, "bytes");
