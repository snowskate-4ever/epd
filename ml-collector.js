"use strict";

// ML dataset collector for click-captcha (dev/training).
// Loaded before content.js; exposes window.EPD_ML_COLLECT.

(function () {
  const ML_COLLECT_KEY = "ml_dataset";
  const ML_COLLECT_MAX = 2000;
  const ML_COLLECT_ENABLED = true;

  function _uuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  async function _load() {
    try {
      const data = await chrome.storage.local.get(ML_COLLECT_KEY);
      return Array.isArray(data[ML_COLLECT_KEY]) ? data[ML_COLLECT_KEY] : [];
    } catch (_) {
      return [];
    }
  }

  async function _save(records) {
    try {
      await chrome.storage.local.set({ [ML_COLLECT_KEY]: records.slice(-ML_COLLECT_MAX) });
    } catch (e) {
      console.warn("[EPD ML:collect] storage save failed:", e.message);
    }
  }

  /** Save click-captcha sample before validate. Returns record id. */
  async function saveSample(front, meta = {}) {
    if (!ML_COLLECT_ENABLED || !front?.imageBase64 || !front?.iconsBase64) return null;
    const id = _uuid();
    const record = {
      id,
      mainB64: front.imageBase64,
      stripB64: front.iconsBase64,
      iconCount: meta.iconCount ?? null,
      coords: meta.coords ?? null,
      confs: meta.confs ?? null,
      method: meta.method ?? null,
      mlScores: meta.mlScores ?? null,
      valid: null,
      ts: Date.now(),
    };
    const records = await _load();
    records.push(record);
    await _save(records);
    console.log(`[EPD ML:collect] saved ${id} (${records.length} total)`);
    return id;
  }

  /** Save manually labeled sample (valid=true, ground-truth coords). */
  async function saveLabeled(front, coords, meta = {}) {
    if (!ML_COLLECT_ENABLED || !front?.imageBase64 || !front?.iconsBase64 || !coords?.length) return null;
    const id = _uuid();
    const record = {
      id,
      mainB64: front.imageBase64,
      stripB64: front.iconsBase64,
      iconCount: meta.iconCount ?? coords.length,
      coords,
      confs: meta.confs ?? null,
      method: meta.method ?? "manual",
      mlScores: meta.mlScores ?? null,
      valid: true,
      ts: Date.now(),
      labeledTs: Date.now(),
    };
    const records = await _load();
    records.push(record);
    await _save(records);
    console.log(`[EPD ML:collect] labeled ${id} valid=true (${coords.length} pts, ${records.length} total)`);
    return id;
  }

  /** Update validate outcome for a saved sample. */
  async function updateOutcome(id, valid, extra = {}) {
    if (!id) return;
    const records = await _load();
    const idx = records.findIndex((r) => r.id === id);
    if (idx < 0) return;
    records[idx].valid = !!valid;
    if (extra.coords) records[idx].coords = extra.coords;
    if (extra.confs) records[idx].confs = extra.confs;
    if (extra.method) records[idx].method = extra.method;
    records[idx].validatedTs = Date.now();
    await _save(records);
    console.log(`[EPD ML:collect] ${id} valid=${valid}`);
  }

  async function count() {
    return (await _load()).length;
  }

  async function exportDataset() {
    const records = await _load();
    const report = {
      version: 1,
      generated: new Date().toISOString(),
      count: records.length,
      records,
    };
    const json = JSON.stringify(report);
    try {
      const blob = new Blob([json], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `epd_ml_dataset_${Date.now()}.json`;
      a.click();
      console.log(`[EPD ML:collect] exported ${records.length} records`);
    } catch (e) {
      console.warn("[EPD ML:collect] export failed:", e.message);
    }
    return records.length;
  }

  async function clearDataset() {
    try {
      await chrome.storage.local.remove(ML_COLLECT_KEY);
    } catch (e) {
      console.warn("[EPD ML:collect] clear failed:", e.message);
      await _save([]);
    }
    console.log("[EPD ML:collect] cleared");
  }

  async function exportAndClearDataset() {
    const n = await exportDataset();
    await clearDataset();
    return n;
  }

  window.EPD_ML_COLLECT = {
    enabled: ML_COLLECT_ENABLED,
    saveSample,
    saveLabeled,
    updateOutcome,
    exportDataset,
    exportAndClearDataset,
    clearDataset,
    count,
  };
})();
