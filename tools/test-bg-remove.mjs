#!/usr/bin/env node
"use strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Jimp, rgbaToInt } from "jimp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAPTCHA_DIR = path.join(__dirname, "..", "captcha");
const OUT_DIR = path.join(CAPTCHA_DIR, "out");

// mirror bg-remove.js (keep in sync)
const PATCHWORK_STROKE_COLORS = [
  [203 / 255, 211 / 255, 232 / 255], // #CBD3E8
  [196 / 255, 229 / 255, 222 / 255], // #C4E5DE
  [200 / 255, 221 / 255, 222 / 255], // #C8DDDE
  [254 / 255, 223 / 255, 229 / 255], // #FEDFE5
  [248 / 255, 253 / 255, 183 / 255], // #F8FDB7
  [214 / 255, 247 / 255, 178 / 255], // #D6F7B2
  [241 / 255, 254 / 255, 188 / 255], // #F1FEBC
  [212 / 255, 232 / 255, 157 / 255], // #D4E89D
  [249 / 255, 254 / 255, 200 / 255], // #F9FEC8
  [239 / 255, 253 / 255, 205 / 255], // #EFFDCD
];
const PATCHWORK_STROKE_CH_TOL = 0.040;
const LOCAL_TILE_BLUR_R = 6;

function patchworkStrokeColorMatch(r, g, b) {
  let best = 0;
  for (const sc of PATCHWORK_STROKE_COLORS) {
    const d = Math.max(Math.abs(r - sc[0]), Math.abs(g - sc[1]), Math.abs(b - sc[2]));
    const m = clamp(1 - d / PATCHWORK_STROKE_CH_TOL, 0, 1);
    if (m > best) best = m;
  }
  return best;
}

const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const hueDist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 1 - d); };

function boxBlur(ch, w, h, r) {
  const rad = Math.max(1, r | 0), tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const diam = rad * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w; let sum = 0;
    for (let x = -rad; x <= rad; x++) sum += ch[row + clamp(x, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / diam;
      sum += ch[row + clamp(x + rad + 1, 0, w - 1)] - ch[row + clamp(x - rad, 0, w - 1)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -rad; y <= rad; y++) sum += tmp[clamp(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / diam;
      sum += tmp[clamp(y + rad + 1, 0, h - 1) * w + x] - tmp[clamp(y - rad, 0, h - 1) * w + x];
    }
  }
  return out;
}

function localStdDev(ch, w, h, r) {
  const mean = boxBlur(ch, w, h, r);
  const sq = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) sq[i] = ch[i] * ch[i];
  const meanSq = boxBlur(sq, w, h, r);
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) { const v = meanSq[i] - mean[i] ** 2; out[i] = v > 0 ? Math.sqrt(v) : 0; }
  return out;
}

function rgbHue(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 0.02) return 0;
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return h / 6;
}

function rgbHueSat(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 0.02) return { h: 0, s: 0 };
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h / 6, s: d };
}

function fineEdge(g, w, h) {
  const e = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    e[i] = Math.hypot(g[i + 1] - g[i - 1], g[i + w] - g[i - w]);
  }
  return e;
}

function detectStyle(hue, sat, edge, gray, w, h) {
  const n = w * h;
  const stdS = localStdDev(gray, w, h, 3);
  let green = 0, texture = 0, avgSat = 0;
  for (let i = 0; i < n; i++) {
    avgSat += sat[i];
    if (hueDist(hue[i], 0.28) < 0.16 && sat[i] < 0.34) green++;
    if (sat[i] > 0.20 && stdS[i] > 0.035) texture++;
  }
    avgSat /= n;
    if (green / n > 0.30) return "patchwork";
    if (avgSat > 0.32) return "gradient";
  if (avgSat > 0.32) return "gradient";
  if (texture / n > 0.06 && avgSat > 0.10) return "pattern";
  return "gradient";
}

function satEdge(sat, w, h) {
  const e = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    e[i] = Math.hypot(sat[i + 1] - sat[i - 1], sat[i + w] - sat[i - w]);
  }
  return e;
}

function localContrastGate(r, g, b, hue, edgeSat, satRes, lumRes, locR, locG, locB, i) {
  const localDist = Math.hypot(r - locR[i], g - locG[i], b - locB[i]);
  const localHueShift = hueDist(hue[i], rgbHue(locR[i], locG[i], locB[i]));
  const es = edgeSat[i];
  if (es < 0.004 || satRes[i] < 0.0007) return 0;
  if (localDist < 0.010 && lumRes[i] < 0.005) return 0;
  return clamp(Math.max(
    (localDist - 0.009) * 12, es * 6.5, satRes[i] * 55, lumRes[i] * 14, (0.060 - localHueShift) * 3.0,
  ), 0, 1);
}

function localStrokeContrastScore(r, g, b, hue, edge, edgeSat, satRes, lumRes, locR, locG, locB, i) {
  const localDist = Math.hypot(r - locR[i], g - locG[i], b - locB[i]);
  const localHueShift = hueDist(hue[i], rgbHue(locR[i], locG[i], locB[i]));
  const es = edgeSat[i];
  if (localDist < 0.009 && es < 0.0035 && lumRes[i] < 0.005) return 0;
  let sig = Math.max(es * 11, satRes[i] * 72, lumRes[i] * 19, localDist * 15);
  if (localHueShift < 0.05 && (es >= 0.0045 || localDist >= 0.012)) sig = Math.max(sig, es * 12, localDist * 18);
  if (sig < 0.05) return 0;
  const e = Math.max(edge[i], es * 2.5);
  return e * sig * clamp((0.095 - localHueShift) * 11, 0.2, 1);
}

function camouflageScore(r, g, b, hue, sat, edge, edgeSat, satRes, lumRes, bgR, bgG, bgB, i, w, h, localGate, localCtr) {
  const y = (i / w) | 0, x = i - y * w;
  const fieldH = Math.min(h, 218);
  const inPinkZone = y > fieldH * 0.60 && x > w * 0.70;
  const inUpperCamoZone = y < fieldH * 0.52 && x > w * 0.62;
  const inBellZone = x <= w * 0.31 && y >= fieldH * 0.66 && y <= fieldH * 0.97;
  const hueShift = hueDist(hue[i], rgbHue(bgR[i], bgG[i], bgB[i]));
  const cool = (b[i] - bgB[i]) - (r[i] - bgR[i]);
  const warm = (r[i] - bgR[i]) - (g[i] - bgG[i]);
  const purple = ((r[i] - bgR[i]) + (b[i] - bgB[i])) * 0.5 - (g[i] - bgG[i]);
  const es = edgeSat[i];
  if (localGate >= 0.22 && es >= 0.003) {
    const e = Math.max(edge[i], es * 2.5);
    return Math.max(localCtr, e * localGate * 0.11);
  }
  if (inBellZone && hueShift < 0.055 && es >= 0.005 && satRes[i] >= 0.001) {
    let sig = Math.max(satRes[i] * 80, es * 10, lumRes[i] * 18, localGate * 0.14);
    return Math.max(edge[i], es * 3) * sig * clamp((0.08 - hueShift) * 18, 0.3, 1);
  }
  const camoYellow = sat[i] > 0.10 && hue[i] > 0.14 && hue[i] < 0.40;
  if (inPinkZone && camoYellow && hueShift < 0.06 && es >= 0.005) {
    let sig = Math.max(satRes[i] * 95, es * 14, lumRes[i] * 22, localGate * 0.12, 0.08);
    return Math.max(edge[i], es * 3.5) * sig * clamp((0.10 - hueShift) * 16, 0.4, 1);
  }
  if (inUpperCamoZone && hueShift < 0.05 && es > 0.020) {
    let sig = Math.max(satRes[i] * 90, es * 12, lumRes[i] * 20);
    if (warm > 0.004 || hue[i] > 0.66 || hue[i] < 0.12) sig = Math.max(sig * 1.35, 0.06);
    else sig = Math.max(sig, es * 5.5);
    return Math.max(edge[i], es * 3.2) * sig * clamp((0.095 - hueShift) * 18, 0.25, 1);
  }
  const gate = Math.max(clamp((hueShift - 0.03) * 8, 0, 1), clamp(cool * 12, 0, 1), clamp(warm * 14, 0, 1), clamp(purple * 16, 0, 1));
  if (gate >= 0.25 || hueShift > 0.075 || (sat[i] < 0.14 && es < 0.02 && purple < 0.004)) return 0;
  let sig = Math.max(satRes[i] * 60, es * 8, lumRes[i] * 15);
  const lavender = (warm > 0.005 || purple > 0.005) && hueShift < 0.065;
  if (lavender) sig = Math.max(sig * 1.5, 0.085);
  const warmPink = warm > 0.008 && (hue[i] > 0.68 || hue[i] < 0.1);
  if (warmPink) sig = Math.max(sig * 1.45, 0.09);
  if (localGate >= 0.24) sig = Math.max(sig * 1.45, localGate * 0.10);
  if (sig < 0.06) return 0;
  return Math.max(edge[i], es * 2.4) * sig * clamp((0.085 - hueShift) * 20, 0, 1);
}

function scorePatchwork(r, g, b, hue, edge, bgR, bgG, bgB, i) {
  const dr = r - bgR[i], dg = g - bgG[i], db = b - bgB[i];
  const colorDist = Math.hypot(dr, dg, db);
  const hueShift = hueDist(hue[i], rgbHue(bgR[i], bgG[i], bgB[i]));
  const cool = (b - bgB[i]) - (r - bgR[i]);
  const warm = (r - bgR[i]) - (g - bgG[i]);
  const purple = ((r - bgR[i]) + (b - bgB[i])) * 0.5 - (g - bgG[i]);
  const chromaGate = clamp((hueShift - 0.03) * 8, 0, 1);
  const coolGate = clamp(cool * 12, 0, 1);
  const warmGate = clamp(warm * 14, 0, 1);
  const purpleGate = clamp(purple * 16, 0, 1);
  const distGate = clamp((colorDist - 0.01) * 9, 0, 1);
  const gate = Math.max(chromaGate, coolGate, warmGate, purpleGate);
  if (gate < 0.12 && colorDist < 0.018) return 0;
  return edge[i] * gate * (0.4 + 0.6 * distGate);
}

function killTintlessSeamRuns(fg, tint, edge, w, h) {
  const minLen = 12;
  const seam = (i) => tint[i] < 0.038 && edge[i] > 0.011;
  const wipeH = () => {
    for (let y = 0; y < h; y++) {
      let run = 0;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (fg[i] > 0.5 && seam(i)) {
          run++;
          if (run >= minLen) {
            for (let k = x - run + 1; k <= x; k++) {
              const fi = y * w + k;
              if (seam(fi)) fg[fi] = 0;
            }
          }
        } else run = 0;
      }
    }
  };
  const wipeV = () => {
    for (let x = 0; x < w; x++) {
      let run = 0;
      for (let y = 0; y < h; y++) {
        const i = y * w + x;
        if (fg[i] > 0.5 && seam(i)) {
          run++;
          if (run >= minLen) {
            for (let k = y - run + 1; k <= y; k++) {
              const fi = k * w + x;
              if (seam(fi)) fg[fi] = 0;
            }
          }
        } else run = 0;
      }
    }
  };
  wipeH();
  wipeV();
}

function growZoneStrokesOnce(fg, tint, score, w, h, soft, zoneFn) {
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    if (!zoneFn(x, y, w, h)) continue;
    const i = y * w + x;
    if (fg[i] > 0.5) continue;
    if (tint[i] < 0.036) continue;
    if (score[i] < soft * 0.9) continue;
    let near = false;
    for (let dy2 = -1; dy2 <= 1; dy2++) for (let dx2 = -1; dx2 <= 1; dx2++) {
      if (!dx2 && !dy2) continue;
      if (fg[(y + dy2) * w + (x + dx2)] > 0.5) { near = true; break; }
    }
    if (near) fg[i] = 1;
  }
}

function growTintStrokesOnce(fg, coolTint, warmTint, hueShift, score, w, h, soft) {
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (fg[i] > 0.5) continue;
    const ct = coolTint[i], wt = warmTint[i], hs = hueShift[i];
    const colored = ct >= 0.032 || wt >= 0.032 || (hs >= 0.058 && score[i] >= soft * 0.85);
    if (!colored) continue;
    if (score[i] < soft && ct < 0.045 && wt < 0.045) continue;
    let near = false;
    for (let dy2 = -1; dy2 <= 1; dy2++) for (let dx2 = -1; dx2 <= 1; dx2++) {
      if (!dx2 && !dy2) continue;
      if (fg[(y + dy2) * w + (x + dx2)] > 0.5) { near = true; break; }
    }
    if (near) fg[i] = 1;
  }
}

