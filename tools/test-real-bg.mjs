#!/usr/bin/env node
"use strict";
import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";
import { Jimp } from "jimp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(__dirname, "..", "bg-remove.js"), "utf8");
const sandbox = { window: {}, console };
vm.runInNewContext(code, sandbox);
const BGR = sandbox.window.EPD_BG_REMOVE;

const img = await Jimp.read(path.join(__dirname, "..", "captcha", "epd_captcha_collect_0001_1781257194272.jpg"));
const w = img.bitmap.width, h = img.bitmap.height, data = img.bitmap.data;
const split = BGR.splitComposite({ data, width: w, height: h });
const main = split.main;
const result = BGR.removeBackground(main);
const od = result.imageData.data, mh = main.height;

const rois = { pink: [385, 175, 70, 35], cloud: [175, 55, 110, 70], bell: [55, 155, 90, 90] };
for (const [name, r] of Object.entries(rois)) {
  let c = 0, x0 = 999, x1 = 0, y0 = 999, y1 = 0;
  for (let y = r[1]; y < r[1] + r[3]; y++) for (let x = r[0]; x < r[0] + r[2]; x++) {
    if (od[(y * w + x) * 4] < 200) {
      c++;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  console.log(name, c, `${x1 - x0 + 1}x${y1 - y0 + 1}`, "mainH", mh);
}
