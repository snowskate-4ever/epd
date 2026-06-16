"use strict";

// Background removal for click-captcha fields → white bg, black icons.
// Auto styles: patchwork (green tiles), pattern (pink bones), gradient.
// Exposes window.EPD_BG_REMOVE. Version: v106

(function () {
  const BG_REMOVE_VERSION = "v131";

  /** Known patchwork icon stroke colors (absolute RGB, not delta from tile). Extend as we collect samples. */
  const PATCHWORK_STROKE_COLORS = [
    [203 / 255, 211 / 255, 232 / 255], // #CBD3E8 lavender-blue
    [196 / 255, 229 / 255, 222 / 255], // #C4E5DE mint-cyan
    [200 / 255, 221 / 255, 222 / 255], // #C8DDDE grey-cyan
    [254 / 255, 223 / 255, 229 / 255], // #FEDFE5 pale pink
    // Green-camo strokes (yellow-green on green tiles — epd_captcha_collect_0001_*)
    [248 / 255, 253 / 255, 183 / 255], // #F8FDB7
    [214 / 255, 247 / 255, 178 / 255], // #D6F7B2
    [241 / 255, 254 / 255, 188 / 255], // #F1FEBC
    [212 / 255, 232 / 255, 157 / 255], // #D4E89D
    [249 / 255, 254 / 255, 200 / 255], // #F9FEC8
    [239 / 255, 253 / 255, 205 / 255], // #EFFDCD
  ];
  /** Per-channel max dist (~10/255); JPEG shifts strokes e.g. #C9D3E8 vs #CBD3E8. */
  const PATCHWORK_STROKE_CH_TOL = 0.040;
  /** Local tile neighborhood for stroke-vs-tile contrast (not absolute hex). */
  const LOCAL_TILE_BLUR_R = 6;

  function _patchworkStrokeColorMatch(r, g, b) {
    let best = 0;
    for (let c = 0; c < PATCHWORK_STROKE_COLORS.length; c++) {
      const sc = PATCHWORK_STROKE_COLORS[c];
      const d = Math.max(Math.abs(r - sc[0]), Math.abs(g - sc[1]), Math.abs(b - sc[2]));
      const m = _clamp(1 - d / PATCHWORK_STROKE_CH_TOL, 0, 1);
      if (m > best) best = m;
    }
    return best;
  }
  const BG_STD_SMALL_R = 4;
  const BG_STD_LARGE_R = 18;

  function _clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function _hueDist(a, b) {
    const d = Math.abs(a - b);
    return Math.min(d, 1 - d);
  }

  function boxBlurChannel(ch, w, h, r) {
    const rad = Math.max(1, r | 0);
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    const diam = rad * 2 + 1;

    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let x = -rad; x <= rad; x++) sum += ch[row + _clamp(x, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = sum / diam;
        sum += ch[row + _clamp(x + rad + 1, 0, w - 1)] - ch[row + _clamp(x - rad, 0, w - 1)];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -rad; y <= rad; y++) sum += tmp[_clamp(y, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = sum / diam;
        sum += tmp[_clamp(y + rad + 1, 0, h - 1) * w + x] - tmp[_clamp(y - rad, 0, h - 1) * w + x];
      }
    }
    return out;
  }

  function localStdDev(ch, w, h, r) {
    const n = w * h;
    const mean = boxBlurChannel(ch, w, h, r);
    const sq = new Float32Array(n);
    for (let i = 0; i < n; i++) sq[i] = ch[i] * ch[i];
    const meanSq = boxBlurChannel(sq, w, h, r);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = meanSq[i] - mean[i] * mean[i];
      out[i] = v > 0 ? Math.sqrt(v) : 0;
    }
    return out;
  }

  function buildFineEdge(g, w, h) {
    const e = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx = g[i + 1] - g[i - 1];
        const gy = g[i + w] - g[i - w];
        e[i] = Math.sqrt(gx * gx + gy * gy);
      }
    }
    return e;
  }

  function _buildChannelEdge(ch, w, h) {
    return buildFineEdge(ch, w, h);
  }

  function _strokeEdge(grayEdge, coolEdge, iconTint, i) {
    if (iconTint[i] <= 0.035) return grayEdge[i];
    return Math.max(grayEdge[i], coolEdge[i] * 5);
  }

  function _rgbHue(r, gv, b) {
    const max = Math.max(r, gv, b);
    const min = Math.min(r, gv, b);
    const d = max - min;
    if (d < 0.02) return 0;
    let h;
    if (max === r) h = (gv - b) / d + (gv < b ? 6 : 0);
    else if (max === gv) h = (b - r) / d + 2;
    else h = (r - gv) / d + 4;
    return h / 6;
  }

  function _rgbToHueSat(r, gv, b) {
    const max = Math.max(r, gv, b);
    const min = Math.min(r, gv, b);
    const d = max - min;
    if (d < 0.02) return { h: 0, s: 0 };
    let h;
    if (max === r) h = (gv - b) / d + (gv < b ? 6 : 0);
    else if (max === gv) h = (b - r) / d + 2;
    else h = (r - gv) / d + 4;
    return { h: h / 6, s: d };
  }

  function _detectStyle(hue, sat, edge, gray, w, h) {
    const n = w * h;
    const stdS = localStdDev(gray, w, h, 3);
    let green = 0, texture = 0, avgSat = 0;
    for (let i = 0; i < n; i++) {
      avgSat += sat[i];
      if (_hueDist(hue[i], 0.28) < 0.16 && sat[i] < 0.34) green++;
      if (sat[i] > 0.20 && stdS[i] > 0.035) texture++;
    }
    avgSat /= n;
    if (green / n > 0.30) return "patchwork";
    if (avgSat > 0.32) return "gradient";
    if (texture / n > 0.06 && avgSat > 0.10) return "pattern";
    return "gradient";
  }

  function _localContrastGate(r, g, b, hue, edgeSat, satRes, lumRes, locR, locG, locB, i) {
    const localDist = Math.hypot(r - locR[i], g - locG[i], b - locB[i]);
    const localHueShift = _hueDist(hue[i], _rgbHue(locR[i], locG[i], locB[i]));
    const es = edgeSat[i];
    // Tile seams also have localDist+es — require sat/lum ridge, not flat tile edge only.
    if (es < 0.004 || satRes[i] < 0.0007) return 0;
    if (localDist < 0.010 && lumRes[i] < 0.005) return 0;
    return _clamp(Math.max(
      (localDist - 0.009) * 12,
      es * 6.5,
      satRes[i] * 55,
      lumRes[i] * 14,
      (0.060 - localHueShift) * 3.0,
    ), 0, 1);
  }

  function _localStrokeContrastScore(r, g, b, hue, edge, edgeSat, satRes, lumRes, locR, locG, locB, i) {
    const localDist = Math.hypot(r - locR[i], g - locG[i], b - locB[i]);
    const localHueShift = _hueDist(hue[i], _rgbHue(locR[i], locG[i], locB[i]));
    const es = edgeSat[i];
    if (localDist < 0.009 && es < 0.0035 && lumRes[i] < 0.005) return 0;
    let sig = Math.max(es * 11, satRes[i] * 72, lumRes[i] * 19, localDist * 15);
    if (localHueShift < 0.05 && (es >= 0.0045 || localDist >= 0.012)) {
      sig = Math.max(sig, es * 12, localDist * 18);
    }
    if (sig < 0.05) return 0;
    const e = Math.max(edge[i], es * 2.5);
    return e * sig * _clamp((0.095 - localHueShift) * 11, 0.2, 1);
  }

  function _scorePatchwork(r, g, b, hue, edge, bgR, bgG, bgB, i) {
    const dr = r - bgR[i], dg = g - bgG[i], db = b - bgB[i];
    const colorDist = Math.sqrt(dr * dr + dg * dg + db * db);
    const localHue = _rgbHue(bgR[i], bgG[i], bgB[i]);
    const hueShift = _hueDist(hue[i], localHue);
    const cool = (b - bgB[i]) - (r - bgR[i]);
    const warm = (r - bgR[i]) - (g - bgG[i]);
    const purple = ((r - bgR[i]) + (b - bgB[i])) * 0.5 - (g - bgG[i]);
    const chromaGate = _clamp((hueShift - 0.03) * 8, 0, 1);
    const coolGate = _clamp(cool * 12, 0, 1);
    const warmGate = _clamp(warm * 14, 0, 1);
    const purpleGate = _clamp(purple * 16, 0, 1);
    const distGate = _clamp((colorDist - 0.01) * 9, 0, 1);
    const gate = Math.max(chromaGate, coolGate, warmGate, purpleGate);
    if (gate < 0.12 && colorDist < 0.018) return 0;
    return edge[i] * gate * (0.4 + 0.6 * distGate);
  }

  function _buildSatEdge(sat, w, h) {
    const e = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx = sat[i + 1] - sat[i - 1];
        const gy = sat[i + w] - sat[i - w];
        e[i] = Math.sqrt(gx * gx + gy * gy);
      }
    }
    return e;
  }

  /** Camouflaged strokes: sat ring + low main-gate, not blue/cool. */
  function _camouflagePatchworkScore(r, g, b, hue, sat, edge, edgeSat, satRes, lumRes, bgR, bgG, bgB, i, w, h, localGate, localCtr) {
    const y = (i / w) | 0, x = i - y * w;
    const fieldH = Math.min(h, 218);
    const inPinkZone = y > fieldH * 0.60 && x > w * 0.70;
    const inUpperCamoZone = y < fieldH * 0.52 && x > w * 0.62;
    const inBellZone = x <= w * 0.31 && y >= fieldH * 0.66 && y <= fieldH * 0.97;
    const localHue = _rgbHue(bgR[i], bgG[i], bgB[i]);
    const hueShift = _hueDist(hue[i], localHue);
    const cool = (b - bgB[i]) - (r - bgR[i]);
    const warm = (r - bgR[i]) - (g - bgG[i]);
    const purple = ((r - bgR[i]) + (b - bgB[i])) * 0.5 - (g - bgG[i]);
    const es = edgeSat[i];
    if (localGate >= 0.22 && es >= 0.003) {
      const e = Math.max(edge[i], es * 2.5);
      return Math.max(localCtr, e * localGate * 0.11);
    }

    // Camouflaged bell (lower-left): sat-edge ridges on green tile.
    if (inBellZone && hueShift < 0.055 && es >= 0.005 && satRes[i] >= 0.001) {
      let sig = Math.max(satRes[i] * 80, es * 10, lumRes[i] * 18, localGate * 0.14);
      const e = Math.max(edge[i], es * 3);
      return e * sig * _clamp((0.08 - hueShift) * 18, 0.3, 1);
    }

    // Camouflaged yellow-green icon (lower-right): sat-edge on green tile.
    const camoYellow = sat[i] > 0.10 && hue[i] > 0.14 && hue[i] < 0.40;
    if (inPinkZone && camoYellow && hueShift < 0.06 && es >= 0.005) {
      let sig = Math.max(satRes[i] * 95, es * 14, lumRes[i] * 22, localGate * 0.12, 0.08);
      const e = Math.max(edge[i], es * 3.5);
      return e * sig * _clamp((0.10 - hueShift) * 16, 0.4, 1);
    }
    if (inUpperCamoZone && hueShift < 0.05 && es > 0.020) {
      let sig = Math.max(satRes[i] * 90, es * 12, lumRes[i] * 20);
      if (warm > 0.004 || hue[i] > 0.66 || hue[i] < 0.12) sig = Math.max(sig * 1.35, 0.06);
      else sig = Math.max(sig, es * 5.5);
      const e = Math.max(edge[i], es * 3.2);
      return e * sig * _clamp((0.095 - hueShift) * 18, 0.25, 1);
    }

    const gate = Math.max(
      _clamp((hueShift - 0.03) * 8, 0, 1),
      _clamp(cool * 12, 0, 1),
      _clamp(warm * 14, 0, 1),
      _clamp(purple * 16, 0, 1),
    );
    if (gate >= 0.25 || hueShift > 0.075 || (sat[i] < 0.14 && es < 0.02 && purple < 0.004)) return 0;
    let sig = Math.max(satRes[i] * 60, es * 8, lumRes[i] * 15);
    const lavender = (warm > 0.005 || purple > 0.005) && hueShift < 0.065;
    if (lavender) sig = Math.max(sig * 1.5, 0.085);
    const warmPink = warm > 0.008 && (hue[i] > 0.68 || hue[i] < 0.1);
    if (warmPink) sig = Math.max(sig * 1.45, 0.09);
    if (localGate >= 0.24) sig = Math.max(sig * 1.45, localGate * 0.10);
    if (sig < 0.06) return 0;
    const e = Math.max(edge[i], es * 2.4);
    return e * sig * _clamp((0.085 - hueShift) * 20, 0, 1);
  }

  /** Post-pass: camouflaged icons (upper fingerprint + lower pink). */
  function _appendCamoZone(fg, camo, edge, edgeSat, hue, sat, satRes, bgR, bgG, bgB, w, h, zone) {
    const { x0, y0, x1, y1, anchorX, anchorY, maxDist, profile } = zone;
    const detail = profile === "detail";
    const bin = new Uint8Array(w * h);

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * w + x;
        if (detail) {
          if (camo[i] >= 0.014 && edgeSat[i] >= 0.011) bin[i] = 1;
        } else if (camo[i] >= 0.012 && edgeSat[i] >= 0.007) {
          bin[i] = 1;
        } else if (sat[i] > 0.10 && hue[i] > 0.14 && hue[i] < 0.40
          && edgeSat[i] >= 0.005 && satRes[i] >= 0.0008) {
          bin[i] = 1;
        }
      }
    }

    if (detail) {
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * w + x;
          if (bin[i]) continue;
          let adj = false;
          for (let dy2 = -1; dy2 <= 1; dy2++) {
            for (let dx2 = -1; dx2 <= 1; dx2++) {
              if (!dx2 && !dy2) continue;
              const nx = x + dx2, ny = y + dy2;
              if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) continue;
              if (bin[ny * w + nx]) { adj = true; break; }
            }
            if (adj) break;
          }
          if (adj && camo[i] >= 0.012 && edgeSat[i] > 0.010) bin[i] = 1;
        }
      }
    }

    const seen = new Int32Array(w * h);
    const dx = [1, -1, 0, 0, 1, 1, -1, -1];
    const dy = [0, 0, 1, -1, 1, -1, 1, -1];
    const blobs = [];

    for (let sy = y0; sy < y1; sy++) {
      for (let sx = x0; sx < x1; sx++) {
        const si = sy * w + sx;
        if (!bin[si] || seen[si]) continue;
        const q = [si];
        seen[si] = 1;
        const pixels = [];
        let minX = sx, maxX = sx, minY = sy, maxY = sy;

        for (let qi = 0; qi < q.length; qi++) {
          const ci = q[qi];
          pixels.push(ci);
          const cy = (ci / w) | 0, cx = ci - cy * w;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
          for (let d = 0; d < 8; d++) {
            const nx = cx + dx[d], ny = cy + dy[d];
            if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) continue;
            const ni = ny * w + nx;
            if (!bin[ni] || seen[ni]) continue;
            seen[ni] = 1;
            q.push(ni);
          }
        }

        const area = pixels.length;
        if (area < 12 || area > 1500) continue;
        const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5;
        const dist = Math.hypot(cx - anchorX, cy - anchorY);
        if (dist > maxDist) continue;
        blobs.push({ pixels, area, minX, maxX, minY, maxY, cx, cy });
      }
    }

    if (!blobs.length) return null;

    blobs.sort((a, b) => b.area - a.area);
    const primary = blobs[0];
    const thin = new Uint8Array(w * h);
    for (const pi of primary.pixels) thin[pi] = 1;

    if (detail) {
      for (let bi = 1; bi < blobs.length; bi++) {
        const b = blobs[bi];
        if (b.area > 120) continue;
        const near = Math.hypot(b.cx - primary.cx, b.cy - primary.cy) < 45
          || _bboxNear(b, primary, 18);
        if (!near) continue;
        for (const pi of b.pixels) thin[pi] = 1;
      }
      const pad = 2;
      const ix0 = Math.max(x0, primary.minX - pad), ix1 = Math.min(x1, primary.maxX + pad + 1);
      const iy0 = Math.max(y0, primary.minY - pad), iy1 = Math.min(y1, primary.maxY + pad + 1);
      for (let y = iy0; y < iy1; y++) {
        for (let x = ix0; x < ix1; x++) {
          const i = y * w + x;
          if (thin[i]) continue;
          if (camo[i] >= 0.012 && edgeSat[i] >= 0.010) thin[i] = 1;
        }
      }
      for (let pass = 0; pass < 3; pass++) {
        for (let y = y0 + 1; y < y1 - 1; y++) {
          for (let x = x0 + 1; x < x1 - 1; x++) {
            const i = y * w + x;
            if (!thin[i]) continue;
            let nbr = 0;
            for (let dy2 = -1; dy2 <= 1; dy2++) {
              for (let dx2 = -1; dx2 <= 1; dx2++) {
                if (!dx2 && !dy2) continue;
                if (thin[(y + dy2) * w + (x + dx2)]) nbr++;
              }
            }
            if (nbr >= 6 && camo[i] < 0.009 && edgeSat[i] < 0.008) thin[i] = 0;
          }
        }
      }
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * w + x;
          if (!thin[i]) continue;
          if (edgeSat[i] >= 0.011 || camo[i] >= 0.014) continue;
          let strong = 0;
          for (let dy2 = -2; dy2 <= 2; dy2++) {
            for (let dx2 = -2; dx2 <= 2; dx2++) {
              if (!dx2 && !dy2) continue;
              const nx = x + dx2, ny = y + dy2;
              if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) continue;
              const ni = ny * w + nx;
              if (thin[ni] && (edgeSat[ni] >= 0.013 || camo[ni] >= 0.016)) strong++;
            }
          }
          if (strong < 2) thin[i] = 0;
        }
      }
      const dilR = 1;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * w + x;
          if (thin[i]) continue;
          let nearPx = false;
          for (let dy2 = -dilR; dy2 <= dilR && !nearPx; dy2++) {
            for (let dx2 = -dilR; dx2 <= dilR; dx2++) {
              const nx = x + dx2, ny = y + dy2;
              if (nx < ix0 || ny < iy0 || nx >= ix1 || ny >= iy1) continue;
              if (thin[ny * w + nx]) { nearPx = true; break; }
            }
          }
          if (nearPx && camo[i] >= 0.012 && edgeSat[i] > 0.010) thin[i] = 1;
        }
      }
      return thin;
    }

    const isPinkStrokeZone = anchorY > h * 0.65;

    for (let pass = 0; pass < (isPinkStrokeZone ? 3 : 5); pass++) {
      for (let y = y0 + 1; y < y1 - 1; y++) {
        for (let x = x0 + 1; x < x1 - 1; x++) {
          const i = y * w + x;
          if (!thin[i]) continue;
          let nbr = 0;
          for (let dy2 = -1; dy2 <= 1; dy2++) {
            for (let dx2 = -1; dx2 <= 1; dx2++) {
              if (!dx2 && !dy2) continue;
              if (thin[(y + dy2) * w + (x + dx2)]) nbr++;
            }
          }
          const nbrCut = isPinkStrokeZone ? 6 : 5;
          const camoCut = isPinkStrokeZone ? 0.012 : 0.014;
          const esCut = isPinkStrokeZone ? 0.010 : 0.012;
          if (nbr >= nbrCut && camo[i] < camoCut && edgeSat[i] < esCut) thin[i] = 0;
        }
      }
    }

    const cardPasses = isPinkStrokeZone ? 4 : 8;
    const cardMin = isPinkStrokeZone ? 3 : 2;
    for (let pass = 0; pass < cardPasses; pass++) {
      for (let y = y0 + 1; y < y1 - 1; y++) {
        for (let x = x0 + 1; x < x1 - 1; x++) {
          const i = y * w + x;
          const esKeep = isPinkStrokeZone ? 0.012 : 0.016;
          const camoKeep = isPinkStrokeZone ? 0.016 : 0.022;
          if (!thin[i] || camo[i] >= camoKeep || edgeSat[i] >= esKeep) continue;
          let card = 0;
          if (thin[i - 1]) card++;
          if (thin[i + 1]) card++;
          if (thin[i - w]) card++;
          if (thin[i + w]) card++;
          if (card >= cardMin) thin[i] = 0;
        }
      }
    }

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * w + x;
        if (!thin[i]) continue;
        const esKeep = isPinkStrokeZone ? 0.009 : 0.016;
        const camoKeep = isPinkStrokeZone ? 0.014 : 0.028;
        if (edgeSat[i] >= esKeep || camo[i] >= camoKeep) continue;
        thin[i] = 0;
      }
    }

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * w + x;
        if (thin[i]) continue;
        let adj = false;
        for (let dy2 = -1; dy2 <= 1; dy2++) {
          for (let dx2 = -1; dx2 <= 1; dx2++) {
            if (!dx2 && !dy2) continue;
            const nx = x + dx2, ny = y + dy2;
            if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) continue;
            if (thin[ny * w + nx]) { adj = true; break; }
          }
          if (adj) break;
        }
        const camoAdj = isPinkStrokeZone ? 0.014 : 0.024;
        const esAdj = isPinkStrokeZone ? 0.007 : 0.015;
        if (adj && camo[i] >= camoAdj && edgeSat[i] > esAdj) thin[i] = 1;
      }
    }

    return thin;
  }

  function _fpTopExclusiveZone(x, y, w, h) {
    const fieldH = Math.min(h, 218);
    return x >= w * 0.80 && y >= fieldH * 0.08 && y < fieldH * 0.60;
  }

  /** Bottom-left fingerprint (alternate captcha layout). */
  function _fpBottomExclusiveZone(x, y, w, h) {
    const fieldH = Math.min(h, 218);
    return x <= w * 0.38 && y >= fieldH * 0.58 && y < fieldH * 0.98;
  }

  function _fpExclusiveZone(x, y, w, h) {
    return _fpTopExclusiveZone(x, y, w, h) || _fpBottomExclusiveZone(x, y, w, h);
  }

  /** Top tile-seam brackets in FP zone — not fingerprint ridges. */
  function _wipeFpTopSeams(fg, w, h) {
    const fieldH = Math.min(h, 218);
    const y1 = Math.floor(fieldH * 0.22);
    for (let y = Math.floor(fieldH * 0.08); y < y1; y++) {
      let run = 0, runStart = 0;
      for (let x = Math.floor(w * 0.80); x < w; x++) {
        const i = y * w + x;
        if (!_fpTopExclusiveZone(x, y, w, h) || fg[i] < 0.5) {
          if (run >= 12) {
            for (let rx = runStart; rx < x; rx++) fg[y * w + rx] = 0;
          }
          run = 0;
          continue;
        }
        if (run === 0) runStart = x;
        run++;
      }
      if (run >= 12) {
        for (let rx = runStart; rx < w; rx++) {
          if (_fpTopExclusiveZone(rx, y, w, h)) fg[y * w + rx] = 0;
        }
      }
    }
  }

  /** Right-edge tile seams — not fingerprint strokes. */
  function _wipeFpMarginSeam(fg, w, h) {
    const fieldH = Math.min(h, 218);
    for (let y = Math.floor(fieldH * 0.08); y < Math.floor(fieldH * 0.60); y++) {
      for (let x = w - 14; x < w; x++) {
        if (!_fpTopExclusiveZone(x, y, w, h)) continue;
        fg[y * w + x] = 0;
      }
    }
  }

  /** Drop wide horizontal tile seams; compact solids after hollow. */
  function _pruneFpBlobFills(fg, zoneFn, w, h) {
    const bin = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!zoneFn(x, y, w, h)) continue;
        if (fg[y * w + x] > 0.5) bin[y * w + x] = 1;
      }
    }
    const seen = new Int32Array(w * h);
    const dx = [1, -1, 0, 0, 1, 1, -1, -1];
    const dy = [0, 0, 1, -1, 1, -1, 1, -1];
    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        if (!zoneFn(sx, sy, w, h)) continue;
        const si = sy * w + sx;
        if (!bin[si] || seen[si]) continue;
        const q = [si];
        seen[si] = 1;
        const pixels = [];
        let minX = sx, maxX = sx, minY = sy, maxY = sy;
        for (let qi = 0; qi < q.length; qi++) {
          const ci = q[qi];
          pixels.push(ci);
          const cy = (ci / w) | 0, cx = ci - cy * w;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
          for (let d = 0; d < 8; d++) {
            const nx = cx + dx[d], ny = cy + dy[d];
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (!zoneFn(nx, ny, w, h)) continue;
            const ni = ny * w + nx;
            if (!bin[ni] || seen[ni]) continue;
            seen[ni] = 1;
            q.push(ni);
          }
        }
        const area = pixels.length;
        const bw = maxX - minX + 1;
        const bh = maxY - minY + 1;
        const fill = area / (bw * bh);
        if (area < 55) continue;
        const isSeam = bw / Math.max(bh, 1) > 3.2 && area > 70 && bh < 14;
        const isSolid = fill > 0.75 && area > 350 && bw > 16 && bh > 16;
        if (isSeam || isSolid) {
          for (const pi of pixels) fg[pi] = 0;
        }
      }
    }
  }

  /** Tile-seam corridor between cloud and crown — block cool-grow bridges. */
  function _centerSeamCorridor(x, y, w, h) {
    return x >= w * 0.52 && x <= w * 0.79 && y >= h * 0.30 && y <= h * 0.62;
  }

  function _pinkExclusiveZone(x, y, w, h) {
    const fieldH = Math.min(h, 218);
    return x >= w * 0.815 && y >= fieldH * 0.72;
  }

  /** Center-bottom pink siren / warm icon (not bottom-right pink tile). */
  function _pinkStrokeZone(x, y, w, h) {
    const fieldH = Math.min(h, 218);
    return x >= w * 0.35 && x <= w * 0.72 && y >= fieldH * 0.55 && y < fieldH * 0.92;
  }

  /** Bottom-left bell on green tile — camouflaged strokes. */
  function _bellExclusiveZone(x, y, w, h) {
    const fieldH = Math.min(h, 218);
    return x <= w * 0.31 && y >= fieldH * 0.66 && y <= fieldH * 0.97;
  }

  /** Sat-edge / camo stroke pixel — icon shape and color agnostic. */
  function _camoLayoutStroke(i, edge, edgeSat, satRes, hue, sat, camo, bgR, bgG, bgB, localGate) {
    if (localGate[i] >= 0.20 && edgeSat[i] >= 0.003) return true;
    if (camo[i] >= 0.016 && edgeSat[i] >= 0.004) return true;
    if (_isGreenCamoStroke(hue, edgeSat, satRes, bgR, bgG, bgB, i)) return true;
    if (_isCamoYellowStroke(hue, sat, i) && edgeSat[i] >= 0.005) return true;
    return edge[i] >= 0.004 && satRes[i] >= 0.001 && camo[i] >= 0.010;
  }

  /** Active camouflaged-icon corners (may be 0–2 per captcha). */
  function _selectCamoLayouts(edge, edgeSat, satRes, hue, sat, camo, bgR, bgG, bgB, w, h, localGate) {
    const fieldH = Math.min(h, 218);
    const specs = [
      {
        zoneFn: _pinkExclusiveZone,
        x0: Math.floor(w * 0.815),
        y0: Math.floor(fieldH * 0.72),
        x1: w,
        y1: h,
        anchorX: w * 0.915,
        anchorY: fieldH * 0.885,
        maxDist: 55,
        minSeeds: 8,
        coreRad: 42,
        profile: "stroke",
      },
      {
        zoneFn: _bellExclusiveZone,
        x0: Math.floor(w * 0.05),
        y0: Math.floor(fieldH * 0.66),
        x1: Math.floor(w * 0.31),
        y1: Math.floor(fieldH * 0.97),
        anchorX: w * 0.18,
        anchorY: fieldH * 0.82,
        maxDist: 50,
        minSeeds: 12,
        coreRad: 38,
        profile: "bell",
      },
    ];
    const active = [];
    for (const spec of specs) {
      let seeds = 0;
      for (let y = spec.y0; y < spec.y1; y++) {
        for (let x = spec.x0; x < spec.x1; x++) {
          if (!spec.zoneFn(x, y, w, h)) continue;
          const i = y * w + x;
          if (!_camoLayoutStroke(i, edge, edgeSat, satRes, hue, sat, camo, bgR, bgG, bgB, localGate)) continue;
          if (Math.hypot(x - spec.anchorX, y - spec.anchorY) < spec.coreRad) seeds++;
        }
      }
      if (seeds >= spec.minSeeds) active.push(spec);
    }
    if (!active.length) active.push(specs[0]);
    return active;
  }

  function _isGreenCamoStroke(hue, edgeSat, satRes, bgR, bgG, bgB, i) {
    const localHue = _rgbHue(bgR[i], bgG[i], bgB[i]);
    return _hueDist(hue[i], localHue) < 0.055
      && edgeSat[i] >= 0.006
      && satRes[i] >= 0.001;
  }

  function _camoExclusiveZone(x, y, w, h) {
    return _fpTopExclusiveZone(x, y, w, h) || _pinkExclusiveZone(x, y, w, h) || _pinkStrokeZone(x, y, w, h);
  }

  function _collectAnchorStrokeMask(bin, x0, y0, x1, y1, anchorX, anchorY, maxDist, minArea, maxArea, mergeFragments, w, h) {
    const seen = new Int32Array(w * h);
    const dx = [1, -1, 0, 0, 1, 1, -1, -1];
    const dy = [0, 0, 1, -1, 1, -1, 1, -1];
    const blobs = [];

    for (let sy = y0; sy < y1; sy++) {
      for (let sx = x0; sx < x1; sx++) {
        const si = sy * w + sx;
        if (!bin[si] || seen[si]) continue;
        const q = [si];
        seen[si] = 1;
        const pixels = [];
        let minX = sx, maxX = sx, minY = sy, maxY = sy;

        for (let qi = 0; qi < q.length; qi++) {
          const ci = q[qi];
          pixels.push(ci);
          const cy = (ci / w) | 0, cx = ci - cy * w;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
          for (let d = 0; d < 8; d++) {
            const nx = cx + dx[d], ny = cy + dy[d];
            if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) continue;
            const ni = ny * w + nx;
            if (!bin[ni] || seen[ni]) continue;
            seen[ni] = 1;
            q.push(ni);
          }
        }

        const area = pixels.length;
        if (area < minArea || area > maxArea) continue;
        const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5;
        if (Math.hypot(cx - anchorX, cy - anchorY) > maxDist) continue;
        blobs.push({ pixels, area, cx, cy });
      }
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

  function _hollowInterior(mask, x0, y0, x1, y1, w, h, passes, nbrCut) {
    const thin = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) if (mask[i]) thin[i] = 1;
    for (let pass = 0; pass < passes; pass++) {
      for (let y = y0 + 1; y < y1 - 1; y++) {
        for (let x = x0 + 1; x < x1 - 1; x++) {
          const i = y * w + x;
          if (!thin[i]) continue;
          let nbr = 0;
          for (let dy2 = -1; dy2 <= 1; dy2++) {
            for (let dx2 = -1; dx2 <= 1; dx2++) {
              if (!dx2 && !dy2) continue;
              if (thin[(y + dy2) * w + (x + dx2)]) nbr++;
            }
          }
          if (nbr >= nbrCut) thin[i] = 0;
        }
      }
    }
    return thin;
  }

  function _cardinalThin(mask, x0, y0, x1, y1, w, h, passes, cardMin) {
    const thin = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) if (mask[i]) thin[i] = 1;
    for (let pass = 0; pass < passes; pass++) {
      for (let y = y0 + 1; y < y1 - 1; y++) {
        for (let x = x0 + 1; x < x1 - 1; x++) {
          const i = y * w + x;
          if (!thin[i]) continue;
          let card = 0;
          if (thin[i - 1]) card++;
          if (thin[i + 1]) card++;
          if (thin[i - w]) card++;
          if (thin[i + w]) card++;
          if (card >= cardMin) thin[i] = 0;
        }
      }
    }
    return thin;
  }

  function _pruneZoneSpecks(fg, zoneFn, w, h, minNbr) {
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (!zoneFn(x, y, w, h)) continue;
          const i = y * w + x;
          if (fg[i] < 0.5) continue;
          let nbr = 0;
          for (let dy2 = -1; dy2 <= 1; dy2++) {
            for (let dx2 = -1; dx2 <= 1; dx2++) {
              if (!dx2 && !dy2) continue;
              if (fg[(y + dy2) * w + (x + dx2)] > 0.5) nbr++;
            }
          }
          if (nbr <= minNbr) fg[i] = 0;
        }
      }
    }
  }

  function _isCamoYellowStroke(hue, sat, i) {
    return sat[i] > 0.11 && hue[i] > 0.14 && hue[i] < 0.40;
  }

  /** One cardinal dilate pass inside zone — thickens thin ridges without zone-wide noise. */
  function _dilateCardinalOnce(mask, zoneFn, w, h) {
    const out = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) if (mask[i]) out[i] = 1;
    const dx = [1, -1, 0, 0], dy = [0, 0, 1, -1];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!zoneFn(x, y, w, h)) continue;
        const i = y * w + x;
        if (mask[i]) continue;
        for (let d = 0; d < 4; d++) {
          const nx = x + dx[d], ny = y + dy[d];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (mask[ny * w + nx]) { out[i] = 1; break; }
        }
      }
    }
    return out;
  }

  /** Remove isolated pixels inside a zone mask. */
  function _pruneZoneIsolated(fg, zoneFn, minNbr, w, h) {
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (!zoneFn(x, y, w, h)) continue;
          const i = y * w + x;
          if (fg[i] < 0.5) continue;
          let nbr = 0;
          for (let dy2 = -1; dy2 <= 1; dy2++) {
            for (let dx2 = -1; dx2 <= 1; dx2++) {
              if (!dx2 && !dy2) continue;
              if (fg[(y + dy2) * w + (x + dx2)] > 0.5) nbr++;
            }
          }
          if (nbr < minNbr) fg[i] = 0;
        }
      }
    }
  }

  /** Hollow filled blobs → stroke outlines inside zone. */
  function _hollowZoneFg(fg, zoneFn, w, h, passes, nbrCut) {
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!zoneFn(x, y, w, h)) continue;
        if (fg[y * w + x] > 0.5) mask[y * w + x] = 1;
      }
    }
    const out = _hollowInterior(mask, 0, 0, w, h, w, h, passes, nbrCut);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!zoneFn(x, y, w, h)) continue;
        fg[y * w + x] = out[y * w + x] ? 1 : 0;
      }
    }
  }

  /** Rebuild camouflaged stroke icons in detected corner layouts (color-agnostic). */
  function _paintCamoStrokeLayout(fg, camoStroke, layout, edgeSat, satRes, hue, sat, camo, localGate, w, h) {
    const { x0, y0, x1, y1, zoneFn } = layout;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (!zoneFn(x, y, w, h)) continue;
        const i = y * w + x;
        const seed = camoStroke[i]
          || (localGate[i] >= 0.20 && edgeSat[i] >= 0.003)
          || (_isCamoYellowStroke(hue, sat, i) && edgeSat[i] >= 0.006 && satRes[i] >= 0.0008)
          || (camo[i] >= 0.014 && edgeSat[i] >= 0.005);
        fg[i] = seed ? 1 : 0;
      }
    }
    _hollowZoneFg(fg, zoneFn, w, h, 1, 7);
    for (let y = y0 + 1; y < y1 - 1; y++) {
      for (let x = x0 + 1; x < x1 - 1; x++) {
        if (!zoneFn(x, y, w, h)) continue;
        const i = y * w + x;
        if (fg[i] > 0.5) continue;
        if (edgeSat[i] < 0.020 || camo[i] < 0.010) continue;
        if (!_isCamoYellowStroke(hue, sat, i) && camo[i] < 0.014) continue;
        let near = false;
        for (let dy2 = -1; dy2 <= 1; dy2++) {
          for (let dx2 = -1; dx2 <= 1; dx2++) {
            if (!dx2 && !dy2) continue;
            if (fg[(y + dy2) * w + (x + dx2)] > 0.5) { near = true; break; }
          }
          if (near) break;
        }
        if (near) fg[i] = 1;
      }
    }
    _pruneZoneIsolated(fg, zoneFn, 2, w, h);
  }

  function _paintCamoLayouts(fg, camoStroke, camoLayouts, edgeSat, satRes, hue, sat, camo, localGate, w, h) {
    for (const layout of camoLayouts) {
      if (layout.profile === "bell") continue;
      _paintCamoStrokeLayout(fg, camoStroke, layout, edgeSat, satRes, hue, sat, camo, localGate, w, h);
    }
  }

  /** Pink zone: yellow camo strokes from camo mask + sat-edge, light hollow. */
  function _applyPinkZone(fg, camoStroke, edgeSat, satRes, hue, sat, w, h, camoLayouts, camo, localGate) {
    if (camoLayouts && camoLayouts.length) {
      _paintCamoLayouts(fg, camoStroke, camoLayouts, edgeSat, satRes, hue, sat, camo || new Float32Array(w * h), localGate, w, h);
      return;
    }
    const fieldH = Math.min(h, 218);
    const x0 = Math.floor(w * 0.815);
    const y0 = Math.floor(fieldH * 0.72);
    for (let y = y0; y < h; y++) {
      for (let x = x0; x < w; x++) {
        const i = y * w + x;
        const seed = camoStroke[i]
          || (_isCamoYellowStroke(hue, sat, i) && edgeSat[i] >= 0.008 && satRes[i] >= 0.001);
        fg[i] = seed ? 1 : 0;
      }
    }
    _hollowZoneFg(fg, (x, y, ww, hh) => _pinkExclusiveZone(x, y, ww, hh), w, h, 1, 7);
    for (let y = y0 + 1; y < h - 1; y++) {
      for (let x = x0 + 1; x < w - 1; x++) {
        const i = y * w + x;
        if (fg[i] > 0.5) continue;
        if (edgeSat[i] < 0.025 || !_isCamoYellowStroke(hue, sat, i)) continue;
        let near = false;
        for (let dy2 = -1; dy2 <= 1; dy2++) {
          for (let dx2 = -1; dx2 <= 1; dx2++) {
            if (!dx2 && !dy2) continue;
            if (fg[(y + dy2) * w + (x + dx2)] > 0.5) { near = true; break; }
          }
          if (near) break;
        }
        if (near) fg[i] = 1;
      }
    }
    _pruneZoneIsolated(fg, (x, y, ww, hh) => _pinkExclusiveZone(x, y, ww, hh), 2, w, h);
  }

  /** Erode thick icon interiors (heart/bell blobs) outside camo zones. */
  function _thinMainIcons(fg, w, h) {
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (_camoExclusiveZone(x, y, w, h)) continue;
        const i = y * w + x;
        if (fg[i] < 0.5) continue;
        let nbr = 0;
        for (let dy2 = -1; dy2 <= 1; dy2++) {
          for (let dx2 = -1; dx2 <= 1; dx2++) {
            if (!dx2 && !dy2) continue;
            if (fg[(y + dy2) * w + (x + dx2)] > 0.5) nbr++;
          }
        }
        if (nbr >= 7) fg[i] = 0;
      }
    }
  }

  /** Restore thin main icons after cool-grow; prune halo pixels. */
  function _isStrokeCorePixel(i, edge, coolEdge, coolTint, warmTint, tint) {
    const t = Math.max(coolTint[i], warmTint[i], tint[i]);
    if (t >= 0.048) return true;
    if (t >= 0.036 && edge[i] >= 0.009) return true;
    if (edge[i] > 0.013 && t < 0.038) return false;
    if (coolEdge[i] > 0.001 && coolTint[i] < 0.035) return false;
    return t >= 0.032 && edge[i] >= 0.010;
  }

  function _restoreMainStrokeCore(fg, fgCore, edge, coolEdge, coolTint, warmTint, tint, w, h) {
    for (let i = 0; i < w * h; i++) {
      const py = (i / w) | 0, px = i - py * w;
      if (_camoExclusiveZone(px, py, w, h)) continue;
      if (fgCore[i] && _isStrokeCorePixel(i, edge, coolEdge, coolTint, warmTint, tint)) fg[i] = 1;
      else if (fg[i] > 0.5 && edge[i] < 0.011 && coolEdge[i] < 0.0012) fg[i] = 0;
    }
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (_camoExclusiveZone(x, y, w, h)) continue;
          const i = y * w + x;
          if (fg[i] < 0.5 || fgCore[i]) continue;
          let nbr = 0;
          for (let dy2 = -1; dy2 <= 1; dy2++) {
            for (let dx2 = -1; dx2 <= 1; dx2++) {
              if (!dx2 && !dy2) continue;
              if (fg[(y + dy2) * w + (x + dx2)] > 0.5) nbr++;
            }
          }
          if (nbr <= 3) fg[i] = 0;
        }
      }
    }
  }

  /** Keep all FG blobs near anchor (fingerprint = multiple rings). */
  function _keepAllNearAnchor(fg, zoneFn, ax, ay, maxDist, minArea, w, h) {
    const bin = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!zoneFn(x, y, w, h)) continue;
        if (fg[y * w + x] > 0.5) bin[y * w + x] = 1;
      }
    }
    const keep = new Uint8Array(w * h);
    const seen = new Int32Array(w * h);
    const dx = [1, -1, 0, 0, 1, 1, -1, -1];
    const dy = [0, 0, 1, -1, 1, -1, 1, -1];

    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        if (!zoneFn(sx, sy, w, h)) continue;
        const si = sy * w + sx;
        if (!bin[si] || seen[si]) continue;
        const q = [si];
        seen[si] = 1;
        const pixels = [];
        let sumX = 0, sumY = 0;

        for (let qi = 0; qi < q.length; qi++) {
          const ci = q[qi];
          pixels.push(ci);
          const cy = (ci / w) | 0, cx = ci - cy * w;
          sumX += cx;
          sumY += cy;
          for (let d = 0; d < 8; d++) {
            const nx = cx + dx[d], ny = cy + dy[d];
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (!zoneFn(nx, ny, w, h)) continue;
            const ni = ny * w + nx;
            if (!bin[ni] || seen[ni]) continue;
            seen[ni] = 1;
            q.push(ni);
          }
        }

        if (pixels.length < minArea) continue;
        const cx = sumX / pixels.length, cy = sumY / pixels.length;
        if (Math.hypot(cx - ax, cy - ay) > maxDist) continue;
        for (const pi of pixels) keep[pi] = 1;
      }
    }

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!zoneFn(x, y, w, h)) continue;
        fg[y * w + x] = keep[y * w + x] ? 1 : 0;
      }
    }
  }

  /** Remove stray pixels in upper-right margin that were never part of main icons. */
  function _wipeStrayNoCore(fg, fgCore, w, h) {
    const fieldH = Math.min(h, 218);
    const x0 = Math.floor(w * 0.84);
    const y1 = Math.floor(fieldH * 0.62);
    for (let y = 0; y < y1; y++) {
      for (let x = x0; x < w; x++) {
        if (_fpExclusiveZone(x, y, w, h) || _pinkExclusiveZone(x, y, w, h)) continue;
        const i = y * w + x;
        if (fgCore[i]) continue;
        fg[i] = 0;
      }
    }
  }

  /** Bridge green-tile bell strokes from existing blue outline via BFS + hollow. */
  function _recoverBellGreenCamo(fg, edgeSat, satRes, hue, bgR, bgG, bgB, w, h) {
    const fieldH = Math.min(h, 218);
    const x0 = Math.floor(w * 0.05);
    const y0 = Math.floor(fieldH * 0.66);
    const x1 = Math.floor(w * 0.31);
    const y1 = Math.floor(fieldH * 0.97);
    const n = w * h;
    const orig = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const py = (i / w) | 0, px = i - py * w;
      if (_bellExclusiveZone(px, py, w, h) && fg[i] > 0.5) orig[i] = 1;
    }
    const cand = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!_bellExclusiveZone(x, y, w, h)) continue;
        const i = y * w + x;
        if (_isGreenCamoStroke(hue, edgeSat, satRes, bgR, bgG, bgB, i)) cand[i] = 1;
      }
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
        if (!_bellExclusiveZone(px, py, w, h)) continue;
        if (!cand[i] || edgeSat[i] < 0.006) continue;
        fg[i] = 1;
        orig[i] = 1;
        if (!seen[i]) { seen[i] = 1; q.push(i); }
      }
    }
    for (let qi = 0; qi < q.length; qi++) {
      const ci = q[qi];
      const cy = (ci / w) | 0, cx = ci - cy * w;
      const dx8 = [1, -1, 0, 0, 1, 1, -1, -1];
      const dy8 = [0, 0, 1, -1, 1, -1, 1, -1];
      for (let d = 0; d < 8; d++) {
        const nx = cx + dx8[d], ny = cy + dy8[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (!_bellExclusiveZone(nx, ny, w, h)) continue;
        const ni = ny * w + nx;
        if (seen[ni] || !cand[ni]) continue;
        seen[ni] = 1;
        q.push(ni);
        fg[ni] = 1;
      }
    }
    _hollowZoneFg(fg, _bellExclusiveZone, w, h, 2, 6);
    _pruneZoneIsolated(fg, _bellExclusiveZone, 2, w, h);
  }

  /** Recover pale pink warm strokes (center-bottom siren). */
  function _recoverWarmPinkIcon(fg, edge, edgeSat, satRes, tint, hue, sat, w, h) {
    const cand = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!_pinkStrokeZone(x, y, w, h)) continue;
        const i = y * w + x;
        if (tint[i] >= 0.028 && edgeSat[i] >= 0.006 && satRes[i] >= 0.0008) cand[i] = 1;
        else if (tint[i] >= 0.036 && edge[i] >= 0.006) cand[i] = 1;
      }
    }
    const q = [];
    const seen = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (!fg[i] || !_pinkStrokeZone((i / w) | 0, i % w, w, h)) continue;
      q.push(i);
      seen[i] = 1;
    }
    const dx8 = [1, -1, 0, 0, 1, 1, -1, -1];
    const dy8 = [0, 0, 1, -1, 1, -1, 1, -1];
    for (let qi = 0; qi < q.length; qi++) {
      const ci = q[qi];
      const cy = (ci / w) | 0, cx = ci - cy * w;
      for (let d = 0; d < 8; d++) {
        const nx = cx + dx8[d], ny = cy + dy8[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (!_pinkStrokeZone(nx, ny, w, h)) continue;
        const ni = ny * w + nx;
        if (seen[ni] || !cand[ni]) continue;
        seen[ni] = 1;
        q.push(ni);
        fg[ni] = 1;
      }
    }
    _hollowZoneFg(fg, _pinkStrokeZone, w, h, 2, 7);
    _pruneZoneIsolated(fg, _pinkStrokeZone, 2, w, h);
  }

  /** Re-apply main icon cores after camo-zone passes (protects crown/cloud). */
  function _reapplyMainCore(fg, fgCore, edge, coolEdge, coolTint, warmTint, tint, w, h) {
    for (let i = 0; i < w * h; i++) {
      const py = (i / w) | 0, px = i - py * w;
      if (_camoExclusiveZone(px, py, w, h)) continue;
      if (fgCore[i] && _isStrokeCorePixel(i, edge, coolEdge, coolTint, warmTint, tint)) fg[i] = 1;
    }
  }

  /** Keep ring arcs near fingerprint anchor; drop tile seam bars. */
  function _collectFpRingMask(bin, x0, y0, x1, y1, anchorX, anchorY, maxDist, w, h) {
    const seen = new Int32Array(w * h);
    const dx = [1, -1, 0, 0, 1, 1, -1, -1];
    const dy = [0, 0, 1, -1, 1, -1, 1, -1];
    const out = new Uint8Array(w * h);

    for (let sy = y0; sy < y1; sy++) {
      for (let sx = x0; sx < x1; sx++) {
        const si = sy * w + sx;
        if (!bin[si] || seen[si]) continue;
        const q = [si];
        seen[si] = 1;
        const pixels = [];
        let minX = sx, maxX = sx, minY = sy, maxY = sy;
        let minDist = 1e9;

        for (let qi = 0; qi < q.length; qi++) {
          const ci = q[qi];
          pixels.push(ci);
          const cy = (ci / w) | 0, cx = ci - cy * w;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
          const d = Math.hypot(cx - anchorX, cy - anchorY);
          if (d < minDist) minDist = d;
          for (let d8 = 0; d8 < 8; d8++) {
            const nx = cx + dx[d8], ny = cy + dy[d8];
            if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) continue;
            const ni = ny * w + nx;
            if (!bin[ni] || seen[ni]) continue;
            seen[ni] = 1;
            q.push(ni);
          }
        }

        const area = pixels.length;
        const bw = maxX - minX + 1;
        const bh = maxY - minY + 1;
        if (area < 6 || area > 520) continue;
        if (minDist > maxDist) continue;
        if (bh / Math.max(bw, 1) > 2.2 && bw < 14) continue;
        if (bw / Math.max(bh, 1) > 3.2 && bh < 12) continue;
        for (const pi of pixels) out[pi] = 1;
      }
    }
    return out;
  }

  /** Grow fingerprint ridges along pale-cool strokes inside one FP subzone. */
  function _growFpConnected(ring, zoneFn, edgeSat, satRes, coolTint, coolEdge, edge, lumRes, w, h) {
    const cand = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!zoneFn(x, y, w, h)) continue;
        const i = y * w + x;
        if (edgeSat[i] >= 0.006 && satRes[i] >= 0.001 && coolTint[i] >= 0.024) cand[i] = 1;
        else if (edge[i] >= 0.006 && satRes[i] >= 0.0008 && (coolTint[i] >= 0.020 || lumRes[i] >= 0.008)) cand[i] = 1;
        else if (coolEdge[i] >= 0.0007 && lumRes[i] >= 0.007 && edge[i] >= 0.005) cand[i] = 1;
      }
    }
    const out = new Uint8Array(ring);
    const q = [];
    const seen = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (!ring[i]) continue;
      q.push(i);
      seen[i] = 1;
    }
    const dx8 = [1, -1, 0, 0, 1, 1, -1, -1];
    const dy8 = [0, 0, 1, -1, 1, -1, 1, -1];
    for (let qi = 0; qi < q.length; qi++) {
      const ci = q[qi];
      const cy = (ci / w) | 0, cx = ci - cy * w;
      for (let d = 0; d < 8; d++) {
        const nx = cx + dx8[d], ny = cy + dy8[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (!zoneFn(nx, ny, w, h)) continue;
        const ni = ny * w + nx;
        if (seen[ni] || !cand[ni]) continue;
        seen[ni] = 1;
        q.push(ni);
        out[ni] = 1;
      }
    }
    return out;
  }

  /** All ring blobs near anchor; drop only wide horizontal tile seams. */
  function _mergeFpRingBlobs(bin, x0, y0, x1, y1, anchorX, anchorY, maxDist, w, h) {
    const seen = new Int32Array(w * h);
    const dx = [1, -1, 0, 0, 1, 1, -1, -1];
    const dy = [0, 0, 1, -1, 1, -1, 1, -1];
    const out = new Uint8Array(w * h);

    for (let sy = y0; sy < y1; sy++) {
      for (let sx = x0; sx < x1; sx++) {
        const si = sy * w + sx;
        if (!bin[si] || seen[si]) continue;
        const q = [si];
        seen[si] = 1;
        const pixels = [];
        let minX = sx, maxX = sx, minY = sy, maxY = sy;
        let minDist = 1e9;

        for (let qi = 0; qi < q.length; qi++) {
          const ci = q[qi];
          pixels.push(ci);
          const cy = (ci / w) | 0, cx = ci - cy * w;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
          minDist = Math.min(minDist, Math.hypot(cx - anchorX, cy - anchorY));
          for (let d8 = 0; d8 < 8; d8++) {
            const nx = cx + dx[d8], ny = cy + dy[d8];
            if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) continue;
            const ni = ny * w + nx;
            if (!bin[ni] || seen[ni]) continue;
            seen[ni] = 1;
            q.push(ni);
          }
        }

        const area = pixels.length;
        const bw = maxX - minX + 1;
        const bh = maxY - minY + 1;
        if (area < 5 || area > 600) continue;
        if (minDist > maxDist) continue;
        if (bw / Math.max(bh, 1) > 3.5 && bh < 12) continue;
        for (const pi of pixels) out[pi] = 1;
      }
    }
    return out;
  }

  /** Clear filled interior near fingerprint center; keep ring outlines. */
  function _gutFpCenterFill(fg, zoneFn, anchorX, anchorY, rad, w, h) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!zoneFn(x, y, w, h)) continue;
        if (Math.hypot(x - anchorX, y - anchorY) > rad) continue;
        const i = y * w + x;
        if (fg[i] < 0.5) continue;
        let nbr = 0;
        for (let dy2 = -1; dy2 <= 1; dy2++) {
          for (let dx2 = -1; dx2 <= 1; dx2++) {
            if (!dx2 && !dy2) continue;
            if (fg[(y + dy2) * w + (x + dx2)] > 0.5) nbr++;
          }
        }
        if (nbr >= 5) fg[i] = 0;
      }
    }
  }

  function _fpThinStroke(i, edge, edgeSat, satRes, coolTint, warmTint, coolEdge, lumRes, camo, localGate) {
    if (localGate[i] >= 0.20 && edgeSat[i] >= 0.003) return true;
    const tint = Math.max(coolTint[i], warmTint[i]);
    if (edgeSat[i] >= 0.008 && satRes[i] >= 0.0012 && tint >= 0.032) return true;
    if (coolEdge[i] >= 0.001 && tint >= 0.028 && edge[i] >= 0.007) return true;
    if (lumRes[i] >= 0.010 && tint >= 0.026 && edge[i] >= 0.006) return true;
    if (camo[i] >= 0.012 && edgeSat[i] >= 0.008) return true;
    return false;
  }

  function _fpLayoutStroke(i, edge, edgeSat, satRes, coolTint, warmTint, coolEdge, lumRes, camo, topZone, localGate) {
    if (!_fpThinStroke(i, edge, edgeSat, satRes, coolTint, warmTint, coolEdge, lumRes, camo, localGate)) return false;
    if (topZone) {
      if (coolTint[i] < 0.038 || coolTint[i] < warmTint[i] * 0.9) return false;
      if (coolEdge[i] < 0.0008 && edgeSat[i] < 0.012) return false;
    } else if (coolTint[i] < 0.035 || coolTint[i] <= warmTint[i]) {
      return false;
    }
    return true;
  }

  /** Pick top-right or bottom-left fingerprint layout from stroke density near anchor. */
  function _selectFpLayout(edge, edgeSat, satRes, coolTint, warmTint, coolEdge, lumRes, camo, localGate, w, h) {
    const fieldH = Math.min(h, 218);
    const coreRad = 34;
    const specs = [
      {
        zoneFn: _fpTopExclusiveZone,
        x0: Math.floor(w * 0.80),
        y0: Math.floor(fieldH * 0.08),
        x1: w,
        y1: Math.floor(fieldH * 0.60),
        anchorX: w * 0.88,
        anchorY: fieldH * 0.36,
        topZone: true,
      },
      {
        zoneFn: _fpBottomExclusiveZone,
        x0: Math.floor(w * 0.05),
        y0: Math.floor(fieldH * 0.58),
        x1: Math.floor(w * 0.38),
        y1: Math.floor(fieldH * 0.98),
        anchorX: w * 0.22,
        anchorY: fieldH * 0.74,
        topZone: false,
      },
    ];
    const counts = specs.map((spec) => {
      let seeds = 0;
      for (let y = spec.y0; y < spec.y1; y++) {
        for (let x = spec.x0; x < spec.x1; x++) {
          if (!spec.zoneFn(x, y, w, h)) continue;
          const i = y * w + x;
          if (!_fpLayoutStroke(i, edge, edgeSat, satRes, coolTint, warmTint, coolEdge, lumRes, camo, spec.topZone, localGate)) continue;
          if (Math.hypot(x - spec.anchorX, y - spec.anchorY) < coreRad) seeds++;
        }
      }
      return seeds;
    });
    const minSeeds = 14;
    const top = counts[0];
    const bot = counts[1];
    if (top >= 80 && bot < top * 2.8) return specs[0];
    if (top >= minSeeds && top >= bot * 1.12) return specs[0];
    if (bot >= minSeeds && bot > top * 1.12) return specs[1];
    if (top >= minSeeds && bot >= minSeeds) return top >= bot ? specs[0] : specs[1];
    if (top >= minSeeds && bot < 10) return specs[0];
    if (bot >= minSeeds && top < 10) return specs[1];
    return null;
  }

  /** Drop pipeline noise in the inactive fingerprint zone; keep bell on top-layout captchas. */
  function _wipeInactiveFpZone(fg, fpLayout, w, h) {
    if (!fpLayout) return;
    if (fpLayout.zoneFn === _fpTopExclusiveZone) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!_fpBottomExclusiveZone(x, y, w, h)) continue;
          if (_bellExclusiveZone(x, y, w, h)) continue;
          fg[y * w + x] = 0;
        }
      }
      return;
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!_fpTopExclusiveZone(x, y, w, h)) continue;
        fg[y * w + x] = 0;
      }
    }
    _wipeFpTopSeams(fg, w, h);
    _wipeFpMarginSeam(fg, w, h);
  }

  /** Upper-center cloud icon (pale blue on tile seam). */
  function _cloudRecoverZone(x, y, w, h) {
    const fieldH = Math.min(h, 218);
    return x >= w * 0.26 && x <= w * 0.58 && y >= fieldH * 0.10 && y < fieldH * 0.54;
  }

  /** Center shower / rain icon. */
  function _showerRecoverZone(x, y, w, h) {
    const fieldH = Math.min(h, 218);
    return x >= w * 0.30 && x <= w * 0.62 && y >= fieldH * 0.18 && y < fieldH * 0.55;
  }

  /** Center-right key / lock icons on pale tiles. */
  function _centerIconZone(x, y, w, h) {
    const fieldH = Math.min(h, 218);
    return x >= w * 0.48 && x <= w * 0.84 && y >= fieldH * 0.22 && y < fieldH * 0.72;
  }

  /** Lock-with-A icon (center-right). */
  function _lockRecoverZone(x, y, w, h) {
    const fieldH = Math.min(h, 218);
    return x >= w * 0.58 && x <= w * 0.82 && y >= fieldH * 0.24 && y < fieldH * 0.58;
  }

  /** Bottom-right siren / warm icon. */
  function _sirenRecoverZone(x, y, w, h) {
    const fieldH = Math.min(h, 218);
    return x >= w * 0.70 && x <= w * 0.96 && y >= fieldH * 0.52 && y < fieldH * 0.92;
  }

  /** Re-seed icon zones that were hollowed away entirely. */
  function _reseedSparseIconZones(fg, score, edge, edgeSat, coolTint, warmTint, tint, w, h, thresh) {
    const fieldH = Math.min(h, 218);
    const zones = [
      { zoneFn: _cloudRecoverZone, anchorX: w * 0.42, anchorY: fieldH * 0.30, minPx: 90, rad: 58, softMul: 0.34 },
      { zoneFn: _showerRecoverZone, anchorX: w * 0.46, anchorY: fieldH * 0.36, minPx: 70, rad: 52, softMul: 0.34 },
      { zoneFn: _centerIconZone, anchorX: w * 0.66, anchorY: fieldH * 0.46, minPx: 80, rad: 62, softMul: 0.34 },
      { zoneFn: _lockRecoverZone, anchorX: w * 0.70, anchorY: fieldH * 0.40, minPx: 45, rad: 42, softMul: 0.30 },
      { zoneFn: _bellExclusiveZone, anchorX: w * 0.18, anchorY: fieldH * 0.82, minPx: 35, rad: 50, softMul: 0.28 },
      { zoneFn: _sirenRecoverZone, anchorX: w * 0.84, anchorY: fieldH * 0.72, minPx: 50, rad: 48, softMul: 0.30 },
    ];
    for (const z of zones) {
      let px = 0;
      for (let y = 0; y < fieldH; y++) {
        for (let x = 0; x < w; x++) {
          if (!z.zoneFn(x, y, w, h)) continue;
          if (fg[y * w + x] > 0.5) px++;
        }
      }
      if (px >= z.minPx) continue;
      const soft = thresh * z.softMul;
      for (let y = 0; y < fieldH; y++) {
        for (let x = 0; x < w; x++) {
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
  }

  function _paintFpSubzone(
    fg, zoneFn, x0, y0, x1, y1, anchorX, anchorY, edge, edgeSat, satRes,
    coolTint, warmTint, coolEdge, lumRes, camo, hue, bgR, bgG, bgB, localGate, w, h,
  ) {
    const thin = new Uint8Array(w * h);
    const bottomFp = zoneFn === _fpBottomExclusiveZone;
    const minSeeds = bottomFp ? 8 : 12;
    let seeds = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (!zoneFn(x, y, w, h)) continue;
        const i = y * w + x;
        const fpStroke = _fpThinStroke(i, edge, edgeSat, satRes, coolTint, warmTint, coolEdge, lumRes, camo, localGate)
          || (bottomFp && _isGreenCamoStroke(hue, edgeSat, satRes, bgR, bgG, bgB, i) && edgeSat[i] >= 0.0055);
        if (!fpStroke) continue;
        thin[i] = 1;
        if (Math.hypot(x - anchorX, y - anchorY) < 52) seeds++;
      }
    }
    if (seeds < minSeeds) return;
    const hollow = _hollowInterior(thin, x0, y0, x1, y1, w, h, 2, 5);
    const grown = _growFpConnected(hollow, zoneFn, edgeSat, satRes, coolTint, coolEdge, edge, lumRes, w, h);
    const out = _dilateCardinalOnce(grown, zoneFn, w, h);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (!zoneFn(x, y, w, h)) continue;
        const i = y * w + x;
        if (out[i]) fg[i] = 1;
      }
    }
    _gutFpCenterFill(fg, zoneFn, anchorX, anchorY, 24, w, h);
  }

  /** Rebuild fingerprint rings — top-right layout only (bottom via camo detail). */
  function _paintFingerprintZone(fg, fgCore, camo, edge, edgeSat, satRes, coolTint, warmTint, coolEdge, lumRes, hue, sat, bgR, bgG, bgB, localGate, w, h, fpLayout) {
    const active = fpLayout || _selectFpLayout(edge, edgeSat, satRes, coolTint, warmTint, coolEdge, lumRes, camo, localGate, w, h);
    if (!active) return;
    if (active.zoneFn === _fpBottomExclusiveZone) return;
    _paintFpSubzone(
      fg, active.zoneFn, active.x0, active.y0, active.x1, active.y1, active.anchorX, active.anchorY,
      edge, edgeSat, satRes, coolTint, warmTint, coolEdge, lumRes, camo, hue, bgR, bgG, bgB, localGate, w, h,
    );
    _wipeFpTopSeams(fg, w, h);
    _wipeFpMarginSeam(fg, w, h);
  }

  /** Keep only icon cores in the cloud–crown corridor; drop seam bridges. */
  function _wipeCorridorSeams(fg, coolTint, w, h) {
    const anchors = [[w * 0.40, h * 0.35, 30], [w * 0.73, h * 0.43, 32]];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!_centerSeamCorridor(x, y, w, h)) continue;
        let nearIcon = false;
        for (const [ax, ay, rad] of anchors) {
          if (Math.hypot(x - ax, y - ay) < rad) { nearIcon = true; break; }
        }
        if (nearIcon) continue;
        fg[y * w + x] = 0;
      }
    }
  }

  function _appendCamouflageFg(fg, camo, edge, edgeSat, coolTint, warmTint, coolEdge, hue, sat, satRes, bgR, bgG, bgB, w, h, camoStroke, fpLayout, camoLayouts) {
    const fieldH = Math.min(h, 218);
    const zones = (camoLayouts || []).filter((l) => l.profile === "stroke").map((l) => ({
      x0: l.x0,
      y0: l.y0,
      x1: l.x1,
      y1: l.y1,
      anchorX: l.anchorX,
      anchorY: l.anchorY,
      maxDist: l.maxDist,
      profile: "stroke",
    }));
    if (!zones.length) {
      zones.push({
        x0: Math.floor(w * 0.815),
        y0: Math.floor(fieldH * 0.72),
        x1: w,
        y1: h,
        anchorX: w * 0.915,
        anchorY: fieldH * 0.885,
        maxDist: 55,
        profile: "stroke",
      });
    }
    if (fpLayout && fpLayout.zoneFn === _fpTopExclusiveZone) {
      zones.unshift({
        x0: Math.floor(w * 0.80),
        y0: Math.floor(fieldH * 0.08),
        x1: w,
        y1: Math.floor(fieldH * 0.60),
        anchorX: w * 0.88,
        anchorY: fieldH * 0.36,
        maxDist: 52,
        profile: "detail",
      });
    }
    if (fpLayout && fpLayout.zoneFn === _fpBottomExclusiveZone) {
      zones.unshift({
        x0: Math.floor(w * 0.05),
        y0: Math.floor(fieldH * 0.58),
        x1: Math.floor(w * 0.38),
        y1: Math.floor(fieldH * 0.98),
        anchorX: w * 0.22,
        anchorY: fieldH * 0.74,
        maxDist: 50,
        profile: "detail",
      });
    }
    const strokeMask = camoStroke || new Uint8Array(w * h);
    for (const z of zones) {
      const thin = _appendCamoZone(fg, camo, edge, edgeSat, hue, sat, satRes, bgR, bgG, bgB, w, h, z);
      if (!thin) continue;
      for (let i = 0; i < w * h; i++) {
        if (!thin[i]) continue;
        strokeMask[i] = 1;
        if (z.profile === "detail") fg[i] = 1;
      }
    }
    for (const z of zones) {
      if (z.profile !== "stroke") continue;
      for (let y = z.y0; y < z.y1; y++) {
        for (let x = z.x0; x < z.x1; x++) {
          const i = y * w + x;
          if (strokeMask[i]) { fg[i] = 1; continue; }
          if (warmTint[i] > 0.06 && edge[i] > 0.012) continue;
          if (coolTint[i] > 0.07 && edge[i] > 0.012) continue;
          fg[i] = 0;
        }
      }
    }
  }

  function _inCamoHandledZone(x, y, w, h) {
    if (_pinkExclusiveZone(x, y, w, h)) return true;
    if (_pinkStrokeZone(x, y, w, h)) return true;
    return _fpTopExclusiveZone(x, y, w, h);
  }

  function _inCoolRecoverZone(x, y, w, h) {
    if (_inCamoHandledZone(x, y, w, h)) return false;
    return x > w * 0.06 && x < w * 0.90 && y > h * 0.10 && y < h * 0.94;
  }

  /** Seed standalone strong-cool blue blobs (key shaft disconnected from handle). */
  function _seedStrongCoolBlobs(fg, edge, coolEdge, coolTint, score, w, h, thresh) {
    const maxScore = thresh * 0.45;
    const bin = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (fg[i] > 0.5 || score[i] > maxScore) continue;
      if (coolTint[i] >= 0.065 && (edge[i] >= 0.005 || coolEdge[i] >= 0.001)) bin[i] = 1;
    }

    const seen = new Int32Array(w * h);
    const dx = [1, -1, 0, 0, 1, 1, -1, -1];
    const dy = [0, 0, 1, -1, 1, -1, 1, -1];

    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
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
        if (!_inCoolRecoverZone(cx | 0, cy | 0, w, h)) continue;
        const bw = maxX - minX + 1, bh = maxY - minY + 1;
        const aspect = Math.max(bw, bh) / (Math.min(bw, bh) + 1);
        if (aspect > 10 && area > 100) continue;
        for (const pi of pixels) fg[pi] = 1;
      }
    }
  }

  /** Grow into pale-blue pixels with weak gray edge but cool-channel edge (key/id-card lines). */
  function _growCoolLowEdge(fg, edge, coolEdge, coolTint, score, w, h, thresh, skipTopFp) {
    const maxScore = thresh * 0.42;
    for (let pass = 0; pass < 3; pass++) {
      for (let y = 2; y < h - 2; y++) {
        for (let x = 2; x < w - 2; x++) {
          const i = y * w + x;
          if (skipTopFp && _fpTopExclusiveZone(x, y, w, h)) continue;
          if (!_inCoolRecoverZone(x, y, w, h)) continue;
          if (_centerSeamCorridor(x, y, w, h)) continue;
          if (fg[i] > 0.5 || coolTint[i] < 0.045) continue;
          if (edge[i] < 0.005 && coolEdge[i] < 0.001) continue;
          if (score[i] > maxScore) continue;
          let near = false;
          for (let dy2 = -1; dy2 <= 1; dy2++) {
            for (let dx2 = -1; dx2 <= 1; dx2++) {
              if (!dx2 && !dy2) continue;
              if (fg[(y + dy2) * w + (x + dx2)] > 0.5) { near = true; break; }
            }
            if (near) break;
          }
          if (near) fg[i] = 1;
        }
      }
    }
  }

  /** Seed tiny pale-blue gaps only when touching existing icon strokes. */
  function _bridgePaleCoolComponents(fg, edge, coolEdge, coolTint, score, w, h, thresh) {
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

    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
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
        if (_centerSeamCorridor(cx | 0, cy | 0, w, h)) continue;

        let nearFg = false;
        const pad = 3;
        for (let y = minY - pad; y <= maxY + pad && !nearFg; y++) {
          for (let x = minX - pad; x <= maxX + pad; x++) {
            if (y < 0 || x < 0 || y >= h || x >= w) continue;
            if (fg[y * w + x] > 0.5) { nearFg = true; break; }
          }
        }
        if (!nearFg) continue;
        for (const pi of pixels) fg[pi] = 1;
      }
    }
  }

  /** Remove isolated low-signal speckle from grow passes. */
  function _prunePatchworkSpeckle(fg, edge, coolEdge, coolTint, tint, w, h) {
    for (let pass = 0; pass < 3; pass++) {
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (fg[i] < 0.5) continue;
          if (tint[i] > 0.08) continue;
          if (coolTint[i] > 0.045 && (edge[i] > 0.008 || coolEdge[i] > 0.001)) continue;
          let nbr = 0;
          for (let dy2 = -1; dy2 <= 1; dy2++) {
            for (let dx2 = -1; dx2 <= 1; dx2++) {
              if (!dx2 && !dy2) continue;
              if (fg[(y + dy2) * w + (x + dx2)] > 0.5) nbr++;
            }
          }
          if (nbr >= 5) continue;
          if (nbr <= 2 && edge[i] < 0.011) fg[i] = 0;
          else if (nbr <= 3 && edge[i] < 0.010 && coolTint[i] < 0.05 && tint[i] < 0.05) fg[i] = 0;
          else if (nbr <= 4 && edge[i] < 0.008 && coolTint[i] < 0.035 && tint[i] < 0.035) fg[i] = 0;
        }
      }
    }
  }

  /** Bridge gaps in pale blue icon strokes (fingerprint, key). */
  function _growCoolStrokes(fg, edge, coolEdge, coolTint, score, w, h, thresh, skipTopFp) {
    const maxScore = thresh * 0.35;
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 2; y < h - 2; y++) {
        for (let x = 2; x < w - 2; x++) {
          const i = y * w + x;
          if (fg[i] > 0.5 || coolTint[i] < 0.032) continue;
          if (skipTopFp && _fpTopExclusiveZone(x, y, w, h)) continue;
          if (_pinkExclusiveZone(x, y, w, h) || _pinkStrokeZone(x, y, w, h)) continue;
          if (_centerSeamCorridor(x, y, w, h)) continue;
          if (edge[i] < 0.006 && coolEdge[i] < 0.0009) continue;
          if (score[i] > maxScore) continue;
          let near = false;
          for (let dy2 = -1; dy2 <= 1; dy2++) {
            for (let dx2 = -1; dx2 <= 1; dx2++) {
              if (!dx2 && !dy2) continue;
              if (fg[(y + dy2) * w + (x + dx2)] > 0.5) { near = true; break; }
            }
            if (near) break;
          }
          if (near) fg[i] = 1;
        }
      }
    }
  }

  function _bboxNear(a, b, pad) {
    return !(a.maxX + pad < b.minX || a.minX - pad > b.maxX
      || a.maxY + pad < b.minY || a.minY - pad > b.maxY);
  }

  /** Grow FG into nearby soft-score or cool-tint icon strokes (bell/cloud gaps). */
  function _growIconStrokes(fg, score, edge, tint, coolTint, w, h, thresh) {
    const soft = thresh * 0.50;
    const passes = 1;
    const minEdge = 0.009;
    const minTint = 0.030;
    for (let pass = 0; pass < passes; pass++) {
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (_centerSeamCorridor(x, y, w, h)) continue;
          if (_pinkExclusiveZone(x, y, w, h)) continue;
          if (_fpTopExclusiveZone(x, y, w, h) || _fpBottomExclusiveZone(x, y, w, h)) continue;
          const i = y * w + x;
          if (fg[i] > 0.5) continue;
          let hasSignal = score[i] >= soft
            || (coolTint[i] >= 0.050 && score[i] < 0.015);
          if (!hasSignal && (_bellExclusiveZone(x, y, w, h) || _pinkStrokeZone(x, y, w, h) || _cloudRecoverZone(x, y, w, h)) && edge[i] >= 0.006) {
            hasSignal = coolTint[i] >= 0.022 || tint[i] >= 0.022;
          }
          const zoneBoost = _bellExclusiveZone(x, y, w, h) || _pinkStrokeZone(x, y, w, h) || _cloudRecoverZone(x, y, w, h);
          const minEdgeUse = zoneBoost ? 0.006 : minEdge;
          if (!hasSignal || edge[i] < minEdgeUse) continue;
          if (tint[i] < minTint && !zoneBoost) continue;
          if (tint[i] < 0.020 && zoneBoost) continue;
          let near = false;
          for (let dy2 = -1; dy2 <= 1; dy2++) {
            for (let dx2 = -1; dx2 <= 1; dx2++) {
              if (!dx2 && !dy2) continue;
              if (fg[(y + dy2) * w + (x + dx2)] > 0.5) { near = true; break; }
            }
            if (near) break;
          }
          if (near) fg[i] = 1;
        }
      }
    }
  }

  /** Re-link score gaps only when touching existing icon strokes (no tile flood). */
  function _relinkNearFg(fg, score, edge, edgeSat, coolTint, tint, w, h, thresh) {
    const soft = thresh * 0.44;
    const fieldH = Math.min(h, 218);
    let added = 0;
    const cap = 900;
    for (let y = 2; y < fieldH - 2; y++) {
      for (let x = 2; x < w - 2; x++) {
        if (added >= cap) return;
        if (_centerSeamCorridor(x, y, w, h)) continue;
        if (_fpTopExclusiveZone(x, y, w, h) || _fpBottomExclusiveZone(x, y, w, h)) continue;
        const i = y * w + x;
        if (fg[i] > 0.5) continue;
        if (score[i] < soft) continue;
        if (tint[i] < 0.032) continue;
        if (edge[i] < 0.007 && edgeSat[i] < 0.007 && coolTint[i] < 0.040) continue;
        let near = false;
        for (let dy2 = -2; dy2 <= 2 && !near; dy2++) {
          for (let dx2 = -2; dx2 <= 2; dx2++) {
            if (!dx2 && !dy2) continue;
            if (fg[(y + dy2) * w + (x + dx2)] > 0.5) { near = true; break; }
          }
        }
        if (!near) continue;
        fg[i] = 1;
        added++;
      }
    }
  }

  /** Drop filled patchwork tile chunks and seam rectangles. */
  function _prunePatchworkTileSolids(fg, coolTint, warmTint, tint, hue, bgR, bgG, bgB, w, h, protect, fpLayout) {
    const bin = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) bin[i] = fg[i] > 0.5 ? 1 : 0;
    const seen = new Int32Array(w * h);
    const dx = [1, -1, 0, 0, 1, 1, -1, -1];
    const dy = [0, 0, 1, -1, 1, -1, 1, -1];
    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const si = sy * w + sx;
        if (!bin[si] || seen[si]) continue;
        const q = [si];
        seen[si] = 1;
        const pixels = [];
        let coolSum = 0, warmSum = 0, tintSum = 0, hueShiftSum = 0, prot = 0;
        let minX = sx, maxX = sx, minY = sy, maxY = sy;
        for (let qi = 0; qi < q.length; qi++) {
          const ci = q[qi];
          pixels.push(ci);
          coolSum += coolTint[ci];
          warmSum += warmTint[ci];
          tintSum += tint[ci];
          const lh = _rgbHue(bgR[ci], bgG[ci], bgB[ci]);
          hueShiftSum += _hueDist(hue[ci], lh);
          if (protect && protect[ci]) prot++;
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
        if (area < 80) continue;
        if (prot > area * 0.35) continue;
        const bw = maxX - minX + 1, bh = maxY - minY + 1;
        const fill = area / (bw * bh);
        const meanCool = coolSum / area;
        const meanWarm = warmSum / area;
        const meanTint = tintSum / area;
        const meanHueShift = hueShiftSum / area;
        const aspect = Math.max(bw, bh) / (Math.min(bw, bh) + 1);
        const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5;
        const fpTopLayout = fpLayout && fpLayout.zoneFn === _fpTopExclusiveZone;
        const fpBottomLayout = fpLayout && fpLayout.zoneFn === _fpBottomExclusiveZone;
        if (fpTopLayout && _fpTopExclusiveZone(cx | 0, cy | 0, w, h) && fill < 0.48) continue;
        if (fpBottomLayout && _fpBottomExclusiveZone(cx | 0, cy | 0, w, h) && fill < 0.48) continue;
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
        for (const pi of pixels) {
          if (protect && protect[pi]) continue;
          fg[pi] = 0;
        }
      }
    }
  }

  /** Hollow only thick filled blobs; leave thin strokes intact. */
  function _hollowThickGlyphs(fg, w, h, protect) {
    const fieldH = Math.min(h, 218);
    const bin = new Uint8Array(w * h);
    for (let y = 0; y < fieldH; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (fg[i] < 0.5) continue;
        if (protect && protect[i]) continue;
        if (_bellExclusiveZone(x, y, w, h)) continue;
        bin[i] = 1;
      }
    }
    const seen = new Int32Array(w * h);
    const dx = [1, -1, 0, 0, 1, 1, -1, -1];
    const dy = [0, 0, 1, -1, 1, -1, 1, -1];
    for (let sy = 0; sy < fieldH; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const si = sy * w + sx;
        if (!bin[si] || seen[si]) continue;
        const q = [si];
        seen[si] = 1;
        const pixels = [];
        let minX = sx, maxX = sx, minY = sy, maxY = sy;
        for (let qi = 0; qi < q.length; qi++) {
          const ci = q[qi];
          pixels.push(ci);
          const cy = (ci / w) | 0, cx = ci - cy * w;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
          for (let d = 0; d < 8; d++) {
            const nx = cx + dx[d], ny = cy + dy[d];
            if (nx < 0 || ny < 0 || nx >= w || ny >= fieldH) continue;
            const ni = ny * w + nx;
            if (!bin[ni] || seen[ni]) continue;
            seen[ni] = 1;
            q.push(ni);
          }
        }
        const area = pixels.length;
        const bw = maxX - minX + 1, bh = maxY - minY + 1;
        const fill = area / (bw * bh);
        if (area < 55 || fill < 0.38) continue;
        const mask = new Uint8Array(w * h);
        for (const pi of pixels) mask[pi] = 1;
        const thin = _hollowInterior(mask, minX, minY, maxX + 1, maxY + 1, w, h, 2, 7);
        for (const pi of pixels) {
          if (protect && protect[pi]) continue;
          const py = (pi / w) | 0, px = pi - py * w;
          if (_bellExclusiveZone(px, py, w, h)) continue;
          fg[pi] = thin[pi] ? 1 : 0;
        }
      }
    }
  }

  /** Drop isolated pepper specks (not camo-protected). */
  function _pruneLooseSpecks(fg, w, h, protect, minArea) {
    const bin = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) bin[i] = fg[i] > 0.5 ? 1 : 0;
    const seen = new Int32Array(w * h);
    const dx = [1, -1, 0, 0, 1, 1, -1, -1];
    const dy = [0, 0, 1, -1, 1, -1, 1, -1];
    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const si = sy * w + sx;
        if (!bin[si] || seen[si]) continue;
        const q = [si];
        seen[si] = 1;
        const pixels = [];
        let prot = 0;
        for (let qi = 0; qi < q.length; qi++) {
          const ci = q[qi];
          pixels.push(ci);
          if (protect && protect[ci]) prot++;
          const cy = (ci / w) | 0, cx = ci - cy * w;
          for (let d = 0; d < 8; d++) {
            const nx = cx + dx[d], ny = cy + dy[d];
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ni = ny * w + nx;
            if (!bin[ni] || seen[ni]) continue;
            seen[ni] = 1;
            q.push(ni);
          }
        }
        if (pixels.length >= minArea || prot > 0) continue;
        for (const pi of pixels) fg[pi] = 0;
      }
    }
  }

  function _wipeRightMarginSeam(fg, w, h) {
    const fieldH = Math.min(h, 218);
    const x0 = Math.floor(w * 0.91);
    for (let y = 0; y < fieldH; y++) {
      for (let x = x0; x < w; x++) {
        if (_fpTopExclusiveZone(x, y, w, h)) continue;
        fg[y * w + x] = 0;
      }
    }
  }

  function _suppressPatchworkLines(fg, edge, tint, coolTint, w, h) {
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      mask[i] = edge[i] > 0.018 && tint[i] < 0.06 && coolTint[i] < 0.05 ? 1 : 0;
    }
    const minLen = 28;
    const zeroH = () => {
      for (let y = 0; y < h; y++) {
        let run = 0;
        for (let x = 0; x < w; x++) {
          const idx = y * w + x;
          if (mask[idx]) {
            run++;
            if (run >= minLen) {
              for (let k = x - run + 1; k <= x; k++) {
                const fi = y * w + k;
                if (tint[fi] < 0.06 && coolTint[fi] < 0.05) fg[fi] = 0;
              }
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
            if (run >= minLen) {
              for (let k = y - run + 1; k <= y; k++) {
                const fi = k * w + x;
                if (tint[fi] < 0.06 && coolTint[fi] < 0.05) fg[fi] = 0;
              }
            }
          } else run = 0;
        }
      }
    };
    zeroH();
    zeroV();
  }

  /** Remove tile seam lines and low-cool blobs reintroduced by cool-edge recovery. */
  function _suppressTileSeamArtifacts(fg, edge, coolEdge, coolTint, tint, hue, bgR, bgG, bgB, w, h, protect) {
    const isSeam = (i) => {
      if (protect && protect[i]) return false;
      if (coolTint[i] >= 0.072 || tint[i] >= 0.085) return false;
      const lh = _rgbHue(bgR[i], bgG[i], bgB[i]);
      const hueShift = _hueDist(hue[i], lh);
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
              if (run >= need) {
                for (let k = x - run + 1; k <= x; k++) {
                  const fi = y * w + k;
                  if (isSeam(fi)) fg[fi] = 0;
                }
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
              if (run >= need) {
                for (let k = y - run + 1; k <= y; k++) {
                  const fi = k * w + x;
                  if (isSeam(fi)) fg[fi] = 0;
                }
              }
            } else run = 0;
          }
        }
      }
    };
    wipeRun("h");
    wipeRun("v");

    const bin = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      bin[i] = fg[i] > 0.5 && isSeam(i) ? 1 : 0;
    }
    const seen = new Int32Array(w * h);
    const dx = [1, -1, 0, 0, 1, 1, -1, -1];
    const dy = [0, 0, 1, -1, 1, -1, 1, -1];
    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
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
  }

  /** Wipe FG runs that are tile seams: strong edge, no icon tint / stroke color. */
  function _killTintlessSeamRuns(fg, tint, edge, strokeMatch, w, h) {
    const minLen = 12;
    const seam = (i) => tint[i] < 0.038 && (strokeMatch ? strokeMatch[i] < 0.22 : true) && edge[i] > 0.011;
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

  /** One-pass grow inside a zone only — avoids whole-field flood. */
  function _growZoneStrokesOnce(fg, tint, score, w, h, soft, zoneFn) {
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (!zoneFn(x, y, w, h)) continue;
        const i = y * w + x;
        if (fg[i] > 0.5) continue;
        if (tint[i] < 0.036) continue;
        if (score[i] < soft * 0.9) continue;
        let near = false;
        for (let dy2 = -1; dy2 <= 1; dy2++) {
          for (let dx2 = -1; dx2 <= 1; dx2++) {
            if (!dx2 && !dy2) continue;
            if (fg[(y + dy2) * w + (x + dx2)] > 0.5) { near = true; break; }
          }
          if (near) break;
        }
        if (near) fg[i] = 1;
      }
    }
  }

  /** One-pass grow: only into pixels with real icon tint. */
  function _growTintStrokesOnce(fg, coolTint, warmTint, hueShift, score, w, h, soft) {
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (fg[i] > 0.5) continue;
        const ct = coolTint[i], wt = warmTint[i], hs = hueShift[i];
        const colored = ct >= 0.032 || wt >= 0.032 || (hs >= 0.058 && score[i] >= soft * 0.85);
        if (!colored) continue;
        if (score[i] < soft && ct < 0.045 && wt < 0.045) continue;
        let near = false;
        for (let dy2 = -1; dy2 <= 1; dy2++) {
          for (let dx2 = -1; dx2 <= 1; dx2++) {
            if (!dx2 && !dy2) continue;
            if (fg[(y + dy2) * w + (x + dx2)] > 0.5) { near = true; break; }
          }
          if (near) break;
        }
        if (near) fg[i] = 1;
      }
    }
  }

  /** CC filter tuned for patchwork icons — rejects seam lines and sparse frames. */
  function _filterPatchworkComponents(score, tint, strokeMatch, localCtr, edgeSat, w, h, thresh) {
    const bin = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) bin[i] = score[i] >= thresh ? 1 : 0;
    const fg = new Float32Array(w * h);
    const seen = new Int32Array(w * h);
    const dx = [1, -1, 0, 0, 1, 1, -1, -1];
    const dy = [0, 0, 1, -1, 1, -1, 1, -1];
    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const si = sy * w + sx;
        if (!bin[si] || seen[si]) continue;
        const q = [si];
        seen[si] = 1;
        const pixels = [];
        let tintSum = 0;
        let strokeSum = 0;
        let localCtrSum = 0;
        let edgeSatSum = 0;
        let minX = sx, maxX = sx, minY = sy, maxY = sy;
        for (let qi = 0; qi < q.length; qi++) {
          const ci = q[qi];
          pixels.push(ci);
          tintSum += tint[ci];
          if (strokeMatch) strokeSum += strokeMatch[ci];
          if (localCtr) localCtrSum += localCtr[ci];
          if (edgeSat) edgeSatSum += edgeSat[ci];
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
        const bw = maxX - minX + 1, bh = maxY - minY + 1;
        const shortSide = Math.min(bw, bh);
        const longSide = Math.max(bw, bh);
        const aspect = longSide / Math.max(1, shortSide);
        const fill = area / (bw * bh);
        const meanTint = tintSum / area;
        const meanStroke = strokeMatch ? strokeSum / area : 0;
        const meanLocalCtr = localCtr ? localCtrSum / area : 0;
        const meanEdgeSat = edgeSat ? edgeSatSum / area : 0;
        const camoLike = meanStroke >= 0.22 || meanLocalCtr >= 0.012 || meanEdgeSat >= 0.008;
        const sparse = bw * bh >= 1800 && fill < 0.22;
        const longSeam = aspect > 6.5 && shortSide < 11;
        const lowTint = meanTint < 0.034 && !camoLike;
        if (area < 20 || area > 3000 || longSeam || sparse || lowTint) continue;
        if (aspect > 5 && shortSide < 9 && meanTint < 0.042 && meanStroke < 0.20) continue;
        if (area > 600 && fill < 0.11) continue;
        for (const pi of pixels) fg[pi] = 1;
      }
    }
    return fg;
  }

  /** Drop interior fill — keep edge/signal cores only. */
  function _retainStrokeCores(fg, edge, edgeSat, tint, strokeMatch, w, h, protect) {
    const fieldH = Math.min(h, 218);
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 1; y < fieldH - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (fg[i] < 0.5) continue;
          if (protect && protect[i]) continue;
          if (_bellExclusiveZone(x, y, w, h)) continue;
          if (strokeMatch && strokeMatch[i] >= 0.28) continue;
          if (edge[i] > 0.012 || edgeSat[i] > 0.010) continue;
          if (tint[i] > 0.055) continue;
          let nbr = 0;
          for (let dy2 = -1; dy2 <= 1; dy2++) {
            for (let dx2 = -1; dx2 <= 1; dx2++) {
              if (!dx2 && !dy2) continue;
              if (fg[(y + dy2) * w + (x + dx2)] > 0.5) nbr++;
            }
          }
          if (nbr >= 6) fg[i] = 0;
        }
      }
    }
  }

  /** Remove hollow rectangle frames left from patchwork tile borders. */
  function _pruneTileRectFrames(fg, coolTint, warmTint, tint, hue, bgR, bgG, bgB, w, h, protect) {
    const bin = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) bin[i] = fg[i] > 0.5 ? 1 : 0;
    const seen = new Int32Array(w * h);
    const dx = [1, -1, 0, 0, 1, 1, -1, -1];
    const dy = [0, 0, 1, -1, 1, -1, 1, -1];
    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const si = sy * w + sx;
        if (!bin[si] || seen[si]) continue;
        const q = [si];
        seen[si] = 1;
        const pixels = [];
        let tintSum = 0, hueShiftSum = 0, prot = 0;
        let minX = sx, maxX = sx, minY = sy, maxY = sy;
        for (let qi = 0; qi < q.length; qi++) {
          const ci = q[qi];
          pixels.push(ci);
          tintSum += Math.max(coolTint[ci], warmTint[ci]);
          hueShiftSum += _hueDist(hue[ci], _rgbHue(bgR[ci], bgG[ci], bgB[ci]));
          if (protect && protect[ci]) prot++;
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
        if (area < 80 || prot > area * 0.25) continue;
        const bw = maxX - minX + 1, bh = maxY - minY + 1;
        const fill = area / (bw * bh);
        const meanTint = tintSum / area;
        const meanHueShift = hueShiftSum / area;
        const aspect = Math.max(bw, bh) / (Math.min(bw, bh) + 1);
        const tileFrame = (bw >= 32 || bh >= 26)
          && fill >= 0.04 && fill <= 0.32
          && meanTint < 0.052
          && meanHueShift < 0.075
          && aspect >= 1.15 && aspect <= 6.5
          && area <= 3200;
        if (!tileFrame) continue;
        for (const pi of pixels) {
          if (protect && protect[pi]) continue;
          fg[pi] = 0;
        }
      }
    }
  }

  /** Thin only filled blobs — leave naturally thin strokes intact. */
  function _thinThickComponents(fg, edgeSat, w, h, protect) {
    const fieldH = Math.min(h, 218);
    const bin = new Uint8Array(w * h);
    for (let y = 0; y < fieldH; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (fg[i] > 0.5) bin[i] = 1;
      }
    }
    const seen = new Int32Array(w * h);
    const dx = [1, -1, 0, 0, 1, 1, -1, -1];
    const dy = [0, 0, 1, -1, 1, -1, 1, -1];
    for (let sy = 0; sy < fieldH; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const si = sy * w + sx;
        if (!bin[si] || seen[si]) continue;
        const q = [si];
        seen[si] = 1;
        const pixels = [];
        let minX = sx, maxX = sx, minY = sy, maxY = sy;
        for (let qi = 0; qi < q.length; qi++) {
          const ci = q[qi];
          pixels.push(ci);
          const cy = (ci / w) | 0, cx = ci - cy * w;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
          for (let d = 0; d < 8; d++) {
            const nx = cx + dx[d], ny = cy + dy[d];
            if (nx < 0 || ny < 0 || nx >= w || ny >= fieldH) continue;
            const ni = ny * w + nx;
            if (!bin[ni] || seen[ni]) continue;
            seen[ni] = 1;
            q.push(ni);
          }
        }
        const area = pixels.length;
        const bw = maxX - minX + 1, bh = maxY - minY + 1;
        const fill = area / (bw * bh);
        if (area < 45 || fill < 0.28) continue;
        const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5;
        if (_bellExclusiveZone(cx | 0, cy | 0, w, h)) continue;
        const mask = new Uint8Array(w * h);
        for (const pi of pixels) mask[pi] = 1;
        let thin = _cardinalThin(mask, minX, minY, maxX + 1, maxY + 1, w, h, 2, 3);
        thin = _cardinalThin(thin, minX, minY, maxX + 1, maxY + 1, w, h, 2, 3);
        for (const pi of pixels) {
          if (protect && protect[pi]) continue;
          const py = (pi / w) | 0, px = pi - py * w;
          if (thin[pi]) { fg[pi] = 1; continue; }
          if (edgeSat[pi] >= 0.022) { fg[pi] = 1; continue; }
          fg[pi] = 0;
        }
      }
    }
  }

  /** Dilate low-fill icon blobs locally — closes broken outlines before hole fill. */
  function _closeLowFillComponents(fg, w, h) {
    const bin = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) bin[i] = fg[i] > 0.5 ? 1 : 0;
    const seen = new Int32Array(w * h);
    const dx = [1, -1, 0, 0, 1, 1, -1, -1];
    const dy = [0, 0, 1, -1, 1, -1, 1, -1];
    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const si = sy * w + sx;
        if (!bin[si] || seen[si]) continue;
        const q = [si];
        seen[si] = 1;
        const pixels = [];
        let minX = sx, maxX = sx, minY = sy, maxY = sy;
        for (let qi = 0; qi < q.length; qi++) {
          const ci = q[qi];
          pixels.push(ci);
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
        const bw = maxX - minX + 1, bh = maxY - minY + 1;
        const area = pixels.length;
        const fill = area / (bw * bh);
        const shortSide = Math.min(bw, bh);
        if (area < 80 || area > 4200 || shortSide < 16) continue;
        if (fill >= 0.40 || fill < 0.04) continue;
        const pad = 1;
        const x0 = Math.max(0, minX - pad), y0 = Math.max(0, minY - pad);
        const x1 = Math.min(w - 1, maxX + pad), y1 = Math.min(h - 1, maxY + pad);
        const zoneFn = (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
        let mask = new Uint8Array(w * h);
        for (const pi of pixels) mask[pi] = 1;
        for (let p = 0; p < 2; p++) {
          const next = _dilateCardinalOnce(mask, zoneFn, w, h);
          for (let i = 0; i < w * h; i++) if (next[i]) mask[i] = 1;
        }
        for (let i = 0; i < w * h; i++) if (mask[i]) fg[i] = 1;
      }
    }
  }

  /** Row/column scanline fill inside low-fill icon blobs (crown, bell rings). */
  function _scanlineFillLowComponents(fg, w, h) {
    const bin = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) bin[i] = fg[i] > 0.5 ? 1 : 0;
    const seen = new Int32Array(w * h);
    const dx = [1, -1, 0, 0, 1, 1, -1, -1];
    const dy = [0, 0, 1, -1, 1, -1, 1, -1];
    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const si = sy * w + sx;
        if (!bin[si] || seen[si]) continue;
        const q = [si];
        seen[si] = 1;
        const pixels = [];
        let minX = sx, maxX = sx, minY = sy, maxY = sy;
        for (let qi = 0; qi < q.length; qi++) {
          const ci = q[qi];
          pixels.push(ci);
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
        const bw = maxX - minX + 1, bh = maxY - minY + 1;
        const area = pixels.length;
        const fill = area / (bw * bh);
        const shortSide = Math.min(bw, bh);
        if (area < 100 || area > 4500 || shortSide < 14) continue;
        if (fill >= 0.75 || fill < 0.06) continue;
        const cx = ((minX + maxX) / 2) | 0, cy = ((minY + maxY) / 2) | 0;
        const centerEmpty = !bin[cy * w + cx];
        if (!centerEmpty && fill >= 0.62) continue;
        for (let y = minY; y <= maxY; y++) {
          let lx = -1, rx = -1;
          for (let x = minX; x <= maxX; x++) {
            if (bin[y * w + x]) { lx = x; break; }
          }
          for (let x = maxX; x >= minX; x--) {
            if (bin[y * w + x]) { rx = x; break; }
          }
          if (lx < 0 || rx - lx < 5) continue;
          for (let x = lx + 1; x < rx; x++) fg[y * w + x] = 1;
        }
        for (let x = minX; x <= maxX; x++) {
          let ty = -1, by = -1;
          for (let y = minY; y <= maxY; y++) {
            if (bin[y * w + x]) { ty = y; break; }
          }
          for (let y = maxY; y >= minY; y--) {
            if (bin[y * w + x]) { by = y; break; }
          }
          if (ty < 0 || by - ty < 5) continue;
          for (let y = ty + 1; y < by; y++) fg[y * w + x] = 1;
        }
      }
    }
  }

  /** Cardinal dilate on full field — closes stroke gaps before hole fill. */
  function _dilateBandpassFg(fg, w, h, passes = 2) {
    let mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = fg[i] > 0.5 ? 1 : 0;
    const allZone = () => true;
    for (let p = 0; p < passes; p++) {
      const next = _dilateCardinalOnce(mask, allZone, w, h);
      for (let i = 0; i < w * h; i++) if (next[i]) mask[i] = 1;
    }
    for (let i = 0; i < w * h; i++) fg[i] = mask[i] ? 1 : 0;
  }

  /** Fill enclosed holes inside each icon-like blob (not full-image flood). */
  function _fillIconComponentHoles(fg, w, h) {
    const bin = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) bin[i] = fg[i] > 0.5 ? 1 : 0;
    const seen = new Int32Array(w * h);
    const dx = [1, -1, 0, 0, 1, 1, -1, -1];
    const dy = [0, 0, 1, -1, 1, -1, 1, -1];
    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const si = sy * w + sx;
        if (!bin[si] || seen[si]) continue;
        const q = [si];
        seen[si] = 1;
        const pixels = [];
        let minX = sx, maxX = sx, minY = sy, maxY = sy;
        for (let qi = 0; qi < q.length; qi++) {
          const ci = q[qi];
          pixels.push(ci);
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
        const bw = maxX - minX + 1, bh = maxY - minY + 1;
        const area = pixels.length;
        const fill = area / (bw * bh);
        if (area < 10 || (bw >= 90 && bh >= 60)) continue;
        if (fill >= 0.52) continue;
        const pad = 1;
        const x0 = Math.max(0, minX - pad), y0 = Math.max(0, minY - pad);
        const x1 = Math.min(w - 1, maxX + pad), y1 = Math.min(h - 1, maxY + pad);
        const rw = x1 - x0 + 1, rh = y1 - y0 + 1;
        const local = new Uint8Array(rw * rh);
        for (const pi of pixels) {
          const cy = (pi / w) | 0, cx = pi - cy * w;
          local[(cy - y0) * rw + (cx - x0)] = 1;
        }
        const outside = new Uint8Array(rw * rh);
        const bq = [];
        const pushOut = (lx, ly) => {
          if (lx < 0 || ly < 0 || lx >= rw || ly >= rh) return;
          const li = ly * rw + lx;
          if (local[li] || outside[li]) return;
          outside[li] = 1;
          bq.push(lx, ly);
        };
        for (let lx = 0; lx < rw; lx++) { pushOut(lx, 0); pushOut(lx, rh - 1); }
        for (let ly = 0; ly < rh; ly++) { pushOut(0, ly); pushOut(rw - 1, ly); }
        for (let bi = 0; bi < bq.length; bi += 2) {
          const lx = bq[bi], ly = bq[bi + 1];
          pushOut(lx + 1, ly);
          pushOut(lx - 1, ly);
          pushOut(lx, ly + 1);
          pushOut(lx, ly - 1);
        }
        for (let ly = 0; ly < rh; ly++) {
          for (let lx = 0; lx < rw; lx++) {
            const li = ly * rw + lx;
            if (local[li] || outside[li]) continue;
            fg[(y0 + ly) * w + (x0 + lx)] = 1;
          }
        }
      }
    }
  }

  /** Raw per-pixel hits before CC filter — for sparse zone recovery. */
  function _buildPatchworkRawHitBin(rCh, gCh, bCh, sat, edge, coolTint, warmTint, hue, bgR, bgG, bgB, w, h) {
    const n = w * h;
    const loc6R = boxBlurChannel(rCh, w, h, 6);
    const loc6G = boxBlurChannel(gCh, w, h, 6);
    const loc6B = boxBlurChannel(bCh, w, h, 6);
    const loc24R = boxBlurChannel(rCh, w, h, 24);
    const loc24G = boxBlurChannel(gCh, w, h, 24);
    const loc24B = boxBlurChannel(bCh, w, h, 24);
    const edgeSat = _buildSatEdge(sat, w, h);
    const bin = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const small = Math.hypot(rCh[i] - loc6R[i], gCh[i] - loc6G[i], bCh[i] - loc6B[i]);
      const large = Math.hypot(rCh[i] - loc24R[i], gCh[i] - loc24G[i], bCh[i] - loc24B[i]);
      const band = small - large * 0.55;
      const es = edgeSat[i];
      const ct = coolTint[i];
      const wt = warmTint[i];
      const hsBg = _hueDist(hue[i], _rgbHue(bgR[i], bgG[i], bgB[i]));
      let hit = band > 0.008 && es > 0.0035 && small > 0.006;
      if (!hit && (ct >= 0.018 || wt >= 0.016) && hsBg >= 0.028 && es >= 0.003 && edge[i] >= 0.0025) {
        hit = true;
      }
      if (hit) bin[i] = 1;
    }
    return bin;
  }

  /** Merge filtered stroke seeds only into zones that band-pass left nearly empty. */
  function _mergeSeedsInSparseZones(fg, seedFg, zones, w, h) {
    const fieldH = Math.min(h, 218);
    for (const z of zones) {
      let fgPx = 0;
      for (let y = 0; y < fieldH; y++) {
        for (let x = 0; x < w; x++) {
          if (!z.zoneFn(x, y, w, h)) continue;
          if (fg[y * w + x] > 0.5) fgPx++;
        }
      }
      if (fgPx >= z.minPx) continue;
      for (let y = 0; y < fieldH; y++) {
        for (let x = 0; x < w; x++) {
          if (!z.zoneFn(x, y, w, h)) continue;
          const i = y * w + x;
          if (seedFg[i] > 0.5) fg[i] = 1;
        }
      }
    }
  }

  /** Shared band-pass signal (strict thresholds). */
  function _buildPatchworkBandpassRaw(rCh, gCh, bCh, sat, edge, coolTint, warmTint, hue, bgR, bgG, bgB, w, h) {
    const n = w * h;
    const loc6R = boxBlurChannel(rCh, w, h, 6);
    const loc6G = boxBlurChannel(gCh, w, h, 6);
    const loc6B = boxBlurChannel(bCh, w, h, 6);
    const loc24R = boxBlurChannel(rCh, w, h, 24);
    const loc24G = boxBlurChannel(gCh, w, h, 24);
    const loc24B = boxBlurChannel(bCh, w, h, 24);
    const edgeSat = _buildSatEdge(sat, w, h);
    const signal = new Float32Array(n);
    const bin = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const small = Math.hypot(rCh[i] - loc6R[i], gCh[i] - loc6G[i], bCh[i] - loc6B[i]);
      const large = Math.hypot(rCh[i] - loc24R[i], gCh[i] - loc24G[i], bCh[i] - loc24B[i]);
      const band = small - large * 0.55;
      const es = edgeSat[i];
      const ct = coolTint[i];
      const wt = warmTint[i];
      const hsBg = _hueDist(hue[i], _rgbHue(bgR[i], bgG[i], bgB[i]));
      let hit = band > 0.010 && es > 0.004 && small > 0.007;
      if (!hit && (ct >= 0.020 || wt >= 0.018) && hsBg >= 0.032 && es >= 0.0032 && edge[i] >= 0.003) {
        hit = true;
      }
      if (hit) {
        signal[i] = Math.max(band * es * 48, es * Math.max(ct, wt) * 14, 0.04);
        bin[i] = 1;
      }
    }
    return { bin, signal, edgeSat };
  }

  /** Relaxed CC inside one zone — keeps fragmented icon strokes CC filter dropped. */
  function _mergeSparseZoneBandpass(
    fg, bin, signal, edgeSat, rCh, gCh, bCh, sat, edge, coolTint, warmTint, hue, bgR, bgG, bgB,
    zoneFn, w, h, minFgPx,
  ) {
    const fieldH = Math.min(h, 218);
    let fgPx = 0;
    for (let y = 0; y < fieldH; y++) {
      for (let x = 0; x < w; x++) {
        if (!zoneFn(x, y, w, h)) continue;
        if (fg[y * w + x] > 0.5) fgPx++;
      }
    }
    if (fgPx >= minFgPx) return;

    const zoneBin = new Uint8Array(w * h);
    const zoneSig = new Float32Array(w * h);
    const loc6R = boxBlurChannel(rCh, w, h, 6);
    const loc6G = boxBlurChannel(gCh, w, h, 6);
    const loc6B = boxBlurChannel(bCh, w, h, 6);
    const loc24R = boxBlurChannel(rCh, w, h, 24);
    const loc24G = boxBlurChannel(gCh, w, h, 24);
    const loc24B = boxBlurChannel(bCh, w, h, 24);
    for (let y = 0; y < fieldH; y++) {
      for (let x = 0; x < w; x++) {
        if (!zoneFn(x, y, w, h)) continue;
        const i = y * w + x;
        if (bin[i]) { zoneBin[i] = 1; zoneSig[i] = signal[i]; continue; }
        const small = Math.hypot(rCh[i] - loc6R[i], gCh[i] - loc6G[i], bCh[i] - loc6B[i]);
        const large = Math.hypot(rCh[i] - loc24R[i], gCh[i] - loc24G[i], bCh[i] - loc24B[i]);
        const band = small - large * 0.55;
        const es = edgeSat[i];
        const ct = coolTint[i];
        const wt = warmTint[i];
        const hsBg = _hueDist(hue[i], _rgbHue(bgR[i], bgG[i], bgB[i]));
        let hit = band > 0.008 && es > 0.0035 && small > 0.006;
        if (!hit && (ct >= 0.018 || wt >= 0.016) && hsBg >= 0.028 && es >= 0.003 && edge[i] >= 0.0025) {
          hit = true;
        }
        if (!hit) continue;
        zoneBin[i] = 1;
        zoneSig[i] = Math.max(band * es * 48, es * Math.max(ct, wt) * 14, 0.03);
      }
    }

    const seen = new Int32Array(w * h);
    const dx = [1, -1, 0, 0, 1, 1, -1, -1];
    const dy = [0, 0, 1, -1, 1, -1, 1, -1];
    let added = 0;
    const maxAdd = 1400;
    for (let sy = 0; sy < fieldH; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const si = sy * w + sx;
        if (!zoneBin[si] || seen[si]) continue;
        const q = [si];
        seen[si] = 1;
        const pixels = [];
        let sigSum = 0;
        let minX = sx, maxX = sx, minY = sy, maxY = sy;
        for (let qi = 0; qi < q.length; qi++) {
          const ci = q[qi];
          pixels.push(ci);
          sigSum += zoneSig[ci];
          const cy = (ci / w) | 0, cx = ci - cy * w;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
          for (let d = 0; d < 8; d++) {
            const nx = cx + dx[d], ny = cy + dy[d];
            if (nx < 0 || ny < 0 || nx >= w || ny >= fieldH) continue;
            const ni = ny * w + nx;
            if (!zoneBin[ni] || seen[ni]) continue;
            seen[ni] = 1;
            q.push(ni);
          }
        }
        const area = pixels.length;
        const bw = maxX - minX + 1, bh = maxY - minY + 1;
        const shortSide = Math.min(bw, bh);
        const longSide = Math.max(bw, bh);
        const aspect = longSide / Math.max(1, shortSide);
        const fill = area / (bw * bh);
        const meanSig = sigSum / area;
        const longSeam = aspect > 8 && shortSide < 8;
        const tileFrame = bw >= 26 && bh >= 20 && fill < 0.18 && fill >= 0.04;
        if (area < 5 || area > 1200 || longSeam || tileFrame) continue;
        if (meanSig < 0.018) continue;
        if (added + area > maxAdd) continue;
        for (const pi of pixels) fg[pi] = 1;
        added += area;
      }
    }
  }

  /** Band-pass color residual: thin strokes vs tile-sized background (rad 6 vs 24). */
  function _buildPatchworkBandpassFg(rCh, gCh, bCh, sat, edge, coolTint, warmTint, hue, bgR, bgG, bgB, w, h) {
    const { bin, signal, edgeSat } = _buildPatchworkBandpassRaw(
      rCh, gCh, bCh, sat, edge, coolTint, warmTint, hue, bgR, bgG, bgB, w, h,
    );
    return _filterBandpassComponents(bin, signal, edgeSat, w, h, 0.05);
  }

  /** Remove tile-sized hollow rectangles left in band-pass output. */
  function _pruneBandpassTileFrames(fg, w, h) {
    const bin = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) bin[i] = fg[i] > 0.5 ? 1 : 0;
    const seen = new Int32Array(w * h);
    const dx = [1, -1, 0, 0, 1, 1, -1, -1];
    const dy = [0, 0, 1, -1, 1, -1, 1, -1];
    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const si = sy * w + sx;
        if (!bin[si] || seen[si]) continue;
        const q = [si];
        seen[si] = 1;
        const pixels = [];
        let minX = sx, maxX = sx, minY = sy, maxY = sy;
        for (let qi = 0; qi < q.length; qi++) {
          const ci = q[qi];
          pixels.push(ci);
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
        const bw = maxX - minX + 1, bh = maxY - minY + 1;
        const fill = area / (bw * bh);
        let border = 0;
        for (const pi of pixels) {
          const cy = (pi / w) | 0, cx = pi - cy * w;
          if (cx === minX || cx === maxX || cy === minY || cy === maxY) border++;
        }
        const borderRatio = border / area;
        const tileFrame = bw >= 20 && bh >= 14 && fill < 0.26 && borderRatio > 0.48;
        const hugeFrame = bw >= 70 && bh >= 45 && fill < 0.32;
        if (!tileFrame && !hugeFrame) continue;
        for (const pi of pixels) fg[pi] = 0;
      }
    }
  }

  /** CC filter for band-pass mask — drop tile rectangles and long seams. */
  function _filterBandpassComponents(bin, signal, edgeSat, w, h, thresh) {
    const fg = new Float32Array(w * h);
    const seen = new Int32Array(w * h);
    const dx = [1, -1, 0, 0, 1, 1, -1, -1];
    const dy = [0, 0, 1, -1, 1, -1, 1, -1];
    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const si = sy * w + sx;
        if (!bin[si] || seen[si]) continue;
        const q = [si];
        seen[si] = 1;
        const pixels = [];
        let sigSum = 0;
        let minX = sx, maxX = sx, minY = sy, maxY = sy;
        for (let qi = 0; qi < q.length; qi++) {
          const ci = q[qi];
          pixels.push(ci);
          sigSum += signal[ci];
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
        const bw = maxX - minX + 1, bh = maxY - minY + 1;
        const shortSide = Math.min(bw, bh);
        const longSide = Math.max(bw, bh);
        const aspect = longSide / Math.max(1, shortSide);
        const fill = area / (bw * bh);
        const meanSig = sigSum / area;
        let border = 0;
        for (const pi of pixels) {
          const cy = (pi / w) | 0, cx = pi - cy * w;
          if (cx === minX || cx === maxX || cy === minY || cy === maxY) border++;
        }
        const borderRatio = border / area;
        const longSeam = aspect > 7 && shortSide < 10;
        const sparse = bw * bh >= 2000 && fill < 0.11;
        const tileFrame = bw >= 22 && bh >= 16 && fill < 0.22 && borderRatio > 0.54;
        const hugeTile = bw >= 80 && bh >= 50 && fill < 0.28;
        if (area < 8 || area > 3600 || longSeam || sparse || tileFrame || hugeTile) continue;
        if (meanSig < thresh * 0.5 && thresh > 0) continue;
        for (const pi of pixels) fg[pi] = 1;
      }
    }
    return fg;
  }

  /** Strict per-pixel seeds: stroke palette / lavender tint / local ridge — no score threshold. */
  function _buildStrokeFirstSeeds(
    rCh, gCh, bCh, hue, edge, coolTint, warmTint, edgeSat, satRes, strokeMatch, localCtr,
    locR, locG, locB, bgR, bgG, bgB, w, h,
  ) {
    const fieldH = Math.min(h, 218);
    const seed = new Uint8Array(w * h);
    for (let y = 0; y < fieldH; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const sm = strokeMatch[i];
        const es = edgeSat[i];
        const ct = coolTint[i];
        const wt = warmTint[i];
        const lc = localCtr[i];
        const e = edge[i];
        const tileHue = _rgbHue(locR[i], locG[i], locB[i]);
        const hsTile = _hueDist(hue[i], tileHue);
        const hsBg = _hueDist(hue[i], _rgbHue(bgR[i], bgG[i], bgB[i]));

        if (e < 0.004 && es < 0.0035) continue;
        if (e >= 0.009 && es < 0.0035 && sm < 0.22 && ct < 0.022 && lc < 0.012) continue;
        if (hsTile < 0.022 && sm < 0.28 && ct < 0.024 && wt < 0.022) continue;

        if (sm >= 0.32 && es >= 0.004) {
          seed[i] = 1;
          continue;
        }
        if ((ct >= 0.024 || wt >= 0.022) && hsBg >= 0.038 && es >= 0.0038 && e >= 0.004) {
          seed[i] = 1;
          continue;
        }
        if (lc >= 0.016 && es >= 0.005) {
          seed[i] = 1;
          continue;
        }
        if (_bellExclusiveZone(x, y, w, h) && _isGreenCamoStroke(hue, edgeSat, satRes, bgR, bgG, bgB, i) && es >= 0.004) {
          seed[i] = 1;
        }
      }
    }
    return seed;
  }

  /** One pass: bridge 1px gaps only on stroke-colored / tinted pixels. */
  function _connectStrokeSeedsOnce(seed, strokeMatch, coolTint, warmTint, edgeSat, w, h) {
    const fieldH = Math.min(h, 218);
    const out = new Uint8Array(seed);
    for (let y = 1; y < fieldH - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (out[i]) continue;
        const sm = strokeMatch[i];
        const ct = coolTint[i], wt = warmTint[i];
        if (sm < 0.18 && ct < 0.020 && wt < 0.018) continue;
        if (edgeSat[i] < 0.0035) continue;
        let nbr = 0;
        if (out[i - 1]) nbr++;
        if (out[i + 1]) nbr++;
        if (out[i - w]) nbr++;
        if (out[i + w]) nbr++;
        if (nbr >= 2) out[i] = 1;
      }
    }
    return out;
  }

  /** CC filter for stroke-first seeds — drop seams and tile frames. */
  function _filterStrokeSeedComponents(seed, strokeMatch, edgeSat, coolTint, warmTint, localCtr, w, h) {
    const fg = new Float32Array(w * h);
    const seen = new Int32Array(w * h);
    const dx = [1, -1, 0, 0, 1, 1, -1, -1];
    const dy = [0, 0, 1, -1, 1, -1, 1, -1];
    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const si = sy * w + sx;
        if (!seed[si] || seen[si]) continue;
        const q = [si];
        seen[si] = 1;
        const pixels = [];
        let smSum = 0, ctSum = 0, lcSum = 0, esSum = 0;
        let minX = sx, maxX = sx, minY = sy, maxY = sy;
        for (let qi = 0; qi < q.length; qi++) {
          const ci = q[qi];
          pixels.push(ci);
          smSum += strokeMatch[ci];
          ctSum += Math.max(coolTint[ci], warmTint[ci]);
          lcSum += localCtr[ci];
          esSum += edgeSat[ci];
          const cy = (ci / w) | 0, cx = ci - cy * w;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
          for (let d = 0; d < 8; d++) {
            const nx = cx + dx[d], ny = cy + dy[d];
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ni = ny * w + nx;
            if (!seed[ni] || seen[ni]) continue;
            seen[ni] = 1;
            q.push(ni);
          }
        }
        const area = pixels.length;
        const bw = maxX - minX + 1, bh = maxY - minY + 1;
        const shortSide = Math.min(bw, bh);
        const longSide = Math.max(bw, bh);
        const aspect = longSide / Math.max(1, shortSide);
        const fill = area / (bw * bh);
        const meanSm = smSum / area;
        const meanCt = ctSum / area;
        const meanLc = lcSum / area;
        const meanEs = esSum / area;
        const iconLike = meanSm >= 0.18 || meanCt >= 0.022 || meanLc >= 0.010;
        const longSeam = aspect > 7 && shortSide < 9;
        const sparse = bw * bh >= 1400 && fill < 0.14;
        const tileFrame = (bw >= 28 || bh >= 22) && fill >= 0.04 && fill <= 0.28 && meanSm < 0.16 && meanCt < 0.024;
        if (area < 10 || area > 2800 || longSeam || sparse || tileFrame) continue;
        if (!iconLike || meanEs < 0.0035) continue;
        for (const pi of pixels) fg[pi] = 1;
      }
    }
    return fg;
  }

  /** Per-pixel chroma+edge seeds — no score threshold / no dilation. */
  function _buildPatchworkSeeds(
    rCh, gCh, bCh, hue, edge, coolEdge, coolTint, warmTint, edgeSat, satRes, camo, bgR, bgG, bgB, w, h,
  ) {
    const fieldH = Math.min(h, 218);
    const seed = new Uint8Array(w * h);
    for (let y = 0; y < fieldH; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const hs = _hueDist(hue[i], _rgbHue(bgR[i], bgG[i], bgB[i]));
        const ct = coolTint[i], wt = warmTint[i];
        const cd = Math.hypot(rCh[i] - bgR[i], gCh[i] - bgG[i], bCh[i] - bgB[i]);
        const e = edge[i], es = edgeSat[i], sr = satRes[i];

        if (e > 0.012 && ct < 0.036 && wt < 0.036 && hs < 0.050 && cd < 0.017) continue;
        if (e < 0.006 && es < 0.005) continue;

        const chroma = ct >= 0.032 || wt >= 0.028
          || (hs >= 0.054 && (es >= 0.005 || sr >= 0.0012));
        if (!chroma && camo[i] < 0.012) continue;
        if (cd < 0.008 && ct < 0.040 && wt < 0.040 && camo[i] < 0.015) continue;

        if (_bellExclusiveZone(x, y, w, h) && _isGreenCamoStroke(hue, edgeSat, satRes, bgR, bgG, bgB, i)) {
          seed[i] = 1;
          continue;
        }
        if (camo[i] >= 0.013 && es >= 0.0055) {
          seed[i] = 1;
          continue;
        }
        const effE = _strokeEdge(edge, coolEdge, tint, i);
        if (effE >= 0.0065 || es >= 0.006) seed[i] = 1;
      }
    }
    for (let y = 1; y < fieldH - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (seed[i]) continue;
        const hs = _hueDist(hue[i], _rgbHue(bgR[i], bgG[i], bgB[i]));
        const ct = coolTint[i], wt = warmTint[i];
        if (ct < 0.032 && wt < 0.030 && hs < 0.054) continue;
        if (edgeSat[i] < 0.0055 && edge[i] < 0.0065) continue;
        let near = false;
        const nbrs = [[0, -1], [0, 1], [-1, 0], [1, 0]];
        for (const [dx2, dy2] of nbrs) {
          if (seed[(y + dy2) * w + (x + dx2)]) { near = true; break; }
        }
        if (near && (ct >= 0.033 || wt >= 0.030 || hs >= 0.056)) seed[i] = 1;
      }
    }
    return seed;
  }

  /** CC filter on seed mask. */
  function _filterSeedComponents(seed, coolTint, warmTint, w, h) {
    const fg = new Float32Array(w * h);
    const seen = new Int32Array(w * h);
    const dx = [1, -1, 0, 0, 1, 1, -1, -1];
    const dy = [0, 0, 1, -1, 1, -1, 1, -1];
    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const si = sy * w + sx;
        if (!seed[si] || seen[si]) continue;
        const q = [si];
        seen[si] = 1;
        const pixels = [];
        let tintSum = 0;
        let minX = sx, maxX = sx, minY = sy, maxY = sy;
        for (let qi = 0; qi < q.length; qi++) {
          const ci = q[qi];
          pixels.push(ci);
          tintSum += Math.max(coolTint[ci], warmTint[ci]);
          const cy = (ci / w) | 0, cx = ci - cy * w;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
          for (let d = 0; d < 8; d++) {
            const nx = cx + dx[d], ny = cy + dy[d];
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ni = ny * w + nx;
            if (!seed[ni] || seen[ni]) continue;
            seen[ni] = 1;
            q.push(ni);
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
    }
    return fg;
  }

  /** Patchwork: band-pass + sparse-zone seeds + light close/fill (v131). */
  function _runPatchworkPipeline(
    score, fgOut, rCh, gCh, bCh, hue, sat, edge, coolEdge, coolTint, warmTint, tint,
    satRes, lumRes, edgeSat, camo, bgR, bgG, bgB, localGate, localCtr, strokeMatch, localDist,
    locR, locG, locB, w, h, n, opts,
  ) {
    const raw = _buildPatchworkBandpassRaw(
      rCh, gCh, bCh, sat, edge, coolTint, warmTint, hue, bgR, bgG, bgB, w, h,
    );
    const fg = _filterBandpassComponents(raw.bin, raw.signal, raw.edgeSat, w, h, 0.05);

    let seeds = _buildStrokeFirstSeeds(
      rCh, gCh, bCh, hue, edge, coolTint, warmTint, edgeSat, satRes, strokeMatch, localCtr,
      locR, locG, locB, bgR, bgG, bgB, w, h,
    );
    seeds = _connectStrokeSeedsOnce(seeds, strokeMatch, coolTint, warmTint, edgeSat, w, h);
    const seedFg = _filterStrokeSeedComponents(seeds, strokeMatch, edgeSat, coolTint, warmTint, localCtr, w, h);
    _mergeSeedsInSparseZones(fg, seedFg, [
      { zoneFn: _showerRecoverZone, minPx: 25 },
      { zoneFn: _cloudRecoverZone, minPx: 35 },
      { zoneFn: _bellExclusiveZone, minPx: 25 },
    ], w, h);
    _mergeSparseZoneBandpass(
      fg, raw.bin, raw.signal, raw.edgeSat, rCh, gCh, bCh, sat, edge, coolTint, warmTint, hue, bgR, bgG, bgB,
      _showerRecoverZone, w, h, 90,
    );
    _mergeSparseZoneBandpass(
      fg, raw.bin, raw.signal, raw.edgeSat, rCh, gCh, bCh, sat, edge, coolTint, warmTint, hue, bgR, bgG, bgB,
      _cloudRecoverZone, w, h, 110,
    );

    _dilateBandpassFg(fg, w, h, 1);
    _closeLowFillComponents(fg, w, h);
    _fillIconComponentHoles(fg, w, h);

    _pruneBandpassTileFrames(fg, w, h);
    _pruneLooseSpecks(fg, w, h, null, 5);

    for (let i = 0; i < n; i++) fgOut[i] = fg[i] > 0.5 ? 1 : 0;
    fgOut._style = "patchwork";
    return fgOut;
  }

  function _mergeOrphanComponents(score, w, h, thresh, minArea) {
    const bin = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) bin[i] = score[i] >= thresh ? 1 : 0;

    const fg = new Float32Array(w * h);
    const seen = new Int32Array(w * h);
    const dx = [1, -1, 0, 0, 1, 1, -1, -1];
    const dy = [0, 0, 1, -1, 1, -1, 1, -1];
    const kept = [];
    const orphans = [];

    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const si = sy * w + sx;
        if (!bin[si] || seen[si]) continue;
        const q = [si];
        seen[si] = 1;
        const pixels = [];
        let minX = sx, maxX = sx, minY = sy, maxY = sy;

        for (let qi = 0; qi < q.length; qi++) {
          const ci = q[qi];
          pixels.push(ci);
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
        const bw = maxX - minX + 1, bh = maxY - minY + 1;
        const shortSide = Math.min(bw, bh), longSide = Math.max(bw, bh);
        const aspect = longSide / Math.max(1, shortSide);
        const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5;
        const blob = { pixels, area, minX, maxX, minY, maxY, cx, cy };

        if (area > 9000 || (aspect > 7 && shortSide < 14 && longSide > 35)) continue;
        if (area >= minArea) kept.push(blob);
        else if (area >= 8 && area < minArea) orphans.push(blob);
      }
    }

    for (const blob of kept) for (const pi of blob.pixels) fg[pi] = 1;

    const nearR = 12;
    for (const orph of orphans) {
      let merge = false;
      for (const kb of kept) {
        const dist = Math.hypot(orph.cx - kb.cx, orph.cy - kb.cy);
        if (dist < 42 && _bboxNear(orph, kb, 20)) { merge = true; break; }
      }
      if (merge) {
        for (const pi of orph.pixels) fg[pi] = 1;
        continue;
      }
      for (const pi of orph.pixels) {
        const cy = (pi / w) | 0, cx = pi - cy * w;
        outer:
        for (let dy2 = -nearR; dy2 <= nearR; dy2++) {
          for (let dx2 = -nearR; dx2 <= nearR; dx2++) {
            if (!dx2 && !dy2) continue;
            const nx = cx + dx2, ny = cy + dy2;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (fg[ny * w + nx] > 0.5) {
              for (const pj of orph.pixels) fg[pj] = 1;
              break outer;
            }
          }
        }
      }
    }

    return boxBlurChannel(fg, w, h, 1);
  }

  function _buildPatternMask(gray, sat, w, h) {
    const bg = boxBlurChannel(gray, w, h, 44);
    const raw = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (sat[i] > 0.17) continue;
      if (Math.abs(gray[i] - bg[i]) > 0.016) raw[i] = 1;
    }
    const kept = _filterComponents(raw, w, h, 0.5, "pattern");
    return boxBlurChannel(kept, w, h, 5);
  }

  function _buildGradientMask(gray, w, h) {
    const bg = boxBlurChannel(gray, w, h, 32);
    const raw = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (Math.abs(gray[i] - bg[i]) > 0.022) raw[i] = 1;
    }
    const kept = _filterComponents(raw, w, h, 0.5, "gradient");
    return boxBlurChannel(kept, w, h, 4);
  }


  /** Binarize + CC filter: drop tiny noise, long tile lines, huge blobs. */
  function _filterComponents(score, w, h, thresh, style) {
    const minArea = style === "pattern" ? 120 : style === "gradient" ? 70 : 35;
    const maxArea = style === "pattern" ? 2800 : 9000;
    const conn8 = style !== "pattern";
    const bin = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) bin[i] = score[i] >= thresh ? 1 : 0;

    const fg = new Float32Array(w * h);
    const seen = new Int32Array(w * h);
    let label = 0;
    const dx = conn8 ? [1, -1, 0, 0, 1, 1, -1, -1] : [1, -1, 0, 0];
    const dy = conn8 ? [0, 0, 1, -1, 1, -1, 1, -1] : [0, 0, 1, -1];
    const dirs = dx.length;

    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const si = sy * w + sx;
        if (!bin[si] || seen[si]) continue;
        label++;
        const q = [si];
        seen[si] = label;
        const pixels = [];
        let minX = sx, maxX = sx, minY = sy, maxY = sy;

        for (let qi = 0; qi < q.length; qi++) {
          const ci = q[qi];
          pixels.push(ci);
          const cy = (ci / w) | 0;
          const cx = ci - cy * w;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
          for (let d = 0; d < dirs; d++) {
            const nx = cx + dx[d], ny = cy + dy[d];
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ni = ny * w + nx;
            if (!bin[ni] || seen[ni]) continue;
            seen[ni] = label;
            q.push(ni);
          }
        }

        const area = pixels.length;
        const bw = maxX - minX + 1;
        const bh = maxY - minY + 1;
        const shortSide = Math.min(bw, bh);
        const longSide = Math.max(bw, bh);
        const aspect = longSide / Math.max(1, shortSide);

        const tiny = area < minArea;
        const huge = area > maxArea;
        const smallBlob = style === "pattern" && shortSide < 22;
        const longLine = aspect > 7 && shortSide < 14 && longSide > 35;
        const flatFill = area > 250 && area / (longSide * 2) > 12 && style !== "gradient";

        if (tiny || huge || smallBlob || longLine || flatFill) continue;
        for (const pi of pixels) fg[pi] = 1;
      }
    }
    return boxBlurChannel(fg, w, h, 1);
  }

  function _adaptiveThresh(score, n, style) {
    const vals = [];
    for (let i = 0; i < n; i++) if (score[i] > 0.02) vals.push(score[i]);
    if (!vals.length) return 0.2;
    vals.sort((a, b) => a - b);
    const p85 = vals[Math.floor(vals.length * 0.85)];
    const p50 = vals[Math.floor(vals.length * 0.50)];
    return _clamp(Math.min(p85 * 0.50, p50 * 1.25), 0.04, style === "gradient" ? 0.16 : 0.20);
  }

  function computeFgWeight(imgData, opts = {}) {
    const { data, width, height } = imgData;
    const w = width;
    const h = height;
    const n = w * h;
    const gray = new Float32Array(n);
    const hue = new Float32Array(n);
    const sat = new Float32Array(n);
    const rCh = new Float32Array(n);
    const gCh = new Float32Array(n);
    const bCh = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const r = data[o] / 255;
      const gv = data[o + 1] / 255;
      const b = data[o + 2] / 255;
      rCh[i] = r;
      gCh[i] = gv;
      bCh[i] = b;
      gray[i] = r * 0.299 + gv * 0.587 + b * 0.114;
      const hs = _rgbToHueSat(r, gv, b);
      hue[i] = hs.h;
      sat[i] = hs.s;
    }

    const edge = buildFineEdge(gray, w, h);
    const style = opts.forceStyle
      || (opts.forcePatchwork === true ? "patchwork" : opts.forcePatchwork === false ? "gradient" : null)
      || _detectStyle(hue, sat, edge, gray, w, h);

    const score = new Float32Array(n);

    if (style === "patchwork") {
      const bgR = boxBlurChannel(rCh, w, h, 32);
      const bgG = boxBlurChannel(gCh, w, h, 32);
      const bgB = boxBlurChannel(bCh, w, h, 32);
      const coolRaw = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        coolRaw[i] = (bCh[i] - bgB[i]) - (rCh[i] - bgR[i]);
      }
      const coolEdge = _buildChannelEdge(coolRaw, w, h);
      const tint = new Float32Array(n);
      const coolTint = new Float32Array(n);
      const warmTint = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const warm = (rCh[i] - bgR[i]) - (gCh[i] - bgG[i]);
        const cool = coolRaw[i];
        coolTint[i] = _clamp(cool * 10, 0, 1);
        warmTint[i] = _clamp(warm * 10, 0, 1);
        const purple = ((rCh[i] - bgR[i]) + (bCh[i] - bgB[i])) * 0.5 - (gCh[i] - bgG[i]);
        tint[i] = Math.max(coolTint[i], warmTint[i], _clamp(purple * 12, 0, 1));
      }
      const locR = boxBlurChannel(rCh, w, h, LOCAL_TILE_BLUR_R);
      const locG = boxBlurChannel(gCh, w, h, LOCAL_TILE_BLUR_R);
      const locB = boxBlurChannel(bCh, w, h, LOCAL_TILE_BLUR_R);
      const satRing = boxBlurChannel(sat, w, h, 3);
      const grayRing = boxBlurChannel(gray, w, h, 3);
      const satRes = new Float32Array(n);
      const lumRes = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        satRes[i] = Math.max(0, sat[i] - satRing[i]);
        lumRes[i] = Math.abs(gray[i] - grayRing[i]);
      }
      const edgeSat = _buildSatEdge(sat, w, h);
      const localGate = new Float32Array(n);
      const localCtr = new Float32Array(n);
      const localDist = new Float32Array(n);
      const strokeMatch = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        localGate[i] = _localContrastGate(
          rCh[i], gCh[i], bCh[i], hue, edgeSat, satRes, lumRes, locR, locG, locB, i,
        );
        localCtr[i] = _localStrokeContrastScore(
          rCh[i], gCh[i], bCh[i], hue, edge, edgeSat, satRes, lumRes, locR, locG, locB, i,
        );
        localDist[i] = Math.hypot(rCh[i] - locR[i], gCh[i] - locG[i], bCh[i] - locB[i]);
        strokeMatch[i] = _patchworkStrokeColorMatch(rCh[i], gCh[i], bCh[i]);
        tint[i] = Math.max(
          tint[i],
          _clamp(localDist[i] * 14, 0, 1),
          strokeMatch[i] * 0.80,
        );
      }
      const camo = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        camo[i] = _camouflagePatchworkScore(
          rCh[i], gCh[i], bCh[i], hue, sat, edge, edgeSat, satRes, lumRes, bgR, bgG, bgB, i, w, h,
          localGate[i], localCtr[i],
        );
      }
      return _runPatchworkPipeline(
        score, new Float32Array(n), rCh, gCh, bCh, hue, sat, edge, coolEdge, coolTint, warmTint, tint,
        satRes, lumRes, edgeSat, camo, bgR, bgG, bgB, localGate, localCtr, strokeMatch, localDist,
        locR, locG, locB, w, h, n, opts,
      );
    }

    if (style === "pattern") {
      const mask = _buildPatternMask(gray, sat, w, h);
      for (let i = 0; i < n; i++) score[i] = edge[i] * mask[i] * 20;
    } else {
      const mask = _buildGradientMask(gray, w, h);
      for (let i = 0; i < n; i++) score[i] = edge[i] * mask[i] * 18;
    }

    if (style !== "pattern") {
      const dil = boxBlurChannel(score, w, h, 1);
      for (let i = 0; i < n; i++) score[i] = Math.max(score[i], dil[i] * 0.85);
    }

    const thresh = opts.thresh ?? _adaptiveThresh(score, n, style);
    const fg = _filterComponents(score, w, h, thresh, style);
    fg._style = style;
    return fg;
  }

  function removeBackground(imgData, opts = {}) {
    const fg = computeFgWeight(imgData, opts);
    const { width, height } = imgData;
    const out = new ImageData(width, height);
    const od = out.data;
    for (let i = 0; i < width * height; i++) {
      const o = i * 4;
      const v = fg[i] > 0.5 ? 0 : 255;
      od[o] = v;
      od[o + 1] = v;
      od[o + 2] = v;
      od[o + 3] = 255;
    }
    return { imageData: out, weight: fg, style: fg._style };
  }

  function normalizeStripBlackOnWhite(imgData) {
    const { data, width, height } = imgData;
    const out = new ImageData(width, height);
    const od = out.data;
    for (let i = 0; i < width * height; i++) {
      const o = i * 4;
      const lum = data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114;
      const v = lum < 108 ? 0 : 255;
      od[o] = v;
      od[o + 1] = v;
      od[o + 2] = v;
      od[o + 3] = 255;
    }
    return out;
  }

  function splitComposite(imgData) {
    const { data, width, height } = imgData;
    let stripY = -1;
    for (let y = height - 1; y >= Math.max(0, height - 120); y--) {
      let dark = 0, samples = 0;
      for (let x = 0; x < width; x += 4) {
        const o = (y * width + x) * 4;
        const lum = data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114;
        if (lum < 40) dark++;
        samples++;
      }
      if (samples && dark / samples > 0.75) {
        stripY = y;
        break;
      }
    }
    if (stripY < 0) return { main: imgData, strip: null, stripY: height };

    let top = stripY;
    while (top > 0) {
      let dark = 0, samples = 0;
      for (let x = 0; x < width; x += 4) {
        const o = ((top - 1) * width + x) * 4;
        const lum = data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114;
        if (lum < 40) dark++;
        samples++;
      }
      if (dark / samples > 0.6) top--;
      else break;
    }

    const mainH = Math.max(1, top);
    const stripH = height - mainH;
    const copyRegion = (y0, rh) => {
      const region = new ImageData(width, rh);
      for (let y = 0; y < rh; y++) {
        region.data.set(
          data.subarray(((y0 + y) * width) * 4, ((y0 + y) * width + width) * 4),
          y * width * 4,
        );
      }
      return region;
    };
    return {
      main: copyRegion(0, mainH),
      strip: stripH > 4 ? copyRegion(mainH, stripH) : null,
      stripY: mainH,
    };
  }

  function _pixelLum(data, i) {
    const o = i * 4;
    return data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114;
  }

  /** Bounding box of white reference icons on the black bottom strip. */
  function findStripContentBounds(imgData) {
    const { data, width, height } = imgData;
    let minX = width, maxX = -1, minY = height, maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (_pixelLum(data, i) > 140) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX) return null;
    return { minX, maxX, minY, maxY };
  }

  function detectStripIconCount(stripImgData) {
    const bounds = findStripContentBounds(stripImgData);
    if (!bounds) return 5;
    const contentW = bounds.maxX - bounds.minX + 1;
    const iconPitch = Math.max(stripImgData.height * 0.78, 14);
    const est = Math.round(contentW / iconPitch);
    return _clamp(est, 3, 5);
  }

  /** Horizontal slices for N bottom-strip icons (content-bbox based, not full width). */
  function getStripIconSlices(stripImgData, count) {
    const n = count || detectStripIconCount(stripImgData);
    const bounds = findStripContentBounds(stripImgData);
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

  function _copyImageRegion(imgData, x0, y0, x1, y1) {
    const sw = imgData.width;
    const rw = x1 - x0 + 1;
    const rh = y1 - y0 + 1;
    const out = new ImageData(rw, rh);
    for (let y = 0; y < rh; y++) {
      out.data.set(
        imgData.data.subarray(((y0 + y) * sw + x0) * 4, ((y0 + y) * sw + x1 + 1) * 4),
        y * rw * 4,
      );
    }
    return out;
  }

  /** Normalize strip and split into individual black-on-white icon tiles. */
  function extractStripIcons(stripImgData, count) {
    if (!stripImgData) return { icons: [], count: 0, normalized: null, slices: [] };
    const n = count || detectStripIconCount(stripImgData);
    const normalized = normalizeStripBlackOnWhite(stripImgData);
    const slices = getStripIconSlices(stripImgData, n);
    const icons = slices.map((s) => _copyImageRegion(normalized, s.x0, s.y0, s.x1, s.y1));
    return { icons, count: icons.length, normalized, slices };
  }

  function composeComposite(mainImg, stripImg) {
    if (!stripImg) return mainImg;
    const w = mainImg.width;
    const h = mainImg.height + stripImg.height;
    const out = new ImageData(w, h);
    for (let y = 0; y < mainImg.height; y++) {
      out.data.set(
        mainImg.data.subarray(y * w * 4, (y + 1) * w * 4),
        y * w * 4,
      );
    }
    const sy = mainImg.height;
    for (let y = 0; y < stripImg.height; y++) {
      out.data.set(
        stripImg.data.subarray(y * stripImg.width * 4, (y + 1) * stripImg.width * 4),
        (sy + y) * w * 4,
      );
    }
    return out;
  }

  function removeBackgroundComposite(imgData, opts = {}) {
    const split = splitComposite(imgData);
    const mainResult = removeBackground(split.main, opts);
    const stripPack = split.strip ? extractStripIcons(split.strip) : null;
    const composite = composeComposite(mainResult.imageData, stripPack?.normalized || null);
    return {
      imageData: mainResult.imageData,
      weight: mainResult.weight,
      style: mainResult.style,
      strip: stripPack?.normalized || null,
      stripIcons: stripPack?.icons || [],
      stripIconCount: stripPack?.count || 0,
      composite,
      stripY: split.stripY,
    };
  }

  function imageDataToDataUrl(imgData, type = "image/png", quality = 0.92) {
    const c = document.createElement("canvas");
    c.width = imgData.width;
    c.height = imgData.height;
    c.getContext("2d").putImageData(imgData, 0, 0);
    return c.toDataURL(type, quality);
  }

  window.EPD_BG_REMOVE = {
    version: BG_REMOVE_VERSION,
    PATCHWORK_STROKE_COLORS,
    PATCHWORK_STROKE_CH_TOL,
    LOCAL_TILE_BLUR_R,
    patchworkStrokeColorMatch: _patchworkStrokeColorMatch,
    BG_STD_SMALL_R,
    BG_STD_LARGE_R,
    boxBlurChannel,
    localStdDev,
    computeFgWeight,
    removeBackground,
    removeBackgroundComposite,
    normalizeStripBlackOnWhite,
    findStripContentBounds,
    detectStripIconCount,
    getStripIconSlices,
    extractStripIcons,
    composeComposite,
    splitComposite,
    imageDataToDataUrl,
  };
})();