function filterPatchworkComponents(score, tint, w, h, thresh) {
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bin[i] = score[i] >= thresh ? 1 : 0;
  const fg = new Float32Array(w * h);
  const seen = new Int32Array(w * h);
  const dx = [1, -1, 0, 0, 1, 1, -1, -1];
  const dy = [0, 0, 1, -1, 1, -1, 1, -1];
  for (let sy = 0; sy < h; sy++) for (let sx = 0; sx < w; sx++) {
    const si = sy * w + sx;
    if (!bin[si] || seen[si]) continue;
    const q = [si]; seen[si] = 1;
    const pixels = [];
    let tintSum = 0, minX = sx, maxX = sx, minY = sy, maxY = sy;
    for (let qi = 0; qi < q.length; qi++) {
      const ci = q[qi]; pixels.push(ci);
      tintSum += tint[ci];
      const cy = (ci / w) | 0, cx = ci - cy * w;
      if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
      for (let d = 0; d < 8; d++) {
        const nx = cx + dx[d], ny = cy + dy[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (!bin[ni] || seen[ni]) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    const area = pixels.length;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const shortSide = Math.min(bw, bh), longSide = Math.max(bw, bh);
    const aspect = longSide / Math.max(1, shortSide);
    const fill = area / (bw * bh);
    const meanTint = tintSum / area;
    const sparse = bw * bh >= 1800 && fill < 0.22;
    const longSeam = aspect > 6.5 && shortSide < 11;
    const lowTint = meanTint < 0.034;
    if (area < 20 || area > 3000 || longSeam || sparse || lowTint) continue;
    if (aspect > 5 && shortSide < 9 && meanTint < 0.042) continue;
    if (area > 600 && fill < 0.11) continue;
    for (const pi of pixels) fg[pi] = 1;
  }
  return fg;
}

function retainStrokeCores(fg, edge, edgeSat, tint, w, h, protect) {
  const fieldH = Math.min(h, 218);
  for (let pass = 0; pass < 2; pass++) for (let y = 1; y < fieldH - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (fg[i] < 0.5) continue;
    if (protect && protect[i]) continue;
    if (bellExclusiveZone(x, y, w, h)) continue;
    if (edge[i] > 0.012 || edgeSat[i] > 0.010) continue;
    if (tint[i] > 0.055) continue;
    let nbr = 0;
    for (let dy2 = -1; dy2 <= 1; dy2++) for (let dx2 = -1; dx2 <= 1; dx2++) {
      if (!dx2 && !dy2) continue;
      if (fg[(y + dy2) * w + (x + dx2)] > 0.5) nbr++;
    }
    if (nbr >= 6) fg[i] = 0;
  }
}

function pruneTileRectFrames(fg, coolTint, warmTint, tint, hue, bgR, bgG, bgB, w, h, protect) {
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bin[i] = fg[i] > 0.5 ? 1 : 0;
  const seen = new Int32Array(w * h);
  const dx = [1, -1, 0, 0, 1, 1, -1, -1];
  const dy = [0, 0, 1, -1, 1, -1, 1, -1];
  for (let sy = 0; sy < h; sy++) for (let sx = 0; sx < w; sx++) {
    const si = sy * w + sx;
    if (!bin[si] || seen[si]) continue;
    const q = [si]; seen[si] = 1; const pixels = [];
    let tintSum = 0, hueShiftSum = 0, prot = 0;
    let minX = sx, maxX = sx, minY = sy, maxY = sy;
    for (let qi = 0; qi < q.length; qi++) {
      const ci = q[qi]; pixels.push(ci);
      tintSum += Math.max(coolTint[ci], warmTint[ci]);
      hueShiftSum += hueDist(hue[ci], rgbHue(bgR[ci], bgG[ci], bgB[ci]));
      if (protect && protect[ci]) prot++;
      const cy = (ci / w) | 0, cx = ci - cy * w;
      if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
      for (let d = 0; d < 8; d++) {
        const nx = cx + dx[d], ny = cy + dy[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (!bin[ni] || seen[ni]) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    const area = pixels.length;
    if (area < 80 || prot > area * 0.25) continue;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const fill = area / (bw * bh);
    const meanTint = tintSum / area;
    const meanHueShift = hueShiftSum / area;
    const aspect = Math.max(bw, bh) / (Math.min(bw, bh) + 1);
    const tileFrame = (bw >= 32 || bh >= 26) && fill >= 0.04 && fill <= 0.32
      && meanTint < 0.052 && meanHueShift < 0.075 && aspect >= 1.15 && aspect <= 6.5 && area <= 3200;
    if (!tileFrame) continue;
    for (const pi of pixels) { if (protect && protect[pi]) continue; fg[pi] = 0; }
  }
}

function thinThickComponents(fg, edgeSat, w, h, protect) {
  const fieldH = Math.min(h, 218);
  const bin = new Uint8Array(w * h);
  for (let y = 0; y < fieldH; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (fg[i] > 0.5) bin[i] = 1;
  }
  const seen = new Int32Array(w * h);
  const dx = [1, -1, 0, 0, 1, 1, -1, -1];
  const dy = [0, 0, 1, -1, 1, -1, 1, -1];
  for (let sy = 0; sy < fieldH; sy++) for (let sx = 0; sx < w; sx++) {
    const si = sy * w + sx;
    if (!bin[si] || seen[si]) continue;
    const q = [si]; seen[si] = 1; const pixels = [];
    let minX = sx, maxX = sx, minY = sy, maxY = sy;
    for (let qi = 0; qi < q.length; qi++) {
      const ci = q[qi]; pixels.push(ci);
      const cy = (ci / w) | 0, cx = ci - cy * w;
      if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
      for (let d = 0; d < 8; d++) {
        const nx = cx + dx[d], ny = cy + dy[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= fieldH) continue;
        const ni = ny * w + nx;
        if (!bin[ni] || seen[ni]) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    const area = pixels.length;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const fill = area / (bw * bh);
    if (area < 45 || fill < 0.28) continue;
    const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5;
    if (bellExclusiveZone(cx | 0, cy | 0, w, h)) continue;
    const mask = new Uint8Array(w * h);
    for (const pi of pixels) mask[pi] = 1;
    let thin = cardinalThin(mask, minX, minY, maxX + 1, maxY + 1, w, h, 2, 3);
    thin = cardinalThin(thin, minX, minY, maxX + 1, maxY + 1, w, h, 2, 3);
    for (const pi of pixels) {
      if (protect && protect[pi]) continue;
      if (thin[pi]) { fg[pi] = 1; continue; }
      if (edgeSat[pi] >= 0.022) { fg[pi] = 1; continue; }
      fg[pi] = 0;
    }
  }
}

function buildPatchworkSeeds(r, g, b, hue, edge, coolEdge, coolTint, warmTint, edgeSat, satRes, camo, bgR, bgG, bgB, w, h) {
  const fieldH = Math.min(h, 218);
  const seed = new Uint8Array(w * h);
  for (let y = 0; y < fieldH; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const hs = hueDist(hue[i], rgbHue(bgR[i], bgG[i], bgB[i]));
    const ct = coolTint[i], wt = warmTint[i];
    const cd = Math.hypot(r[i] - bgR[i], g[i] - bgG[i], b[i] - bgB[i]);
    const e = edge[i], es = edgeSat[i], sr = satRes[i];
    if (e > 0.012 && ct < 0.036 && wt < 0.036 && hs < 0.050 && cd < 0.017) continue;
    if (e < 0.006 && es < 0.005) continue;
    const chroma = ct >= 0.032 || wt >= 0.028 || (hs >= 0.054 && (es >= 0.005 || sr >= 0.0012));
    if (!chroma && camo[i] < 0.012) continue;
    if (cd < 0.008 && ct < 0.040 && wt < 0.040 && camo[i] < 0.015) continue;
    if (bellExclusiveZone(x, y, w, h) && isGreenCamoStroke(hue, edgeSat, satRes, bgR, bgG, bgB, i)) { seed[i] = 1; continue; }
    if (camo[i] >= 0.013 && es >= 0.0055) { seed[i] = 1; continue; }
    const effE = strokeEdge(edge, coolEdge, coolTint, i);
    if (effE >= 0.0065 || es >= 0.006) seed[i] = 1;
  }
  for (let y = 1; y < fieldH - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (seed[i]) continue;
    const hs = hueDist(hue[i], rgbHue(bgR[i], bgG[i], bgB[i]));
    const ct = coolTint[i], wt = warmTint[i];
    if (ct < 0.032 && wt < 0.030 && hs < 0.054) continue;
    if (edgeSat[i] < 0.0055 && edge[i] < 0.0065) continue;
    let near = seed[i - 1] || seed[i + 1] || seed[i - w] || seed[i + w];
    if (near && (ct >= 0.033 || wt >= 0.030 || hs >= 0.056)) seed[i] = 1;
  }
  return seed;
}

function filterSeedComponents(seed, coolTint, warmTint, w, h) {
  const fg = new Float32Array(w * h);
  const seen = new Int32Array(w * h);
  const dx = [1, -1, 0, 0, 1, 1, -1, -1];
  const dy = [0, 0, 1, -1, 1, -1, 1, -1];
  for (let sy = 0; sy < h; sy++) for (let sx = 0; sx < w; sx++) {
    const si = sy * w + sx;
    if (!seed[si] || seen[si]) continue;
    const q = [si]; seen[si] = 1; const pixels = [];
    let tintSum = 0, minX = sx, maxX = sx, minY = sy, maxY = sy;
    for (let qi = 0; qi < q.length; qi++) {
      const ci = q[qi]; pixels.push(ci);
      tintSum += Math.max(coolTint[ci], warmTint[ci]);
      const cy = (ci / w) | 0, cx = ci - cy * w;
      if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
      for (let d = 0; d < 8; d++) {
        const nx = cx + dx[d], ny = cy + dy[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (!seed[ni] || seen[ni]) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    const area = pixels.length;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const shortSide = Math.min(bw, bh), longSide = Math.max(bw, bh);
    const aspect = longSide / Math.max(1, shortSide);
    const fill = area / (bw * bh);
    const meanTint = tintSum / area;
    const sparse = bw * bh >= 1600 && fill < 0.18;
    const longSeam = aspect > 7 && shortSide < 10;
    const tileFrame = (bw >= 30 || bh >= 24) && fill >= 0.04 && fill <= 0.30 && meanTint < 0.050;
    if (area < 6 || area > 3800 || longSeam || sparse || tileFrame) continue;
    if (meanTint < 0.028 && area > 80) continue;
    for (const pi of pixels) fg[pi] = 1;
  }
  return fg;
}

function runPatchworkPipelineV118(
  score, fgOut, r, g, b, hue, sat, edge, coolEdge, coolTint, warmTint, tint,
  satRes, lumRes, edgeSat, camo, bgR, bgG, bgB, w, h, n,
) {
  const effEdge = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const py = (i / w) | 0, px = i - py * w;
    const inFp = fpTopExclusiveZone(px, py, w, h) || fpBottomExclusiveZone(px, py, w, h);
    effEdge[i] = inFp ? edge[i] : strokeEdge(edge, coolEdge, tint, i);
    score[i] = scorePatchwork(r[i], g[i], b[i], hue, effEdge, bgR, bgG, bgB, i);
    if (!inFp && tint[i] > 0.042 && effEdge[i] > 0.008) {
      score[i] = Math.max(score[i], effEdge[i] * tint[i] * 0.72);
    }
    if (!inFp && camo[i] >= 0.011 && tint[i] >= 0.026 && effEdge[i] > 0.005) {
      score[i] = Math.max(score[i], camo[i] * 2.3);
    }
    if (tint[i] < 0.034) score[i] = 0;
  }

  const dil = boxBlur(score, w, h, 1);
  for (let i = 0; i < n; i++) {
    if (tint[i] >= 0.038) score[i] = Math.max(score[i], dil[i] * 0.68);
  }

  const thresh = adaptiveThresh(score, n);
  const fg = filterPatchworkComponents(score, tint, w, h, thresh);
  const orphanFg = mergeOrphanComponents(score, w, h, thresh * 0.90, 20);
  for (let i = 0; i < n; i++) {
    if (orphanFg[i] > 0.5 && tint[i] >= 0.028) fg[i] = 1;
  }
  killTintlessSeamRuns(fg, tint, edge, w, h);
  suppressTileSeamArtifacts(fg, edge, coolEdge, coolTint, tint, hue, bgR, bgG, bgB, w, h, null);

  const fpLayout = selectFpLayout(edge, edgeSat, satRes, coolTint, warmTint, coolEdge, lumRes, camo, w, h);
  if (fpLayout) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!fpLayout.zoneFn(x, y, w, h)) continue;
      fg[y * w + x] = 0;
    }
  }

  const soft = thresh * 0.48;
  growZoneStrokesOnce(fg, tint, score, w, h, soft, bellExclusiveZone);
  if (fpLayout) growZoneStrokesOnce(fg, tint, score, w, h, soft, fpLayout.zoneFn);

  const camoStroke = new Uint8Array(n);
  appendCamouflageFg(fg, camo, edge, edgeSat, coolTint, warmTint, coolEdge, hue, sat, satRes, bgR, bgG, bgB, w, h, camoStroke, fpLayout);
  for (let i = 0; i < n; i++) fg[i] = (fg[i] > 0.5 || camoStroke[i]) ? 1 : 0;

  recoverWarmPinkIcon(fg, edge, edgeSat, satRes, tint, hue, sat, w, h);
  applyPinkZone(fg, camoStroke, edgeSat, satRes, hue, sat, w, h);

  retainStrokeCores(fg, edge, edgeSat, tint, w, h, camoStroke);
  killTintlessSeamRuns(fg, tint, edge, w, h);
  suppressPatchworkLines(fg, edge, tint, coolTint, w, h);
  pruneTileRectFrames(fg, coolTint, warmTint, tint, hue, bgR, bgG, bgB, w, h, camoStroke);
  thinThickComponents(fg, edgeSat, w, h, camoStroke);
  wipeRightMarginSeam(fg, w, h);
  pruneLooseSpecks(fg, w, h, camoStroke, 7);
  recoverBellGreenCamo(fg, edgeSat, satRes, hue, bgR, bgG, bgB, w, h);

  for (let i = 0; i < n; i++) fgOut[i] = fg[i] > 0.5 ? 1 : 0;
  let camoPx = 0;
  for (let i = 0; i < n; i++) if (camoStroke[i] && fgOut[i] > 0.5) camoPx++;
  return { fg: fgOut, style: "patchwork", camoPx };
}

function runPatchworkPipeline(
  score, fgOut, r, g, b, hue, sat, edge, coolEdge, coolTint, warmTint, tint,
  satRes, lumRes, edgeSat, camo, bgR, bgG, bgB, localGate, localCtr, w, h, n,
) {
  const effEdge = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const py = (i / w) | 0, px = i - py * w;
    const inFp = fpTopExclusiveZone(px, py, w, h) || fpBottomExclusiveZone(px, py, w, h);
    effEdge[i] = inFp ? edge[i] : strokeEdge(edge, coolEdge, tint, i);
    score[i] = scorePatchwork(r[i], g[i], b[i], hue, effEdge, bgR, bgG, bgB, i);
    if (!inFp && tint[i] > 0.042 && effEdge[i] > 0.008) {
      score[i] = Math.max(score[i], effEdge[i] * tint[i] * 0.72);
    }
    if (!inFp && camo[i] >= 0.011 && tint[i] >= 0.026 && effEdge[i] > 0.005) {
      score[i] = Math.max(score[i], camo[i] * 2.3);
    }
    if (tint[i] < 0.034) {
      if (camo[i] >= 0.018 && edgeSat[i] >= 0.004 && effEdge[i] > 0.002) {
        score[i] = Math.max(score[i], camo[i] * 2.0);
      } else if (localGate[i] >= 0.20 && effEdge[i] > 0.003) {
        score[i] = Math.max(score[i], effEdge[i] * localGate[i] * 0.80);
      } else if (localCtr[i] > 0.012 && effEdge[i] > 0.002) {
        score[i] = Math.max(score[i], localCtr[i] * 1.6);
      } else if (coolTint[i] >= 0.028 && effEdge[i] > 0.004) {
        score[i] = Math.max(score[i], effEdge[i] * coolTint[i] * 0.68);
      } else {
        score[i] = 0;
      }
    }
  }

  const dil = boxBlur(score, w, h, 1);
  for (let i = 0; i < n; i++) {
    if (tint[i] >= 0.038) score[i] = Math.max(score[i], dil[i] * 0.68);
    else if (tint[i] < 0.034 && camo[i] >= 0.020 && edgeSat[i] >= 0.004) {
      score[i] = Math.max(score[i], dil[i] * 0.55);
    } else if (tint[i] < 0.034 && localGate[i] >= 0.22) {
      score[i] = Math.max(score[i], dil[i] * 0.52);
    }
  }

  const thresh = adaptiveThresh(score, n);
  const fg = filterPatchworkComponents(score, tint, w, h, thresh);
  const orphanFg = mergeOrphanComponents(score, w, h, thresh * 0.90, 20);
  for (let i = 0; i < n; i++) {
    if (orphanFg[i] > 0.5 && (tint[i] >= 0.028 || camo[i] >= 0.022 || localGate[i] >= 0.24)) fg[i] = 1;
  }
  killTintlessSeamRuns(fg, tint, edge, w, h);
  suppressTileSeamArtifacts(fg, edge, coolEdge, coolTint, tint, hue, bgR, bgG, bgB, w, h, null);

  const fpLayout = selectFpLayout(edge, edgeSat, satRes, coolTint, warmTint, coolEdge, lumRes, camo, localGate, w, h);
  const camoLayouts = selectCamoLayouts(edge, edgeSat, satRes, hue, sat, camo, bgR, bgG, bgB, w, h, localGate);
  if (fpLayout) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!fpLayout.zoneFn(x, y, w, h)) continue;
      fg[y * w + x] = 0;
    }
  }

  const soft = thresh * 0.48;
  growZoneStrokesOnce(fg, tint, score, w, h, soft, bellExclusiveZone);
  if (fpLayout && fpLayout.zoneFn === fpBottomExclusiveZone) {
    growZoneStrokesOnce(fg, tint, score, w, h, soft, fpLayout.zoneFn);
  }

  const camoStroke = new Uint8Array(n);
  appendCamouflageFg(fg, camo, edge, edgeSat, coolTint, warmTint, coolEdge, hue, sat, satRes, bgR, bgG, bgB, w, h, camoStroke, fpLayout, camoLayouts);
  for (let i = 0; i < n; i++) fg[i] = (fg[i] > 0.5 || camoStroke[i]) ? 1 : 0;

  if (fpLayout && fpLayout.zoneFn === fpTopExclusiveZone) {
    paintFingerprintZone(fg, null, camo, edge, edgeSat, satRes, coolTint, warmTint, coolEdge, lumRes, hue, sat, bgR, bgG, bgB, localGate, w, h, fpLayout);
  }

  recoverWarmPinkIcon(fg, edge, edgeSat, satRes, tint, hue, sat, w, h);
  applyPinkZone(fg, camoStroke, edgeSat, satRes, hue, sat, w, h, camoLayouts, camo, localGate);

  retainStrokeCores(fg, edge, edgeSat, tint, w, h, camoStroke);
  killTintlessSeamRuns(fg, tint, edge, w, h);
  suppressPatchworkLines(fg, edge, tint, coolTint, w, h);
  pruneTileRectFrames(fg, coolTint, warmTint, tint, hue, bgR, bgG, bgB, w, h, camoStroke);
  thinThickComponents(fg, edgeSat, w, h, camoStroke);
  wipeRightMarginSeam(fg, w, h);
  pruneLooseSpecks(fg, w, h, camoStroke, 7);
  recoverBellGreenCamo(fg, edgeSat, satRes, hue, bgR, bgG, bgB, w, h);

  for (let i = 0; i < n; i++) fgOut[i] = fg[i] > 0.5 ? 1 : 0;
  let camoPx = 0;
  for (let i = 0; i < n; i++) if (camoStroke[i] && fgOut[i] > 0.5) camoPx++;
  return { fg: fgOut, style: "patchwork", camoPx };
}

function mergeOrphanComponents(score, w, h, thresh, minArea) {
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bin[i] = score[i] >= thresh ? 1 : 0;
  const fg = new Float32Array(w * h);
  const seen = new Int32Array(w * h);
  const dx = [1, -1, 0, 0, 1, 1, -1, -1];
  const dy = [0, 0, 1, -1, 1, -1, 1, -1];
  const kept = [], orphans = [];
  for (let sy = 0; sy < h; sy++) for (let sx = 0; sx < w; sx++) {
    const si = sy * w + sx;
    if (!bin[si] || seen[si]) continue;
    const q = [si]; seen[si] = 1; const pixels = [];
    let minX = sx, maxX = sx, minY = sy, maxY = sy;
    for (let qi = 0; qi < q.length; qi++) {
      const ci = q[qi]; pixels.push(ci);
      const cy = (ci / w) | 0, cx = ci - cy * w;
      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
      for (let d = 0; d < 8; d++) {
        const nx = cx + dx[d], ny = cy + dy[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (!bin[ni] || seen[ni]) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    const area = pixels.length;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const ss = Math.min(bw, bh), ls = Math.max(bw, bh);
    if (area > 9000 || (ls / ss > 7 && ss < 14 && ls > 35)) continue;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const blob = { pixels, area, minX, maxX, minY, maxY, cx, cy };
    if (area > 9000 || (ls / ss > 7 && ss < 14 && ls > 35)) continue;
    if (area >= minArea) kept.push(blob);
    else if (area >= 8 && area < minArea) orphans.push(blob);
  }
  for (const blob of kept) for (const pi of blob.pixels) fg[pi] = 1;
  const bboxNear = (a, b, pad) => !(a.maxX + pad < b.minX || a.minX - pad > b.maxX || a.maxY + pad < b.minY || a.minY - pad > b.maxY);
  const nearR = 12;
  for (const orph of orphans) {
    let merge = false;
    for (const kb of kept) {
      const dist = Math.hypot(orph.cx - kb.cx, orph.cy - kb.cy);
      if (dist < 42 && bboxNear(orph, kb, 20)) { merge = true; break; }
    }
    if (merge) { for (const pi of orph.pixels) fg[pi] = 1; continue; }
    for (const pi of orph.pixels) {
      const cy = (pi / w) | 0, cx = pi - cy * w;
      outer: for (let dy2 = -nearR; dy2 <= nearR; dy2++) for (let dx2 = -nearR; dx2 <= nearR; dx2++) {
        if (!dx2 && !dy2) continue;
        const nx = cx + dx2, ny = cy + dy2;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (fg[ny * w + nx] > 0.5) { for (const pj of orph.pixels) fg[pj] = 1; break outer; }
      }
    }
  }
  return boxBlur(fg, w, h, 1);
}

function growIconStrokes(fg, score, edge, tint, coolTint, w, h, thresh) {
  const soft = thresh * 0.50;
  for (let pass = 0; pass < 1; pass++) for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    if (centerSeamCorridor(x, y, w, h)) continue;
    if (pinkExclusiveZone(x, y, w, h)) continue;
    if (fpTopExclusiveZone(x, y, w, h) || fpBottomExclusiveZone(x, y, w, h)) continue;
    const i = y * w + x;
    if (fg[i] > 0.5) continue;
    let hasSignal = score[i] >= soft || (coolTint[i] >= 0.050 && score[i] < 0.015);
    const zoneBoost = bellExclusiveZone(x, y, w, h) || pinkStrokeZone(x, y, w, h) || cloudRecoverZone(x, y, w, h);
    if (!hasSignal && zoneBoost && edge[i] >= 0.006) {
      hasSignal = coolTint[i] >= 0.022 || tint[i] >= 0.022;
    }
    const minEdgeUse = zoneBoost ? 0.006 : 0.009;
    if (!hasSignal || edge[i] < minEdgeUse) continue;
    if (tint[i] < 0.030 && !zoneBoost) continue;
    if (tint[i] < 0.020 && zoneBoost) continue;
    let near = false;
    for (let dy2 = -1; dy2 <= 1; dy2++) for (let dx2 = -1; dx2 <= 1; dx2++) {
      if (!dx2 && !dy2) continue;
      if (fg[(y + dy2) * w + (x + dx2)] > 0.5) { near = true; break; }
    }
    if (near) fg[i] = 1;
  }
}

function relinkNearFg(fg, score, edge, edgeSat, coolTint, tint, w, h, thresh) {
  const soft = thresh * 0.44;
  const fieldH = Math.min(h, 218);
  let added = 0;
  const cap = 900;
  for (let y = 2; y < fieldH - 2; y++) for (let x = 2; x < w - 2; x++) {
    if (added >= cap) return;
    if (centerSeamCorridor(x, y, w, h)) continue;
    if (fpTopExclusiveZone(x, y, w, h) || fpBottomExclusiveZone(x, y, w, h)) continue;
    const i = y * w + x;
    if (fg[i] > 0.5) continue;
    if (score[i] < soft) continue;
    if (tint[i] < 0.032) continue;
    if (edge[i] < 0.007 && edgeSat[i] < 0.007 && coolTint[i] < 0.040) continue;
    let near = false;
    for (let dy2 = -2; dy2 <= 2 && !near; dy2++) for (let dx2 = -2; dx2 <= 2; dx2++) {
      if (!dx2 && !dy2) continue;
      if (fg[(y + dy2) * w + (x + dx2)] > 0.5) { near = true; break; }
    }
    if (!near) continue;
    fg[i] = 1;
    added++;
  }
}

function inCamoHandledZone(x, y, w, h) {
  return camoExclusiveZone(x, y, w, h);
}

function inCoolRecoverZone(x, y, w, h) {
  if (inCamoHandledZone(x, y, w, h)) return false;
  return x > w * 0.06 && x < w * 0.90 && y > h * 0.10 && y < h * 0.94;
}

function strokeEdge(grayEdge, coolEdge, iconTint, i) {
  if (iconTint[i] <= 0.035) return grayEdge[i];
  return Math.max(grayEdge[i], coolEdge[i] * 5);
}

function seedStrongCoolBlobs(fg, edge, coolEdge, coolTint, score, w, h, thresh) {
  const maxScore = thresh * 0.45;
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (fg[i] > 0.5 || score[i] > maxScore) continue;
    if (coolTint[i] >= 0.065 && (edge[i] >= 0.005 || coolEdge[i] >= 0.001)) bin[i] = 1;
  }
  const seen = new Int32Array(w * h);
  const dx = [1, -1, 0, 0, 1, 1, -1, -1];
  const dy = [0, 0, 1, -1, 1, -1, 1, -1];
  for (let sy = 0; sy < h; sy++) for (let sx = 0; sx < w; sx++) {
    const si = sy * w + sx;
    if (!bin[si] || seen[si]) continue;
    const q = [si];
    seen[si] = 1;
    const pixels = [];
    let coolSum = 0;
    let minX = sx, maxX = sx, minY = sy, maxY = sy;
    for (let qi = 0; qi < q.length; qi++) {
      const ci = q[qi];
      pixels.push(ci);
      coolSum += coolTint[ci];
      const cy = (ci / w) | 0, cx = ci - cy * w;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
      for (let d = 0; d < 8; d++) {
        const nx = cx + dx[d], ny = cy + dy[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (!bin[ni] || seen[ni]) continue;
        seen[ni] = 1;
        q.push(ni);
      }
    }
    const area = pixels.length;
    if (area < 15 || area > 450) continue;
    const meanCool = coolSum / area;
    if (meanCool < 0.08) continue;
    const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5;
    if (!inCoolRecoverZone(cx | 0, cy | 0, w, h)) continue;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const aspect = Math.max(bw, bh) / (Math.min(bw, bh) + 1);
    if (aspect > 10 && area > 100) continue;
    for (const pi of pixels) fg[pi] = 1;
  }
}

function growCoolLowEdge(fg, edge, coolEdge, coolTint, score, w, h, thresh, skipTopFp) {
  const maxScore = thresh * 0.42;
  for (let pass = 0; pass < 3; pass++) for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    const i = y * w + x;
    if (skipTopFp && fpTopExclusiveZone(x, y, w, h)) continue;
    if (!inCoolRecoverZone(x, y, w, h)) continue;
    if (centerSeamCorridor(x, y, w, h)) continue;
    if (fg[i] > 0.5 || coolTint[i] < 0.045) continue;
    if (edge[i] < 0.005 && coolEdge[i] < 0.001) continue;
    if (score[i] > maxScore) continue;
    let near = false;
    for (let dy2 = -1; dy2 <= 1; dy2++) for (let dx2 = -1; dx2 <= 1; dx2++) {
      if (!dx2 && !dy2) continue;
      if (fg[(y + dy2) * w + (x + dx2)] > 0.5) { near = true; break; }
    }
    if (near) fg[i] = 1;
  }
}

function bridgePaleCoolComponents(fg, edge, coolEdge, coolTint, score, w, h, thresh) {
  const maxScore = thresh * 0.38;
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (fg[i] > 0.5 || score[i] > maxScore) continue;
    if (coolTint[i] >= 0.06 && (edge[i] >= 0.005 || coolEdge[i] >= 0.001)) bin[i] = 1;
    else if (coolTint[i] >= 0.08 && edge[i] >= 0.007) bin[i] = 1;
  }
  const seen = new Int32Array(w * h);
  const dx = [1, -1, 0, 0, 1, 1, -1, -1];
  const dy = [0, 0, 1, -1, 1, -1, 1, -1];
  for (let sy = 0; sy < h; sy++) for (let sx = 0; sx < w; sx++) {
    const si = sy * w + sx;
    if (!bin[si] || seen[si]) continue;
    const q = [si];
    seen[si] = 1;
    const pixels = [];
    let coolSum = 0, edgeSum = 0;
    let minX = sx, maxX = sx, minY = sy, maxY = sy;
    for (let qi = 0; qi < q.length; qi++) {
      const ci = q[qi];
      pixels.push(ci);
      coolSum += coolTint[ci];
      edgeSum += edge[ci];
      const cy = (ci / w) | 0, cx = ci - cy * w;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
      for (let d = 0; d < 8; d++) {
        const nx = cx + dx[d], ny = cy + dy[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (!bin[ni] || seen[ni]) continue;
        seen[ni] = 1;
        q.push(ni);
      }
    }
    const area = pixels.length;
    if (area < 4 || area > 600) continue;
    const meanCool = coolSum / area;
    const meanEdge = edgeSum / area;
    if (meanCool < 0.048 || meanEdge < 0.0045) continue;
    const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5;
    if (centerSeamCorridor(cx | 0, cy | 0, w, h)) continue;
    let nearFg = false;
    const pad = 3;
    for (let y = minY - pad; y <= maxY + pad && !nearFg; y++) for (let x = minX - pad; x <= maxX + pad; x++) {
      if (y < 0 || x < 0 || y >= h || x >= w) continue;
      if (fg[y * w + x] > 0.5) { nearFg = true; break; }
    }
    if (!nearFg) continue;
    for (const pi of pixels) fg[pi] = 1;
  }
}

function prunePatchworkSpeckle(fg, edge, coolEdge, coolTint, tint, w, h) {
  for (let pass = 0; pass < 3; pass++) for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (fg[i] < 0.5) continue;
    if (tint[i] > 0.08) continue;
    if (coolTint[i] > 0.045 && (edge[i] > 0.008 || coolEdge[i] > 0.001)) continue;
    let nbr = 0;
    for (let dy2 = -1; dy2 <= 1; dy2++) for (let dx2 = -1; dx2 <= 1; dx2++) {
      if (!dx2 && !dy2) continue;
      if (fg[(y + dy2) * w + (x + dx2)] > 0.5) nbr++;
    }
    if (nbr >= 5) continue;
    if (nbr <= 2 && edge[i] < 0.011) fg[i] = 0;
    else if (nbr <= 3 && edge[i] < 0.010 && coolTint[i] < 0.05 && tint[i] < 0.05) fg[i] = 0;
    else if (nbr <= 4 && edge[i] < 0.008 && coolTint[i] < 0.035 && tint[i] < 0.035) fg[i] = 0;
  }
}

function growCoolStrokes(fg, edge, coolEdge, coolTint, score, w, h, thresh, skipTopFp) {
  const maxScore = thresh * 0.35;
  for (let pass = 0; pass < 2; pass++) for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    const i = y * w + x;
    if (fg[i] > 0.5 || coolTint[i] < 0.032) continue;
    if (skipTopFp && fpTopExclusiveZone(x, y, w, h)) continue;
    if (pinkExclusiveZone(x, y, w, h) || pinkStrokeZone(x, y, w, h)) continue;
    if (centerSeamCorridor(x, y, w, h)) continue;
    if (edge[i] < 0.006 && coolEdge[i] < 0.0009) continue;
    if (score[i] > maxScore) continue;
    let near = false;
    for (let dy2 = -1; dy2 <= 1; dy2++) for (let dx2 = -1; dx2 <= 1; dx2++) {
      if (!dx2 && !dy2) continue;
      if (fg[(y + dy2) * w + (x + dx2)] > 0.5) { near = true; break; }
    }
    if (near) fg[i] = 1;
  }
}

function suppressPatchworkLines(fg, edge, tint, coolTint, w, h) {
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = edge[i] > 0.018 && tint[i] < 0.06 && coolTint[i] < 0.05 ? 1 : 0;
  const minLen = 28;
  const zeroH = () => {
    for (let y = 0; y < h; y++) {
      let run = 0;
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (mask[idx]) {
          run++;
          if (run >= minLen) for (let k = x - run + 1; k <= x; k++) {
            const fi = y * w + k;
            if (tint[fi] < 0.06 && coolTint[fi] < 0.05) fg[fi] = 0;
          }
        } else run = 0;
      }
    }
  };
  const zeroV = () => {
    for (let x = 0; x < w; x++) {
      let run = 0;
      for (let y = 0; y < h; y++) {
        const idx = y * w + x;
        if (mask[idx]) {
          run++;
          if (run >= minLen) for (let k = y - run + 1; k <= y; k++) {
            const fi = k * w + x;
            if (tint[fi] < 0.06 && coolTint[fi] < 0.05) fg[fi] = 0;
          }
        } else run = 0;
      }
    }
  };
  zeroH(); zeroV();
}

function suppressTileSeamArtifacts(fg, edge, coolEdge, coolTint, tint, hue, bgR, bgG, bgB, w, h, protect) {
  const isSeam = (i) => {
    if (protect && protect[i]) return false;
    if (coolTint[i] >= 0.072 || tint[i] >= 0.085) return false;
    const lh = rgbHue(bgR[i], bgG[i], bgB[i]);
    const hueShift = hueDist(hue[i], lh);
    if (hueShift >= 0.05) return false;
    return edge[i] > 0.011 || (coolEdge[i] > 0.00085 && coolTint[i] < 0.055);
  };
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = isSeam(i) ? 1 : 0;
  const minLen = 14;
  const centerSeam = (cx, cy) => cx >= w * 0.52 && cx <= w * 0.79 && cy >= h * 0.30 && cy <= h * 0.62;
  const wipeRun = (axis) => {
    if (axis === "h") {
      for (let y = 0; y < h; y++) {
        let run = 0;
        for (let x = 0; x < w; x++) {
          const idx = y * w + x;
          const need = centerSeam(x, y) ? 8 : minLen;
          if (mask[idx] && fg[idx] > 0.5) {
            run++;
            if (run >= need) for (let k = x - run + 1; k <= x; k++) {
              const fi = y * w + k;
              if (isSeam(fi)) fg[fi] = 0;
            }
          } else run = 0;
        }
      }
    } else {
      for (let x = 0; x < w; x++) {
        let run = 0;
        for (let y = 0; y < h; y++) {
          const idx = y * w + x;
          const need = centerSeam(x, y) ? 8 : minLen;
          if (mask[idx] && fg[idx] > 0.5) {
            run++;
            if (run >= need) for (let k = y - run + 1; k <= y; k++) {
              const fi = k * w + x;
              if (isSeam(fi)) fg[fi] = 0;
            }
          } else run = 0;
        }
      }
    }
  };
  wipeRun("h"); wipeRun("v");
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bin[i] = fg[i] > 0.5 && isSeam(i) ? 1 : 0;
  const seen = new Int32Array(w * h);
  const dx = [1, -1, 0, 0, 1, 1, -1, -1];
  const dy = [0, 0, 1, -1, 1, -1, 1, -1];
  for (let sy = 0; sy < h; sy++) for (let sx = 0; sx < w; sx++) {
    const si = sy * w + sx;
    if (!bin[si] || seen[si]) continue;
    const q = [si];
    seen[si] = 1;
    const pixels = [];
    let coolSum = 0;
    let minX = sx, maxX = sx, minY = sy, maxY = sy;
    for (let qi = 0; qi < q.length; qi++) {
      const ci = q[qi];
      pixels.push(ci);
      coolSum += coolTint[ci];
      const cy = (ci / w) | 0, cx = ci - cy * w;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
      for (let d = 0; d < 8; d++) {
        const nx = cx + dx[d], ny = cy + dy[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (!bin[ni] || seen[ni]) continue;
        seen[ni] = 1;
        q.push(ni);
      }
    }
    const area = pixels.length;
    if (area < 3) continue;
    const meanCool = coolSum / area;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const aspect = Math.max(bw, bh) / (Math.min(bw, bh) + 1);
    const drop = (area <= 120 && meanCool < 0.055)
      || (aspect >= 3.5 && area >= 24 && meanCool < 0.058)
      || (aspect >= 2 && area >= 70 && meanCool < 0.056)
      || (minX >= 268 && maxX <= 365 && minY >= 88 && maxY <= 158 && area >= 22 && meanCool < 0.05 && aspect >= 2.5);
    if (!drop) continue;
    for (const pi of pixels) fg[pi] = 0;
  }
}

function appendCamoZone(fg, camo, edge, edgeSat, hue, sat, satRes, bgR, bgG, bgB, w, h, zone) {
  const { x0, y0, x1, y1, anchorX, anchorY, maxDist, profile } = zone;
  const detail = profile === "detail";
  const bin = new Uint8Array(w * h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * w + x;
    if (detail) { if (camo[i] >= 0.014 && edgeSat[i] >= 0.011) bin[i] = 1; }
    else if (camo[i] >= 0.012 && edgeSat[i] >= 0.007) bin[i] = 1;
    else if (sat[i] > 0.10 && hue[i] > 0.14 && hue[i] < 0.40
      && edgeSat[i] >= 0.005 && satRes[i] >= 0.0008) bin[i] = 1;
  }
  if (detail) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * w + x;
    if (bin[i]) continue;
    let adj = false;
    for (let dy2 = -1; dy2 <= 1; dy2++) for (let dx2 = -1; dx2 <= 1; dx2++) {
      if (!dx2 && !dy2) continue;
      const nx = x + dx2, ny = y + dy2;
      if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) continue;
      if (bin[ny * w + nx]) adj = true;
    }
    if (adj && camo[i] >= 0.012 && edgeSat[i] > 0.010) bin[i] = 1;
  }
  const seen = new Int32Array(w * h);
  const dx = [1, -1, 0, 0, 1, 1, -1, -1];
  const dy = [0, 0, 1, -1, 1, -1, 1, -1];
  const blobs = [];
  for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
    const si = sy * w + sx;
    if (!bin[si] || seen[si]) continue;
    const q = [si]; seen[si] = 1; const pixels = [];
    let minX = sx, maxX = sx, minY = sy, maxY = sy;
    for (let qi = 0; qi < q.length; qi++) {
      const ci = q[qi]; pixels.push(ci);
      const cy = (ci / w) | 0, cx = ci - cy * w;
      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
      for (let d = 0; d < 8; d++) {
        const nx = cx + dx[d], ny = cy + dy[d];
        if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) continue;
        const ni = ny * w + nx;
        if (!bin[ni] || seen[ni]) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    const area = pixels.length;
    if (area < 12 || area > 1500) continue;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const dist = Math.hypot(cx - anchorX, cy - anchorY);
    if (dist > maxDist) continue;
    blobs.push({ pixels, area, minX, maxX, minY, maxY, cx, cy });
  }
  if (!blobs.length) return null;
  const bboxNear = (a, b, pad) => !(a.maxX + pad < b.minX || a.minX - pad > b.maxX || a.maxY + pad < b.minY || a.minY - pad > b.maxY);
  blobs.sort((a, b) => b.area - a.area);
  const primary = blobs[0];
  const thin = new Uint8Array(w * h);
  for (const pi of primary.pixels) thin[pi] = 1;
  if (detail) {
    for (let bi = 1; bi < blobs.length; bi++) {
      const b = blobs[bi];
      if (b.area > 120) continue;
      if (Math.hypot(b.cx - primary.cx, b.cy - primary.cy) < 45 || bboxNear(b, primary, 18)) {
        for (const pi of b.pixels) thin[pi] = 1;
      }
    }
    const pad = 2;
    const ix0 = Math.max(x0, primary.minX - pad), ix1 = Math.min(x1, primary.maxX + pad + 1);
    const iy0 = Math.max(y0, primary.minY - pad), iy1 = Math.min(y1, primary.maxY + pad + 1);
    for (let y = iy0; y < iy1; y++) for (let x = ix0; x < ix1; x++) {
      const i = y * w + x;
      if (!thin[i] && camo[i] >= 0.012 && edgeSat[i] >= 0.010) thin[i] = 1;
    }
    for (let pass = 0; pass < 3; pass++) for (let y = y0 + 1; y < y1 - 1; y++) for (let x = x0 + 1; x < x1 - 1; x++) {
      const i = y * w + x;
      if (!thin[i]) continue;
      let nbr = 0;
      for (let dy2 = -1; dy2 <= 1; dy2++) for (let dx2 = -1; dx2 <= 1; dx2++) {
        if (!dx2 && !dy2) continue;
        if (thin[(y + dy2) * w + (x + dx2)]) nbr++;
      }
      if (nbr >= 6 && camo[i] < 0.009 && edgeSat[i] < 0.008) thin[i] = 0;
    }
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      if (!thin[i]) continue;
      if (edgeSat[i] >= 0.011 || camo[i] >= 0.014) continue;
      let strong = 0;
      for (let dy2 = -2; dy2 <= 2; dy2++) for (let dx2 = -2; dx2 <= 2; dx2++) {
        if (!dx2 && !dy2) continue;
        const nx = x + dx2, ny = y + dy2;
        if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) continue;
        const ni = ny * w + nx;
        if (thin[ni] && (edgeSat[ni] >= 0.013 || camo[ni] >= 0.016)) strong++;
      }
      if (strong < 2) thin[i] = 0;
    }
    const dilR = 1;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      if (thin[i]) continue;
      let nearPx = false;
      for (let dy2 = -dilR; dy2 <= dilR && !nearPx; dy2++) for (let dx2 = -dilR; dx2 <= dilR; dx2++) {
        const nx = x + dx2, ny = y + dy2;
        if (nx < ix0 || ny < iy0 || nx >= ix1 || ny >= iy1) continue;
        if (thin[ny * w + nx]) nearPx = true;
      }
      if (nearPx && camo[i] >= 0.012 && edgeSat[i] > 0.010) thin[i] = 1;
    }
    return thin;
  }
  const isPinkStrokeZone = anchorY > h * 0.65;
  for (let pass = 0; pass < (isPinkStrokeZone ? 3 : 5); pass++) for (let y = y0 + 1; y < y1 - 1; y++) for (let x = x0 + 1; x < x1 - 1; x++) {
    const i = y * w + x;
    if (!thin[i]) continue;
    let nbr = 0;
    for (let dy2 = -1; dy2 <= 1; dy2++) for (let dx2 = -1; dx2 <= 1; dx2++) {
      if (!dx2 && !dy2) continue;
      if (thin[(y + dy2) * w + (x + dx2)]) nbr++;
    }
    const nbrCut = isPinkStrokeZone ? 6 : 5;
    if (nbr >= nbrCut && camo[i] < (isPinkStrokeZone ? 0.012 : 0.014) && edgeSat[i] < (isPinkStrokeZone ? 0.010 : 0.012)) thin[i] = 0;
  }
  for (let pass = 0; pass < (isPinkStrokeZone ? 4 : 8); pass++) for (let y = y0 + 1; y < y1 - 1; y++) for (let x = x0 + 1; x < x1 - 1; x++) {
    const i = y * w + x;
    if (!thin[i] || camo[i] >= (isPinkStrokeZone ? 0.016 : 0.022) || edgeSat[i] >= (isPinkStrokeZone ? 0.012 : 0.016)) continue;
    let card = 0;
    if (thin[i - 1]) card++; if (thin[i + 1]) card++;
    if (thin[i - w]) card++; if (thin[i + w]) card++;
    if (card >= (isPinkStrokeZone ? 3 : 2)) thin[i] = 0;
  }
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * w + x;
    if (!thin[i]) continue;
    if (edgeSat[i] >= (isPinkStrokeZone ? 0.009 : 0.016) || camo[i] >= (isPinkStrokeZone ? 0.014 : 0.028)) continue;
    thin[i] = 0;
  }
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * w + x;
    if (thin[i]) continue;
    let adj = false;
    for (let dy2 = -1; dy2 <= 1; dy2++) for (let dx2 = -1; dx2 <= 1; dx2++) {
      if (!dx2 && !dy2) continue;
      const nx = x + dx2, ny = y + dy2;
      if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) continue;
      if (thin[ny * w + nx]) adj = true;
    }
    if (adj && camo[i] >= (isPinkStrokeZone ? 0.014 : 0.024) && edgeSat[i] > (isPinkStrokeZone ? 0.007 : 0.015)) thin[i] = 1;
  }
  return thin;
}

function fpTopExclusiveZone(x, y, w, h) {
  const fieldH = Math.min(h, 218);
  return x >= w * 0.80 && y >= fieldH * 0.08 && y < fieldH * 0.60;
}

function fpBottomExclusiveZone(x, y, w, h) {
  const fieldH = Math.min(h, 218);
  return x <= w * 0.38 && y >= fieldH * 0.58 && y < fieldH * 0.98;
}

function fpExclusiveZone(x, y, w, h) {
  return fpTopExclusiveZone(x, y, w, h) || fpBottomExclusiveZone(x, y, w, h);
}

function wipeFpTopSeams(fg, w, h) {
  const fieldH = Math.min(h, 218);
  const y1 = Math.floor(fieldH * 0.22);
  for (let y = Math.floor(fieldH * 0.08); y < y1; y++) {
    let run = 0, runStart = 0;
    for (let x = Math.floor(w * 0.80); x < w; x++) {
      const i = y * w + x;
      if (!fpTopExclusiveZone(x, y, w, h) || fg[i] < 0.5) {
        if (run >= 12) { for (let rx = runStart; rx < x; rx++) fg[y * w + rx] = 0; }
        run = 0;
        continue;
      }
      if (run === 0) runStart = x;
      run++;
    }
    if (run >= 12) {
      for (let rx = runStart; rx < w; rx++) {
        if (fpTopExclusiveZone(rx, y, w, h)) fg[y * w + rx] = 0;
      }
    }
  }
}

function wipeFpMarginSeam(fg, w, h) {
  const fieldH = Math.min(h, 218);
  for (let y = Math.floor(fieldH * 0.08); y < Math.floor(fieldH * 0.60); y++) for (let x = w - 14; x < w; x++) {
    if (!fpTopExclusiveZone(x, y, w, h)) continue;
    fg[y * w + x] = 0;
  }
}

function pruneFpBlobFills(fg, zoneFn, w, h) {
  const bin = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!zoneFn(x, y, w, h)) continue;
    if (fg[y * w + x] > 0.5) bin[y * w + x] = 1;
  }
  const seen = new Int32Array(w * h);
  const dx = [1, -1, 0, 0, 1, 1, -1, -1];
  const dy = [0, 0, 1, -1, 1, -1, 1, -1];
  for (let sy = 0; sy < h; sy++) for (let sx = 0; sx < w; sx++) {
    if (!zoneFn(sx, sy, w, h)) continue;
    const si = sy * w + sx;
    if (!bin[si] || seen[si]) continue;
    const q = [si]; seen[si] = 1; const pixels = [];
    let minX = sx, maxX = sx, minY = sy, maxY = sy;
    for (let qi = 0; qi < q.length; qi++) {
      const ci = q[qi]; pixels.push(ci);
      const cy = (ci / w) | 0, cx = ci - cy * w;
      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
      for (let d = 0; d < 8; d++) {
        const nx = cx + dx[d], ny = cy + dy[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || !zoneFn(nx, ny, w, h)) continue;
        const ni = ny * w + nx;
        if (!bin[ni] || seen[ni]) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    const area = pixels.length;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const fill = area / (bw * bh);
    if (area < 55) continue;
    const isSeam = bw / Math.max(bh, 1) > 3.2 && area > 70 && bh < 14;
    const isSolid = fill > 0.75 && area > 350 && bw > 16 && bh > 16;
    if (isSeam || isSolid) {
      for (const pi of pixels) fg[pi] = 0;
    }
  }
}

function pinkExclusiveZone(x, y, w, h) {
  const fieldH = Math.min(h, 218);
  return x >= w * 0.815 && y >= fieldH * 0.72;
}

function pinkStrokeZone(x, y, w, h) {
  const fieldH = Math.min(h, 218);
  return x >= w * 0.35 && x <= w * 0.72 && y >= fieldH * 0.55 && y < fieldH * 0.92;
}

function bellExclusiveZone(x, y, w, h) {
  const fieldH = Math.min(h, 218);
  return x <= w * 0.31 && y >= fieldH * 0.66 && y <= fieldH * 0.97;
}

function camoLayoutStroke(i, edge, edgeSat, satRes, hue, sat, camo, bgR, bgG, bgB, localGate) {
  if (localGate[i] >= 0.20 && edgeSat[i] >= 0.003) return true;
  if (camo[i] >= 0.016 && edgeSat[i] >= 0.004) return true;
  if (isGreenCamoStroke(hue, edgeSat, satRes, bgR, bgG, bgB, i)) return true;
  if (isCamoYellowStroke(hue, sat, i) && edgeSat[i] >= 0.005) return true;
  return edge[i] >= 0.004 && satRes[i] >= 0.001 && camo[i] >= 0.010;
}

function selectCamoLayouts(edge, edgeSat, satRes, hue, sat, camo, bgR, bgG, bgB, w, h, localGate) {
  const fieldH = Math.min(h, 218);
  const specs = [
    {
      zoneFn: pinkExclusiveZone, x0: Math.floor(w * 0.815), y0: Math.floor(fieldH * 0.72), x1: w, y1: h,
      anchorX: w * 0.915, anchorY: fieldH * 0.885, maxDist: 55, minSeeds: 8, coreRad: 42, profile: "stroke",
    },
    {
      zoneFn: bellExclusiveZone, x0: Math.floor(w * 0.05), y0: Math.floor(fieldH * 0.66), x1: Math.floor(w * 0.31), y1: Math.floor(fieldH * 0.97),
      anchorX: w * 0.18, anchorY: fieldH * 0.82, maxDist: 50, minSeeds: 12, coreRad: 38, profile: "bell",
    },
  ];
  const active = [];
  for (const spec of specs) {
    let seeds = 0;
    for (let y = spec.y0; y < spec.y1; y++) for (let x = spec.x0; x < spec.x1; x++) {
      if (!spec.zoneFn(x, y, w, h)) continue;
      const i = y * w + x;
      if (!camoLayoutStroke(i, edge, edgeSat, satRes, hue, sat, camo, bgR, bgG, bgB, localGate)) continue;
      if (Math.hypot(x - spec.anchorX, y - spec.anchorY) < spec.coreRad) seeds++;
    }
    if (seeds >= spec.minSeeds) active.push(spec);
  }
  if (!active.length) active.push(specs[0]);
  return active;
}

function cloudRecoverZone(x, y, w, h) {
  const fieldH = Math.min(h, 218);
  return x >= w * 0.26 && x <= w * 0.58 && y >= fieldH * 0.10 && y < fieldH * 0.54;
}

function showerRecoverZone(x, y, w, h) {
  const fieldH = Math.min(h, 218);
  return x >= w * 0.30 && x <= w * 0.62 && y >= fieldH * 0.18 && y < fieldH * 0.55;
}

function centerIconZone(x, y, w, h) {
  const fieldH = Math.min(h, 218);
  return x >= w * 0.48 && x <= w * 0.84 && y >= fieldH * 0.22 && y < fieldH * 0.72;
}

function lockRecoverZone(x, y, w, h) {
  const fieldH = Math.min(h, 218);
  return x >= w * 0.58 && x <= w * 0.82 && y >= fieldH * 0.24 && y < fieldH * 0.58;
}

function sirenRecoverZone(x, y, w, h) {
  const fieldH = Math.min(h, 218);
  return x >= w * 0.70 && x <= w * 0.96 && y >= fieldH * 0.52 && y < fieldH * 0.92;
}

function reseedSparseIconZones(fg, score, edge, edgeSat, coolTint, warmTint, tint, w, h, thresh) {
  const fieldH = Math.min(h, 218);
  const zones = [
    { zoneFn: cloudRecoverZone, anchorX: w * 0.42, anchorY: fieldH * 0.30, minPx: 90, rad: 58, softMul: 0.34 },
    { zoneFn: showerRecoverZone, anchorX: w * 0.46, anchorY: fieldH * 0.36, minPx: 70, rad: 52, softMul: 0.34 },
    { zoneFn: centerIconZone, anchorX: w * 0.66, anchorY: fieldH * 0.46, minPx: 80, rad: 62, softMul: 0.34 },
    { zoneFn: lockRecoverZone, anchorX: w * 0.70, anchorY: fieldH * 0.40, minPx: 45, rad: 42, softMul: 0.30 },
    { zoneFn: sirenRecoverZone, anchorX: w * 0.84, anchorY: fieldH * 0.72, minPx: 50, rad: 48, softMul: 0.30 },
  ];
  for (const z of zones) {
    let px = 0;
    for (let y = 0; y < fieldH; y++) for (let x = 0; x < w; x++) {
      if (!z.zoneFn(x, y, w, h)) continue;
      if (fg[y * w + x] > 0.5) px++;
    }
    if (px >= z.minPx) continue;
    const soft = thresh * z.softMul;
    for (let y = 0; y < fieldH; y++) for (let x = 0; x < w; x++) {
      if (!z.zoneFn(x, y, w, h)) continue;
      if (Math.hypot(x - z.anchorX, y - z.anchorY) > z.rad) continue;
      const i = y * w + x;
      if (fg[i] > 0.5) continue;
      const hasScore = score[i] >= soft
        || (coolTint[i] >= 0.036 && edge[i] >= 0.004)
        || (warmTint[i] >= 0.030 && edgeSat[i] >= 0.004);
      if (!hasScore) continue;
      if (tint[i] < 0.024) continue;
      if (edge[i] < 0.003 && edgeSat[i] < 0.003) continue;
      fg[i] = 1;
    }
  }
}

function mergeFpRingBlobs(bin, x0, y0, x1, y1, anchorX, anchorY, maxDist, w, h) {
  const seen = new Int32Array(w * h);
  const dx = [1, -1, 0, 0, 1, 1, -1, -1];
  const dy = [0, 0, 1, -1, 1, -1, 1, -1];
  const out = new Uint8Array(w * h);
  for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
    const si = sy * w + sx;
    if (!bin[si] || seen[si]) continue;
    const q = [si]; seen[si] = 1;
    const pixels = [];
    let minX = sx, maxX = sx, minY = sy, maxY = sy, minDist = 1e9;
    for (let qi = 0; qi < q.length; qi++) {
      const ci = q[qi]; pixels.push(ci);
      const cy = (ci / w) | 0, cx = ci - cy * w;
      if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
      minDist = Math.min(minDist, Math.hypot(cx - anchorX, cy - anchorY));
      for (let d8 = 0; d8 < 8; d8++) {
        const nx = cx + dx[d8], ny = cy + dy[d8];
        if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) continue;
        const ni = ny * w + nx;
        if (!bin[ni] || seen[ni]) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    const area = pixels.length;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    if (area < 5 || area > 600) continue;
    if (minDist > maxDist) continue;
    if (bw / Math.max(bh, 1) > 3.5 && bh < 12) continue;
    for (const pi of pixels) out[pi] = 1;
  }
  return out;
}

function isGreenCamoStroke(hue, edgeSat, satRes, bgR, bgG, bgB, i) {
  const localHue = rgbHue(bgR[i], bgG[i], bgB[i]);
  return hueDist(hue[i], localHue) < 0.055 && edgeSat[i] >= 0.006 && satRes[i] >= 0.001;
}

function camoExclusiveZone(x, y, w, h) {
  return fpTopExclusiveZone(x, y, w, h) || pinkExclusiveZone(x, y, w, h) || pinkStrokeZone(x, y, w, h);
}

function collectAnchorStrokeMask(bin, x0, y0, x1, y1, anchorX, anchorY, maxDist, minArea, maxArea, mergeFragments, w, h) {
  const seen = new Int32Array(w * h);
  const dx = [1, -1, 0, 0, 1, 1, -1, -1];
  const dy = [0, 0, 1, -1, 1, -1, 1, -1];
  const blobs = [];
  for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
    const si = sy * w + sx;
    if (!bin[si] || seen[si]) continue;
    const q = [si]; seen[si] = 1; const pixels = [];
    let minX = sx, maxX = sx, minY = sy, maxY = sy;
    for (let qi = 0; qi < q.length; qi++) {
      const ci = q[qi]; pixels.push(ci);
      const cy = (ci / w) | 0, cx = ci - cy * w;
      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
      for (let d = 0; d < 8; d++) {
        const nx = cx + dx[d], ny = cy + dy[d];
        if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) continue;
        const ni = ny * w + nx;
        if (!bin[ni] || seen[ni]) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    const area = pixels.length;
    if (area < minArea || area > maxArea) continue;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    if (Math.hypot(cx - anchorX, cy - anchorY) > maxDist) continue;
    blobs.push({ pixels, area, cx, cy });
  }
  if (!blobs.length) return null;
  blobs.sort((a, b) => b.area - a.area);
  const out = new Uint8Array(w * h);
  const primary = blobs[0];
  for (const pi of primary.pixels) out[pi] = 1;
  if (mergeFragments) {
    for (let bi = 1; bi < blobs.length; bi++) {
      const b = blobs[bi];
      if (Math.hypot(b.cx - primary.cx, b.cy - primary.cy) < 32) {
        for (const pi of b.pixels) out[pi] = 1;
      }
    }
  }
  return out;
}

function hollowInterior(mask, x0, y0, x1, y1, w, h, passes, nbrCut) {
  const thin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (mask[i]) thin[i] = 1;
  for (let pass = 0; pass < passes; pass++) for (let y = y0 + 1; y < y1 - 1; y++) for (let x = x0 + 1; x < x1 - 1; x++) {
    const i = y * w + x;
    if (!thin[i]) continue;
    let nbr = 0;
    for (let dy2 = -1; dy2 <= 1; dy2++) for (let dx2 = -1; dx2 <= 1; dx2++) {
      if (!dx2 && !dy2) continue;
      if (thin[(y + dy2) * w + (x + dx2)]) nbr++;
    }
    if (nbr >= nbrCut) thin[i] = 0;
  }
  return thin;
}

function cardinalThin(mask, x0, y0, x1, y1, w, h, passes, cardMin) {
  const thin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (mask[i]) thin[i] = 1;
  for (let pass = 0; pass < passes; pass++) for (let y = y0 + 1; y < y1 - 1; y++) for (let x = x0 + 1; x < x1 - 1; x++) {
    const i = y * w + x;
    if (!thin[i]) continue;
    let card = 0;
    if (thin[i - 1]) card++; if (thin[i + 1]) card++;
    if (thin[i - w]) card++; if (thin[i + w]) card++;
    if (card >= cardMin) thin[i] = 0;
  }
  return thin;
}

function pruneZoneSpecks(fg, zoneFn, w, h, minNbr) {
  for (let pass = 0; pass < 2; pass++) for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    if (!zoneFn(x, y, w, h)) continue;
    const i = y * w + x;
    if (fg[i] < 0.5) continue;
    let nbr = 0;
    for (let dy2 = -1; dy2 <= 1; dy2++) for (let dx2 = -1; dx2 <= 1; dx2++) {
      if (!dx2 && !dy2) continue;
      if (fg[(y + dy2) * w + (x + dx2)] > 0.5) nbr++;
    }
    if (nbr <= minNbr) fg[i] = 0;
  }
}

function isCamoYellowStroke(hue, sat, i) {
  return sat[i] > 0.11 && hue[i] > 0.14 && hue[i] < 0.40;
}

function dilateCardinalOnce(mask, zoneFn, w, h) {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (mask[i]) out[i] = 1;
  const dx = [1, -1, 0, 0], dy = [0, 0, 1, -1];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!zoneFn(x, y, w, h)) continue;
    const i = y * w + x;
    if (mask[i]) continue;
    for (let d = 0; d < 4; d++) {
      const nx = x + dx[d], ny = y + dy[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (mask[ny * w + nx]) { out[i] = 1; break; }
    }
  }
  return out;
}

function pruneZoneIsolated(fg, zoneFn, minNbr, w, h) {
  for (let pass = 0; pass < 2; pass++) for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    if (!zoneFn(x, y, w, h)) continue;
    const i = y * w + x;
    if (fg[i] < 0.5) continue;
    let nbr = 0;
    for (let dy2 = -1; dy2 <= 1; dy2++) for (let dx2 = -1; dx2 <= 1; dx2++) {
      if (!dx2 && !dy2) continue;
      if (fg[(y + dy2) * w + (x + dx2)] > 0.5) nbr++;
    }
    if (nbr < minNbr) fg[i] = 0;
  }
}

function hollowZoneFg(fg, zoneFn, w, h, passes, nbrCut) {
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!zoneFn(x, y, w, h)) continue;
    if (fg[y * w + x] > 0.5) mask[y * w + x] = 1;
  }
  const out = hollowInterior(mask, 0, 0, w, h, w, h, passes, nbrCut);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!zoneFn(x, y, w, h)) continue;
    fg[y * w + x] = out[y * w + x] ? 1 : 0;
  }
}

function paintCamoStrokeLayout(fg, camoStroke, layout, edgeSat, satRes, hue, sat, camo, localGate, w, h) {
  const { x0, y0, x1, y1, zoneFn } = layout;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (!zoneFn(x, y, w, h)) continue;
    const i = y * w + x;
    const seed = camoStroke[i]
      || (localGate[i] >= 0.20 && edgeSat[i] >= 0.003)
      || (isCamoYellowStroke(hue, sat, i) && edgeSat[i] >= 0.006 && satRes[i] >= 0.0008)
      || (camo[i] >= 0.014 && edgeSat[i] >= 0.005);
    fg[i] = seed ? 1 : 0;
  }
  hollowZoneFg(fg, zoneFn, w, h, 1, 7);
  for (let y = y0 + 1; y < y1 - 1; y++) for (let x = x0 + 1; x < x1 - 1; x++) {
    if (!zoneFn(x, y, w, h)) continue;
    const i = y * w + x;
    if (fg[i] > 0.5) continue;
    if (edgeSat[i] < 0.020 || camo[i] < 0.010) continue;
    if (!isCamoYellowStroke(hue, sat, i) && camo[i] < 0.014) continue;
    let near = false;
    for (let dy2 = -1; dy2 <= 1; dy2++) for (let dx2 = -1; dx2 <= 1; dx2++) {
      if (!dx2 && !dy2) continue;
      if (fg[(y + dy2) * w + (x + dx2)] > 0.5) { near = true; break; }
    }
    if (near) fg[i] = 1;
  }
  pruneZoneIsolated(fg, zoneFn, 2, w, h);
}

function paintCamoLayouts(fg, camoStroke, camoLayouts, edgeSat, satRes, hue, sat, camo, localGate, w, h) {
  for (const layout of camoLayouts) {
    if (layout.profile === "bell") continue;
    paintCamoStrokeLayout(fg, camoStroke, layout, edgeSat, satRes, hue, sat, camo, localGate, w, h);
  }
}

function applyPinkZone(fg, camoStroke, edgeSat, satRes, hue, sat, w, h, camoLayouts, camo, localGate) {
  if (camoLayouts && camoLayouts.length) {
    paintCamoLayouts(fg, camoStroke, camoLayouts, edgeSat, satRes, hue, sat, camo || new Float32Array(w * h), localGate, w, h);
    return;
  }
  const fieldH = Math.min(h, 218);
  const x0 = Math.floor(w * 0.815), y0 = Math.floor(fieldH * 0.72);
  for (let y = y0; y < h; y++) for (let x = x0; x < w; x++) {
    const i = y * w + x;
    const seed = camoStroke[i] || (isCamoYellowStroke(hue, sat, i) && edgeSat[i] >= 0.008 && satRes[i] >= 0.001);
    fg[i] = seed ? 1 : 0;
  }
  hollowZoneFg(fg, (x, y, ww, hh) => pinkExclusiveZone(x, y, ww, hh), w, h, 1, 7);
  for (let y = y0 + 1; y < h - 1; y++) for (let x = x0 + 1; x < w - 1; x++) {
    const i = y * w + x;
    if (fg[i] > 0.5) continue;
    if (edgeSat[i] < 0.025 || !isCamoYellowStroke(hue, sat, i)) continue;
    let near = false;
    for (let dy2 = -1; dy2 <= 1; dy2++) for (let dx2 = -1; dx2 <= 1; dx2++) {
      if (!dx2 && !dy2) continue;
      if (fg[(y + dy2) * w + (x + dx2)] > 0.5) { near = true; break; }
    }
    if (near) fg[i] = 1;
  }
  pruneZoneIsolated(fg, (x, y, ww, hh) => pinkExclusiveZone(x, y, ww, hh), 2, w, h);
}

function isStrokeCorePixel(i, edge, coolEdge, coolTint, warmTint, tint) {
  const t = Math.max(coolTint[i], warmTint[i], tint[i]);
  if (t >= 0.048) return true;
  if (t >= 0.036 && edge[i] >= 0.009) return true;
  if (edge[i] > 0.013 && t < 0.038) return false;
  if (coolEdge[i] > 0.001 && coolTint[i] < 0.035) return false;
  return t >= 0.032 && edge[i] >= 0.010;
}

function restoreMainStrokeCore(fg, fgCore, edge, coolEdge, coolTint, warmTint, tint, w, h) {
  for (let i = 0; i < w * h; i++) {
    const py = (i / w) | 0, px = i - py * w;
    if (camoExclusiveZone(px, py, w, h)) continue;
    if (fgCore[i] && isStrokeCorePixel(i, edge, coolEdge, coolTint, warmTint, tint)) fg[i] = 1;
    else if (fg[i] > 0.5 && edge[i] < 0.011 && coolEdge[i] < 0.0012) fg[i] = 0;
  }
  for (let pass = 0; pass < 2; pass++) for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    if (camoExclusiveZone(x, y, w, h)) continue;
    const i = y * w + x;
    if (fg[i] < 0.5 || fgCore[i]) continue;
    let nbr = 0;
    for (let dy2 = -1; dy2 <= 1; dy2++) for (let dx2 = -1; dx2 <= 1; dx2++) {
      if (!dx2 && !dy2) continue;
      if (fg[(y + dy2) * w + (x + dx2)] > 0.5) nbr++;
    }
    if (nbr <= 3) fg[i] = 0;
  }
}

function centerSeamCorridor(x, y, w, h) {
  return x >= w * 0.52 && x <= w * 0.79 && y >= h * 0.30 && y <= h * 0.62;
}

function wipeCorridorSeams(fg, coolTint, w, h) {
  const anchors = [[w * 0.40, h * 0.35, 30], [w * 0.73, h * 0.43, 32]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!centerSeamCorridor(x, y, w, h)) continue;
    let nearIcon = false;
    for (const [ax, ay, rad] of anchors) {
      if (Math.hypot(x - ax, y - ay) < rad) { nearIcon = true; break; }
    }
    if (nearIcon) continue;
    fg[y * w + x] = 0;
  }
}

function wipeStrayNoCore(fg, fgCore, w, h) {
  const fieldH = Math.min(h, 218);
  const x0 = Math.floor(w * 0.84), y1 = Math.floor(fieldH * 0.62);
  for (let y = 0; y < y1; y++) for (let x = x0; x < w; x++) {
    if (fpExclusiveZone(x, y, w, h) || pinkExclusiveZone(x, y, w, h)) continue;
    const i = y * w + x;
    if (fgCore[i]) continue;
    fg[i] = 0;
  }
}

function reapplyMainCore(fg, fgCore, edge, coolEdge, coolTint, warmTint, tint, w, h) {
  for (let i = 0; i < w * h; i++) {
    const py = (i / w) | 0, px = i - py * w;
    if (camoExclusiveZone(px, py, w, h)) continue;
    if (fgCore[i] && isStrokeCorePixel(i, edge, coolEdge, coolTint, warmTint, tint)) fg[i] = 1;
  }
}

function recoverBellGreenCamo(fg, edgeSat, satRes, hue, bgR, bgG, bgB, w, h) {
  const fieldH = Math.min(h, 218);
  const x0 = Math.floor(w * 0.05);
  const y0 = Math.floor(fieldH * 0.66);
  const x1 = Math.floor(w * 0.31);
  const y1 = Math.floor(fieldH * 0.97);
  const n = w * h;
  const orig = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const py = (i / w) | 0, px = i - py * w;
    if (bellExclusiveZone(px, py, w, h) && fg[i] > 0.5) orig[i] = 1;
  }
  const cand = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!bellExclusiveZone(x, y, w, h)) continue;
    const i = y * w + x;
    if (isGreenCamoStroke(hue, edgeSat, satRes, bgR, bgG, bgB, i)) cand[i] = 1;
  }
  const q = [];
  const seen = new Uint8Array(n);
  let origCount = 0;
  for (let i = 0; i < n; i++) {
    if (!orig[i]) continue;
    origCount++;
    q.push(i);
    seen[i] = 1;
  }
  if (origCount < 36) {
    for (let i = 0; i < n; i++) {
      const py = (i / w) | 0, px = i - py * w;
      if (!bellExclusiveZone(px, py, w, h)) continue;
      if (!cand[i] || edgeSat[i] < 0.006) continue;
      fg[i] = 1;
      orig[i] = 1;
      if (!seen[i]) { seen[i] = 1; q.push(i); }
    }
  }
  const dx8 = [1, -1, 0, 0, 1, 1, -1, -1];
  const dy8 = [0, 0, 1, -1, 1, -1, 1, -1];
  for (let qi = 0; qi < q.length; qi++) {
    const ci = q[qi];
    const cy = (ci / w) | 0, cx = ci - cy * w;
    for (let d = 0; d < 8; d++) {
      const nx = cx + dx8[d], ny = cy + dy8[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (!bellExclusiveZone(nx, ny, w, h)) continue;
      const ni = ny * w + nx;
      if (seen[ni] || !cand[ni]) continue;
      seen[ni] = 1;
      q.push(ni);
      fg[ni] = 1;
    }
  }
  hollowZoneFg(fg, bellExclusiveZone, w, h, 2, 6);
  pruneZoneIsolated(fg, bellExclusiveZone, 2, w, h);
}

function recoverWarmPinkIcon(fg, edge, edgeSat, satRes, tint, hue, sat, w, h) {
  const cand = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!pinkStrokeZone(x, y, w, h)) continue;
    const i = y * w + x;
    if (tint[i] >= 0.028 && edgeSat[i] >= 0.006 && satRes[i] >= 0.0008) cand[i] = 1;
    else if (tint[i] >= 0.036 && edge[i] >= 0.006) cand[i] = 1;
  }
  const q = [], seen = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!fg[i]) continue;
    const py = (i / w) | 0, px = i - py * w;
    if (!pinkStrokeZone(px, py, w, h)) continue;
    q.push(i); seen[i] = 1;
  }
  const dx8 = [1, -1, 0, 0, 1, 1, -1, -1], dy8 = [0, 0, 1, -1, 1, -1, 1, -1];
  for (let qi = 0; qi < q.length; qi++) {
    const ci = q[qi];
    const cy = (ci / w) | 0, cx = ci - cy * w;
    for (let d = 0; d < 8; d++) {
      const nx = cx + dx8[d], ny = cy + dy8[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || !pinkStrokeZone(nx, ny, w, h)) continue;
      const ni = ny * w + nx;
      if (seen[ni] || !cand[ni]) continue;
      seen[ni] = 1; q.push(ni); fg[ni] = 1;
    }
  }
  hollowZoneFg(fg, pinkStrokeZone, w, h, 2, 7);
  pruneZoneIsolated(fg, pinkStrokeZone, 2, w, h);
}

function growFpConnected(ring, zoneFn, edgeSat, satRes, coolTint, coolEdge, edge, lumRes, w, h) {
  const cand = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!zoneFn(x, y, w, h)) continue;
    const i = y * w + x;
    if (edgeSat[i] >= 0.006 && satRes[i] >= 0.001 && coolTint[i] >= 0.024) cand[i] = 1;
    else if (edge[i] >= 0.006 && satRes[i] >= 0.0008 && (coolTint[i] >= 0.020 || lumRes[i] >= 0.008)) cand[i] = 1;
    else if (coolEdge[i] >= 0.0007 && lumRes[i] >= 0.007 && edge[i] >= 0.005) cand[i] = 1;
  }
  const out = new Uint8Array(ring);
  const q = [], seen = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (ring[i]) { q.push(i); seen[i] = 1; }
  const dx8 = [1, -1, 0, 0, 1, 1, -1, -1], dy8 = [0, 0, 1, -1, 1, -1, 1, -1];
  for (let qi = 0; qi < q.length; qi++) {
    const ci = q[qi];
    const cy = (ci / w) | 0, cx = ci - cy * w;
    for (let d = 0; d < 8; d++) {
      const nx = cx + dx8[d], ny = cy + dy8[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || !zoneFn(nx, ny, w, h)) continue;
      const ni = ny * w + nx;
      if (seen[ni] || !cand[ni]) continue;
      seen[ni] = 1; q.push(ni); out[ni] = 1;
    }
  }
  return out;
}

function gutFpCenterFill(fg, zoneFn, anchorX, anchorY, rad, w, h) {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!zoneFn(x, y, w, h) || Math.hypot(x - anchorX, y - anchorY) > rad) continue;
    const i = y * w + x;
    if (fg[i] < 0.5) continue;
    let nbr = 0;
    for (let dy2 = -1; dy2 <= 1; dy2++) for (let dx2 = -1; dx2 <= 1; dx2++) {
      if (!dx2 && !dy2) continue;
      if (fg[(y + dy2) * w + (x + dx2)] > 0.5) nbr++;
    }
    if (nbr >= 5) fg[i] = 0;
  }
}

function fpThinStroke(i, edge, edgeSat, satRes, coolTint, warmTint, coolEdge, lumRes, camo, localGate) {
  if (localGate[i] >= 0.20 && edgeSat[i] >= 0.003) return true;
  const tint = Math.max(coolTint[i], warmTint[i]);
  if (edgeSat[i] >= 0.008 && satRes[i] >= 0.0012 && tint >= 0.032) return true;
  if (coolEdge[i] >= 0.001 && tint >= 0.028 && edge[i] >= 0.007) return true;
  if (lumRes[i] >= 0.010 && tint >= 0.026 && edge[i] >= 0.006) return true;
  if (camo[i] >= 0.012 && edgeSat[i] >= 0.008) return true;
  return false;
}

function fpLayoutStroke(i, edge, edgeSat, satRes, coolTint, warmTint, coolEdge, lumRes, camo, topZone, localGate) {
  if (!fpThinStroke(i, edge, edgeSat, satRes, coolTint, warmTint, coolEdge, lumRes, camo, localGate)) return false;
  if (topZone) {
    if (coolTint[i] < 0.038 || coolTint[i] < warmTint[i] * 0.9) return false;
    if (coolEdge[i] < 0.0008 && edgeSat[i] < 0.012) return false;
  } else if (coolTint[i] < 0.035 || coolTint[i] <= warmTint[i]) return false;
  return true;
}

function selectFpLayout(edge, edgeSat, satRes, coolTint, warmTint, coolEdge, lumRes, camo, localGate, w, h) {
  const fieldH = Math.min(h, 218);
  const coreRad = 34;
  const specs = [
    { zoneFn: fpTopExclusiveZone, x0: Math.floor(w * 0.80), y0: Math.floor(fieldH * 0.08), x1: w, y1: Math.floor(fieldH * 0.60), anchorX: w * 0.88, anchorY: fieldH * 0.36, topZone: true },
    { zoneFn: fpBottomExclusiveZone, x0: Math.floor(w * 0.05), y0: Math.floor(fieldH * 0.58), x1: Math.floor(w * 0.38), y1: Math.floor(fieldH * 0.98), anchorX: w * 0.22, anchorY: fieldH * 0.74, topZone: false },
  ];
  const counts = specs.map((spec) => {
    let seeds = 0;
    for (let y = spec.y0; y < spec.y1; y++) for (let x = spec.x0; x < spec.x1; x++) {
      if (!spec.zoneFn(x, y, w, h)) continue;
      const i = y * w + x;
      if (!fpLayoutStroke(i, edge, edgeSat, satRes, coolTint, warmTint, coolEdge, lumRes, camo, spec.topZone, localGate)) continue;
      if (Math.hypot(x - spec.anchorX, y - spec.anchorY) < coreRad) seeds++;
    }
    return seeds;
  });
  const minSeeds = 14;
  const top = counts[0], bot = counts[1];
  if (top >= 80 && bot < top * 2.8) return specs[0];
  if (top >= minSeeds && top >= bot * 1.12) return specs[0];
  if (bot >= minSeeds && bot > top * 1.12) return specs[1];
  if (top >= minSeeds && bot >= minSeeds) return top >= bot ? specs[0] : specs[1];
  if (top >= minSeeds && bot < 10) return specs[0];
  if (bot >= minSeeds && top < 10) return specs[1];
  return null;
}

function wipeInactiveFpZone(fg, fpLayout, w, h) {
  if (!fpLayout) return;
  if (fpLayout.zoneFn === fpTopExclusiveZone) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!fpBottomExclusiveZone(x, y, w, h)) continue;
      if (bellExclusiveZone(x, y, w, h)) continue;
      fg[y * w + x] = 0;
    }
    return;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!fpTopExclusiveZone(x, y, w, h)) continue;
    fg[y * w + x] = 0;
  }
  wipeFpTopSeams(fg, w, h);
  wipeFpMarginSeam(fg, w, h);
}

function paintFpSubzone(fg, zoneFn, x0, y0, x1, y1, anchorX, anchorY, edge, edgeSat, satRes, coolTint, warmTint, coolEdge, lumRes, camo, hue, bgR, bgG, bgB, localGate, w, h) {
  const thin = new Uint8Array(w * h);
  const bottomFp = zoneFn === fpBottomExclusiveZone;
  const minSeeds = bottomFp ? 8 : 12;
  let seeds = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (!zoneFn(x, y, w, h)) continue;
    const i = y * w + x;
    const fpStroke = fpThinStroke(i, edge, edgeSat, satRes, coolTint, warmTint, coolEdge, lumRes, camo, localGate)
      || (bottomFp && isGreenCamoStroke(hue, edgeSat, satRes, bgR, bgG, bgB, i) && edgeSat[i] >= 0.0055);
    if (!fpStroke) continue;
    thin[i] = 1;
    if (Math.hypot(x - anchorX, y - anchorY) < 52) seeds++;
  }
  if (seeds < minSeeds) return;
  const hollow = hollowInterior(thin, x0, y0, x1, y1, w, h, 2, 5);
  const grown = growFpConnected(hollow, zoneFn, edgeSat, satRes, coolTint, coolEdge, edge, lumRes, w, h);
  const out = dilateCardinalOnce(grown, zoneFn, w, h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (!zoneFn(x, y, w, h)) continue;
    const i = y * w + x;
    if (out[i]) fg[i] = 1;
  }
  gutFpCenterFill(fg, zoneFn, anchorX, anchorY, 24, w, h);
}

function paintFingerprintZone(fg, fgCore, camo, edge, edgeSat, satRes, coolTint, warmTint, coolEdge, lumRes, hue, sat, bgR, bgG, bgB, localGate, w, h, fpLayout) {
  const active = fpLayout || selectFpLayout(edge, edgeSat, satRes, coolTint, warmTint, coolEdge, lumRes, camo, localGate, w, h);
  if (!active) return;
  if (active.zoneFn === fpBottomExclusiveZone) return;
  paintFpSubzone(fg, active.zoneFn, active.x0, active.y0, active.x1, active.y1, active.anchorX, active.anchorY, edge, edgeSat, satRes, coolTint, warmTint, coolEdge, lumRes, camo, hue, bgR, bgG, bgB, localGate, w, h);
  wipeFpTopSeams(fg, w, h);
  wipeFpMarginSeam(fg, w, h);
}

function keepAllNearAnchor(fg, zoneFn, ax, ay, maxDist, minArea, w, h) {
  const bin = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!zoneFn(x, y, w, h)) continue;
    if (fg[y * w + x] > 0.5) bin[y * w + x] = 1;
  }
  const keep = new Uint8Array(w * h);
  const seen = new Int32Array(w * h);
  const dx = [1, -1, 0, 0, 1, 1, -1, -1];
  const dy = [0, 0, 1, -1, 1, -1, 1, -1];
  for (let sy = 0; sy < h; sy++) for (let sx = 0; sx < w; sx++) {
    if (!zoneFn(sx, sy, w, h)) continue;
    const si = sy * w + sx;
    if (!bin[si] || seen[si]) continue;
    const q = [si]; seen[si] = 1; const pixels = []; let sumX = 0, sumY = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const ci = q[qi]; pixels.push(ci);
      const cy = (ci / w) | 0, cx = ci - cy * w; sumX += cx; sumY += cy;
      for (let d = 0; d < 8; d++) {
        const nx = cx + dx[d], ny = cy + dy[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || !zoneFn(nx, ny, w, h)) continue;
        const ni = ny * w + nx;
        if (!bin[ni] || seen[ni]) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    if (pixels.length < minArea) continue;
    const cx = sumX / pixels.length, cy = sumY / pixels.length;
    if (Math.hypot(cx - ax, cy - ay) > maxDist) continue;
    for (const pi of pixels) keep[pi] = 1;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!zoneFn(x, y, w, h)) continue;
    fg[y * w + x] = keep[y * w + x] ? 1 : 0;
  }
}

function nearFpAnchor(x, y, w, h, maxDist) {
  const fieldH = Math.min(h, 218);
  return Math.hypot(x - w * 0.80, y - fieldH * 0.36) < (maxDist ?? 48);
}

function pruneCamoAnchorBlob(fg, strokeMask, coolTint, coolEdge, edge, ax, ay, maxDist, w, h) {
  for (let pass = 0; pass < 5; pass++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (Math.hypot(x - ax, y - ay) > maxDist) continue;
    const i = y * w + x;
    if (fg[i] < 0.5) continue;
    if (strokeMask && strokeMask[i]) continue;
    if (coolTint[i] < 0.048) continue;
    if (edge[i] > 0.017 || coolEdge[i] > 0.0022) continue;
    let nbr = 0;
    for (let dy2 = -1; dy2 <= 1; dy2++) for (let dx2 = -1; dx2 <= 1; dx2++) {
      if (!dx2 && !dy2) continue;
      const nx = x + dx2, ny = y + dy2;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (fg[ny * w + nx] > 0.5) nbr++;
    }
    if (nbr >= 5 || (nbr >= 4 && coolEdge[i] < 0.0018 && edge[i] < 0.013)) fg[i] = 0;
  }
}

function prunePatchworkTileSolids(fg, coolTint, warmTint, tint, hue, bgR, bgG, bgB, w, h, protect, fpLayout) {
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bin[i] = fg[i] > 0.5 ? 1 : 0;
  const seen = new Int32Array(w * h);
  const dx = [1, -1, 0, 0, 1, 1, -1, -1];
  const dy = [0, 0, 1, -1, 1, -1, 1, -1];
  for (let sy = 0; sy < h; sy++) for (let sx = 0; sx < w; sx++) {
    const si = sy * w + sx;
    if (!bin[si] || seen[si]) continue;
    const q = [si]; seen[si] = 1; const pixels = [];
    let coolSum = 0, warmSum = 0, tintSum = 0, hueShiftSum = 0, prot = 0;
    let minX = sx, maxX = sx, minY = sy, maxY = sy;
    for (let qi = 0; qi < q.length; qi++) {
      const ci = q[qi]; pixels.push(ci);
      coolSum += coolTint[ci]; warmSum += warmTint[ci]; tintSum += tint[ci];
      hueShiftSum += hueDist(hue[ci], rgbHue(bgR[ci], bgG[ci], bgB[ci]));
      if (protect && protect[ci]) prot++;
      const cy = (ci / w) | 0, cx = ci - cy * w;
      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
      for (let d = 0; d < 8; d++) {
        const nx = cx + dx[d], ny = cy + dy[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (!bin[ni] || seen[ni]) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    const area = pixels.length;
    if (area < 80) continue;
    if (prot > area * 0.35) continue;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const fill = area / (bw * bh);
    const meanTint = tintSum / area, meanCool = coolSum / area;
    const meanHueShift = hueShiftSum / area;
    const aspect = Math.max(bw, bh) / (Math.min(bw, bh) + 1);
    const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5;
    const fpTopLayout = fpLayout && fpLayout.zoneFn === fpTopExclusiveZone;
    const fpBottomLayout = fpLayout && fpLayout.zoneFn === fpBottomExclusiveZone;
    if (fpTopLayout && fpTopExclusiveZone(cx | 0, cy | 0, w, h) && fill < 0.48) continue;
    if (fpBottomLayout && fpBottomExclusiveZone(cx | 0, cy | 0, w, h) && fill < 0.48) continue;
    if (fill < 0.24 && meanCool > 0.042) continue;
    const box = bw * bh;
    const tileSolid = (fill >= 0.46 && meanTint < 0.058 && meanCool < 0.062)
      || (area >= 220 && fill >= 0.34 && meanTint < 0.066 && meanHueShift < 0.055)
      || (bw >= 36 && bh >= 14 && fill >= 0.40 && meanCool < 0.060)
      || (aspect >= 2 && aspect <= 8 && fill >= 0.52 && area >= 110 && meanTint < 0.060)
      || (minY < h * 0.28 && bw >= 28 && fill >= 0.36 && meanTint < 0.064)
      || (box >= 2500 && fill < 0.32)
      || (bw >= 100 && bh >= 65 && fill < 0.34)
      || (area >= 1200 && fill < 0.26);
    if (!tileSolid) continue;
    for (const pi of pixels) { if (protect && protect[pi]) continue; fg[pi] = 0; }
  }
}

function hollowThickGlyphs(fg, w, h, protect) {
  const fieldH = Math.min(h, 218);
  const bin = new Uint8Array(w * h);
  for (let y = 0; y < fieldH; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (fg[i] < 0.5) continue;
    if (protect && protect[i]) continue;
    if (bellExclusiveZone(x, y, w, h)) continue;
    bin[i] = 1;
  }
  const seen = new Int32Array(w * h);
  const dx = [1, -1, 0, 0, 1, 1, -1, -1];
  const dy = [0, 0, 1, -1, 1, -1, 1, -1];
  for (let sy = 0; sy < fieldH; sy++) for (let sx = 0; sx < w; sx++) {
    const si = sy * w + sx;
    if (!bin[si] || seen[si]) continue;
    const q = [si]; seen[si] = 1; const pixels = [];
    let minX = sx, maxX = sx, minY = sy, maxY = sy;
    for (let qi = 0; qi < q.length; qi++) {
      const ci = q[qi]; pixels.push(ci);
      const cy = (ci / w) | 0, cx = ci - cy * w;
      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
      for (let d = 0; d < 8; d++) {
        const nx = cx + dx[d], ny = cy + dy[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= fieldH) continue;
        const ni = ny * w + nx;
        if (!bin[ni] || seen[ni]) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    const area = pixels.length;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const fill = area / (bw * bh);
    if (area < 55 || fill < 0.38) continue;
    const mask = new Uint8Array(w * h);
    for (const pi of pixels) mask[pi] = 1;
    const thin = hollowInterior(mask, minX, minY, maxX + 1, maxY + 1, w, h, 2, 7);
    for (const pi of pixels) {
      if (protect && protect[pi]) continue;
      const py = (pi / w) | 0, px = pi - py * w;
      if (bellExclusiveZone(px, py, w, h)) continue;
      fg[pi] = thin[pi] ? 1 : 0;
    }
  }
}

function appendCamouflageFg(fg, camo, edge, edgeSat, coolTint, warmTint, coolEdge, hue, sat, satRes, bgR, bgG, bgB, w, h, camoStroke, fpLayout, camoLayouts) {
  const fieldH = Math.min(h, 218);
  const zones = (camoLayouts || []).filter((l) => l.profile === "stroke").map((l) => ({
    x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1, anchorX: l.anchorX, anchorY: l.anchorY, maxDist: l.maxDist, profile: "stroke",
  }));
  if (!zones.length) {
    zones.push({ x0: Math.floor(w * 0.815), y0: Math.floor(fieldH * 0.72), x1: w, y1: h, anchorX: w * 0.915, anchorY: fieldH * 0.885, maxDist: 55, profile: "stroke" });
  }
  if (fpLayout && fpLayout.zoneFn === fpTopExclusiveZone) {
    zones.unshift({
      x0: Math.floor(w * 0.80), y0: Math.floor(fieldH * 0.08), x1: w, y1: Math.floor(fieldH * 0.60),
      anchorX: w * 0.88, anchorY: fieldH * 0.36, maxDist: 52, profile: "detail",
    });
  }
  if (fpLayout && fpLayout.zoneFn === fpBottomExclusiveZone) {
    zones.unshift({
      x0: Math.floor(w * 0.05), y0: Math.floor(fieldH * 0.58), x1: Math.floor(w * 0.38), y1: Math.floor(fieldH * 0.98),
      anchorX: w * 0.22, anchorY: fieldH * 0.74, maxDist: 50, profile: "detail",
    });
  }
  const strokeMask = camoStroke || new Uint8Array(w * h);
  for (const z of zones) {
    const thin = appendCamoZone(fg, camo, edge, edgeSat, hue, sat, satRes, bgR, bgG, bgB, w, h, z);
    if (!thin) continue;
    for (let i = 0; i < w * h; i++) {
      if (!thin[i]) continue;
      strokeMask[i] = 1;
      if (z.profile === "detail") fg[i] = 1;
    }
  }
  for (const z of zones) {
    if (z.profile !== "stroke") continue;
    for (let y = z.y0; y < z.y1; y++) for (let x = z.x0; x < z.x1; x++) {
      const i = y * w + x;
      if (strokeMask[i]) { fg[i] = 1; continue; }
      if (warmTint[i] > 0.06 && edge[i] > 0.012) continue;
      if (coolTint[i] > 0.07 && edge[i] > 0.012) continue;
      fg[i] = 0;
    }
  }
}

function pruneLooseSpecks(fg, w, h, protect, minArea) {
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bin[i] = fg[i] > 0.5 ? 1 : 0;
  const seen = new Int32Array(w * h);
  const dx = [1, -1, 0, 0, 1, 1, -1, -1];
  const dy = [0, 0, 1, -1, 1, -1, 1, -1];
  for (let sy = 0; sy < h; sy++) for (let sx = 0; sx < w; sx++) {
    const si = sy * w + sx;
    if (!bin[si] || seen[si]) continue;
    const q = [si]; seen[si] = 1; const pixels = []; let prot = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const ci = q[qi]; pixels.push(ci);
      if (protect && protect[ci]) prot++;
      const cy = (ci / w) | 0, cx = ci - cy * w;
      for (let d = 0; d < 8; d++) {
        const nx = cx + dx[d], ny = cy + dy[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (!bin[ni] || seen[ni]) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    if (pixels.length >= minArea || prot > 0) continue;
    for (const pi of pixels) fg[pi] = 0;
  }
}

function wipeRightMarginSeam(fg, w, h) {
  const fieldH = Math.min(h, 218);
  const x0 = Math.floor(w * 0.91);
  for (let y = 0; y < fieldH; y++) for (let x = x0; x < w; x++) {
    if (fpTopExclusiveZone(x, y, w, h)) continue;
    fg[y * w + x] = 0;
  }
}

function filterComponents(score, w, h, thresh, style) {
  const minArea = style === "pattern" ? 120 : style === "gradient" ? 70 : 35;
  const maxArea = style === "pattern" ? 2800 : 9000;
  const conn8 = style !== "pattern";
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bin[i] = score[i] >= thresh ? 1 : 0;
  const fg = new Float32Array(w * h);
  const seen = new Int32Array(w * h);
  const dx = conn8 ? [1, -1, 0, 0, 1, 1, -1, -1] : [1, -1, 0, 0];
  const dy = conn8 ? [0, 0, 1, -1, 1, -1, 1, -1] : [0, 0, 1, -1];
  const dirs = dx.length;
  for (let sy = 0; sy < h; sy++) for (let sx = 0; sx < w; sx++) {
    const si = sy * w + sx;
    if (!bin[si] || seen[si]) continue;
    const q = [si]; seen[si] = 1; const pixels = [];
    let minX = sx, maxX = sx, minY = sy, maxY = sy;
    for (let qi = 0; qi < q.length; qi++) {
      const ci = q[qi]; pixels.push(ci);
      const cy = (ci / w) | 0, cx = ci - cy * w;
      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
      for (let d = 0; d < dirs; d++) {
        const nx = cx + dx[d], ny = cy + dy[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (!bin[ni] || seen[ni]) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    const area = pixels.length;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const shortSide = Math.min(bw, bh), longSide = Math.max(bw, bh);
    const aspect = longSide / Math.max(1, shortSide);
    if (area < minArea || area > maxArea || (aspect > 7 && shortSide < 14 && longSide > 35) || (area > 250 && area / (longSide * 2) > 12)) continue;
    for (const pi of pixels) fg[pi] = 1;
  }
  return boxBlur(fg, w, h, 1);
}

function adaptiveThresh(score, n) {
  const vals = [];
  for (let i = 0; i < n; i++) if (score[i] > 0.02) vals.push(score[i]);
  if (!vals.length) return 0.2;
  vals.sort((a, b) => a - b);
  const p85 = vals[Math.floor(vals.length * 0.85)];
  const p50 = vals[Math.floor(vals.length * 0.50)];
  return clamp(Math.min(p85 * 0.50, p50 * 1.25), 0.04, 0.20);
}

function computeFg(data, w, mainH, pipeline = "v125") {
  const n = w * mainH;
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
  const gray = new Float32Array(n), hue = new Float32Array(n), sat = new Float32Array(n);
  for (let y = 0; y < mainH; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, o = i * 4;
    r[i] = data[o] / 255; g[i] = data[o + 1] / 255; b[i] = data[o + 2] / 255;
    gray[i] = r[i] * 0.299 + g[i] * 0.587 + b[i] * 0.114;
    const hs = rgbHueSat(r[i], g[i], b[i]); hue[i] = hs.h; sat[i] = hs.s;
  }
  const edge = fineEdge(gray, w, mainH);
  const style = detectStyle(hue, sat, edge, gray, w, mainH);
  const score = new Float32Array(n);

  if (style === "patchwork") {
    const bgR = boxBlur(r, w, mainH, 32), bgG = boxBlur(g, w, mainH, 32), bgB = boxBlur(b, w, mainH, 32);
    const coolRaw = new Float32Array(n);
    for (let i = 0; i < n; i++) coolRaw[i] = (b[i] - bgB[i]) - (r[i] - bgR[i]);
    const coolEdge = fineEdge(coolRaw, w, mainH);
    const tint = new Float32Array(n);
    const coolTint = new Float32Array(n);
    const warmTint = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const warm = (r[i] - bgR[i]) - (g[i] - bgG[i]);
      const cool = coolRaw[i];
      coolTint[i] = clamp(cool * 10, 0, 1);
      warmTint[i] = clamp(warm * 10, 0, 1);
      const purple = ((r[i] - bgR[i]) + (b[i] - bgB[i])) * 0.5 - (g[i] - bgG[i]);
      tint[i] = Math.max(coolTint[i], warmTint[i], clamp(purple * 12, 0, 1));
    }
    const locR = boxBlur(r, w, mainH, LOCAL_TILE_BLUR_R);
    const locG = boxBlur(g, w, mainH, LOCAL_TILE_BLUR_R);
    const locB = boxBlur(b, w, mainH, LOCAL_TILE_BLUR_R);
    const satRing = boxBlur(sat, w, mainH, 3), grayRing = boxBlur(gray, w, mainH, 3);
    const satRes = new Float32Array(n), lumRes = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      satRes[i] = Math.max(0, sat[i] - satRing[i]);
      lumRes[i] = Math.abs(gray[i] - grayRing[i]);
    }
    const edgeSat = satEdge(sat, w, mainH);
    const localGate = new Float32Array(n);
    const localCtr = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      localGate[i] = localContrastGate(r[i], g[i], b[i], hue, edgeSat, satRes, lumRes, locR, locG, locB, i);
      localCtr[i] = localStrokeContrastScore(r[i], g[i], b[i], hue, edge, edgeSat, satRes, lumRes, locR, locG, locB, i);
    }
    const camo = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      camo[i] = camouflageScore(r, g, b, hue, sat, edge, edgeSat, satRes, lumRes, bgR, bgG, bgB, i, w, mainH, localGate[i], localCtr[i]);
    }
    const run = pipeline === "v118" ? runPatchworkPipelineV118 : runPatchworkPipeline;
    return run(
      score, new Float32Array(n), r, g, b, hue, sat, edge, coolEdge, coolTint, warmTint, tint,
      satRes, lumRes, edgeSat, camo, bgR, bgG, bgB, localGate, localCtr, w, mainH, n,
    );
  } else if (style === "pattern") {
    const bgGray = boxBlur(gray, w, mainH, 42);
    for (let i = 0; i < n; i++) {
      if (sat[i] > 0.16) { score[i] = 0; continue; }
      const lumDiff = Math.abs(gray[i] - bgGray[i]);
      if (lumDiff < 0.012) { score[i] = 0; continue; }
      const greyIcon = clamp((0.18 - sat[i]) * 6, 0, 1);
      score[i] = edge[i] * Math.max(greyIcon, clamp(lumDiff * 8 - 0.03, 0, 1)) * 16;
    }
  } else {
    const stdS = localStdDev(gray, w, mainH, 4), stdL = localStdDev(gray, w, mainH, 18);
    for (let i = 0; i < n; i++) {
      const ratio = stdS[i] / (stdL[i] + 0.006);
      score[i] = edge[i] * clamp((ratio - 0.16) * 2.4, 0, 1) * 14;
    }
  }
  if (style !== "pattern") {
    const dil = boxBlur(score, w, mainH, 1);
    for (let i = 0; i < n; i++) score[i] = Math.max(score[i], dil[i] * 0.85);
  }
  let fg = filterComponents(score, w, mainH, adaptiveThresh(score, n), style);
  return { fg, style };
}

function pixelLum(data, i) {
  const o = i * 4;
  return data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114;
}

function findStripContentBounds(data, w, h) {
  let minX = w, maxX = -1, minY = h, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (pixelLum(data, i) > 140) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX) return null;
  return { minX, maxX, minY, maxY };
}

function normalizeStrip(data, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const v = pixelLum(data, i) < 108 ? 0 : 255;
    out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 255;
  }
  return out;
}

function detectStripIconCount(data, w, h) {
  const bounds = findStripContentBounds(data, w, h);
  if (!bounds) return 5;
  const contentW = bounds.maxX - bounds.minX + 1;
  const iconPitch = Math.max(h * 0.78, 14);
  return clamp(Math.round(contentW / iconPitch), 3, 5);
}

function getStripIconSlices(data, w, h, count) {
  const n = count || detectStripIconCount(data, w, h);
  const bounds = findStripContentBounds(data, w, h);
  if (!bounds) return [];
  const { minX, maxX, minY, maxY } = bounds;
  const contentW = maxX - minX + 1;
  const iconW = Math.max(1, Math.floor(contentW / n));
  const slices = [];
  for (let i = 0; i < n; i++) {
    const x0 = minX + i * iconW;
    const x1 = i === n - 1 ? maxX : minX + (i + 1) * iconW - 1;
    slices.push({ x0, x1, y0: minY, y1: maxY });
  }
  return slices;
}

function splitMainH(data, w, h) {
  let top = h;
  for (let y = h - 1; y >= Math.max(0, h - 120); y--) {
    let dark = 0, n = 0;
    for (let x = 0; x < w; x += 4) {
      const o = (y * w + x) * 4;
      if (data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114 < 40) dark++;
      n++;
    }
    if (n && dark / n > 0.75) { top = y; break; }
  }
  while (top > 0) {
    let dark = 0, n = 0;
    for (let x = 0; x < w; x += 4) {
      const o = ((top - 1) * w + x) * 4;
      if (data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114 < 40) dark++;
      n++;
    }
    if (dark / n > 0.6) top--; else break;
  }
  return Math.max(1, top);
}

async function computeFileMetrics(file, pipeline) {
  const t0 = Date.now();
  const img = await Jimp.read(path.join(CAPTCHA_DIR, file));
  const w = img.bitmap.width, h = img.bitmap.height, data = img.bitmap.data;
  const mainH = splitMainH(data, w, h);
  console.log(`  [${pipeline}] ${file} ${w}x${mainH} read ${Date.now() - t0}ms`);
  const t1 = Date.now();
  const { fg, style } = computeFg(data, w, mainH, pipeline);
  console.log(`  [${pipeline}] computeFg ${Date.now() - t1}ms (${style})`);
  let darkPx = 0;
  for (let y = 0; y < mainH; y++) for (let x = 0; x < w; x++) {
    if (fg[y * w + x] > 0.5) darkPx++;
  }
  return { file, style, darkPx, fg, mainH, w };
}

function roiPct(fg, w, x0, y0, x1, y1) {
  let dark = 0;
  const total = (x1 - x0) * (y1 - y0);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (fg[y * w + x] > 0.5) dark++;
  }
  return (dark / total) * 100;
}

const COMPARE_ROIS = [
  {
    file: "epd_captcha_collect_0001_1781257194272.jpg",
    zones: { heart: [40, 30, 120, 100], bell: [10, 150, 140, 210], fp: [380, 20, 470, 130], crown: [250, 80, 340, 160], shower: [180, 60, 280, 150] },
  },
  {
    file: "epd_captcha_collect_0001_1781257441064.jpg",
    zones: { fp: [20, 120, 170, 220], cloud: [130, 20, 250, 120], key: [200, 80, 320, 180], lock: [300, 60, 400, 160], siren: [350, 120, 450, 210] },
  },
  {
    file: "epd_captcha_collect_0002_1781257507651.jpg",
    zones: { crown: [20, 40, 120, 120], heart: [100, 80, 200, 160], flower: [220, 90, 320, 170], cloud: [350, 20, 450, 100], clock: [350, 150, 450, 220] },
  },
  {
    file: "epd_captcha_collect_0004_1781257639422.jpg",
    zones: { siren: [20, 20, 120, 100], keyhole: [150, 20, 250, 100], apple: [350, 20, 450, 100], leaf: [180, 80, 280, 160], doc: [200, 150, 300, 220], compass: [350, 150, 450, 220] },
  },
];

async function compareMain() {
  const cmpFilter = process.argv.find(a => a.endsWith(".jpg"));
  console.log("v118 (baseline) vs v125 (current)\n");
  for (const { file, zones } of COMPARE_ROIS) {
    if (cmpFilter && file !== cmpFilter) continue;
    if (!fs.existsSync(path.join(CAPTCHA_DIR, file))) continue;
    const a = await computeFileMetrics(file, "v118");
    const b = await computeFileMetrics(file, "v125");
    const dd = b.darkPx - a.darkPx;
    console.log(file);
    console.log(`  darkPx  ${a.darkPx} -> ${b.darkPx}  (${dd >= 0 ? "+" : ""}${dd})`);
    for (const [name, [x0, y0, x1, y1]] of Object.entries(zones)) {
      const p118 = roiPct(a.fg, a.w, x0, y0, x1, y1);
      const p119 = roiPct(b.fg, b.w, x0, y0, x1, y1);
      const dp = p119 - p118;
      console.log(`  ${name.padEnd(8)} ${p118.toFixed(1)}% -> ${p119.toFixed(1)}%  (${dp >= 0 ? "+" : ""}${dp.toFixed(1)})`);
    }
  }
}

async function processFile(file, pipeline = "v125") {
  const img = await Jimp.read(path.join(CAPTCHA_DIR, file));
  const w = img.bitmap.width, h = img.bitmap.height, data = img.bitmap.data;
  const mainH = splitMainH(data, w, h);
  const stripH = h - mainH;
  const { fg, style, camoPx } = computeFg(data, w, mainH, pipeline);
  const outH = mainH + (stripH > 4 ? stripH : 0);
  const out = new Jimp({ width: w, height: outH, color: 0xffffffff });
  let px = 0;
  for (let y = 0; y < mainH; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const v = fg[i] > 0.5 ? 0 : 255;
    if (v < 200) px++;
    out.setPixelColor(rgbaToInt(v, v, v, 255), x, y);
  }
  let stripIcons = 0;
  if (stripH > 4) {
    const stripData = new Uint8Array(stripH * w * 4);
    for (let y = 0; y < stripH; y++) {
      stripData.set(data.subarray(((mainH + y) * w) * 4, ((mainH + y + 1) * w) * 4), y * w * 4);
    }
    const norm = normalizeStrip(stripData, w, stripH);
    for (let y = 0; y < stripH; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const v = norm[o];
      out.setPixelColor(rgbaToInt(v, v, v, 255), x, mainH + y);
      if (v < 200) px++;
    }
    stripIcons = getStripIconSlices(stripData, w, stripH).length;
  }
  const base = file.replace(/\.jpe?g$/i, "");
  await out.write(path.join(OUT_DIR, `${base}_bg.png`));
  return { file, style, darkPx: px, camoPx: camoPx || 0, stripIcons, height: outH };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const pick = [
    "epd_captcha_collect_0001_1781257194272.jpg",
    "epd_captcha_collect_0001_1781257338136.jpg",
    "epd_captcha_collect_0003_1781257403197.jpg",
    "epd_captcha_collect_0001_1781257441064.jpg",
    "epd_captcha_collect_0002_1781257507651.jpg",
    "epd_captcha_collect_0004_1781257639422.jpg",
  ];
  for (const f of pick) {
    if (!fs.existsSync(path.join(CAPTCHA_DIR, f))) continue;
    console.log(await processFile(f));
  }
}

if (process.argv.includes("--compare")) {
  compareMain().catch(e => { console.error(e); process.exit(1); });
} else {
  main().catch(e => { console.error(e); process.exit(1); });
}
