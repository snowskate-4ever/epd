"use strict";

// Orion iOS: inject inject.js into MAIN world via script tag
(function() {
  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("inject.js");
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {
    console.error("[EPD] inject.js dynamic injection failed:", e.message);
  }
})();

// ---------------------------------------------------------------------------
//  EPD Helper v2 — мониторинг слотов ЭОПП | Orion iOS build
// ---------------------------------------------------------------------------

const EPD_BUILD = "13.06.2026 (v4.44 — global-pool, step4)";

// MobileNetV2 ONNX (local WASM inference)
const ML_ENABLED = false;        // OFF — тест NCC
const ML_ONLY = false;           // NCC peaks → DFS assign
const ML_GRID = false;         // false = NCC peaks + ML (~4–6с); true = полный ML grid (~14с)
const ML_TRAINING_MODE = true; // всегда отправляем coords для сбора датасета
const ML_W_NCC = 0.7;
const ML_W_ML = 0.3;
const ML_MIN_COSINE = 0.40;    // понижен для фазы обучения
const ML_RACE_CONF = 0.45;

// Логи: накапливаются в памяти, скачиваются по кнопке «Логи»

// Fast-path timing (was 3000/1000 — main bottleneck)
const CLICK_POLL_INITIAL_MS = 600;
const CLICK_POLL_INTERVAL_MS = 350;
const PUZZLE_POLL_INITIAL_MS = 600;
const PUZZLE_POLL_INTERVAL_MS = 400;
// Click-капча: RuCaptcha ~15–20с, не успевает до validate — отключено (puzzle RuCaptcha ниже не трогаем)
const CLICK_USE_RUCAPTCHA = false;
// Click AI (Claude) — отключено, улучшаем NCC
const CLICK_USE_AI = false;
// Instant: min≥42% AND all≥38%. Defer: min≥38% AND avg≥45% AND cluster=ok. Weak: min≥38% AND cluster=ok.
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
const NCC_FAST = true;         // fast NCC: 3 scale, step4, g+hp+s coarse, alpha mask
const NCC_SCALES = [0.88, 0.94, 1.0, 1.06, 1.12];
const NCC_SCALES_FAST = [0.94, 1.0, 1.06];
const NCC_COARSE_STEP = 6;
const NCC_COARSE_STEP_FAST = 8;
const NCC_MID_STEP = 2;
const NCC_FINE_STEP = 1;
const NCC_REFINE_R = 14;
const NCC_PEAKS_PER_ICON = 6;
const NCC_PEAK_STEP_FAST = 4;
const NCC_COARSE_PEAK_MULT = 3;  // coarse k×3 (v4.42 k×5 откат — медленно, pool тот же)
const NCC_FINE_RADIUS = 5;
/** false = каждая иконка ищет top-K независимо; дубли отсекает assign */
const NCC_SEQ_MASK = false;
const NCC_POOL_FACTOR = 5;
const NCC_TOPK_SEARCH = 4;
/** BG-remove: blur-оценка фона + residual/HP/edge/sat — иконки остаются, пастель уходит. */
const BG_REMOVE_ENABLED = true;
/** Hungarian pool matrix: +4–7с, auto validate в логах не улучшил — выкл. */
const ML_HUNGARIAN_ASSIGN = false;

function _nccPeakScanTag() {
  const mode = NCC_SEQ_MASK ? "seq" : "indep";
  return NCC_FAST ? `fast+${mode}` : `full+${mode}`;
}

function _nccActiveScales() {
  return NCC_FAST ? NCC_SCALES_FAST : NCC_SCALES;
}
function _nccCoarseStep() {
  return NCC_FAST ? NCC_COARSE_STEP_FAST : NCC_COARSE_STEP;
}
function _nccPeakStep() {
  return NCC_FAST ? NCC_PEAK_STEP_FAST : NCC_COARSE_STEP;
}

// ---------------------------------------------------------------------------
//  Built-in debug logger — records everything automatically
// ---------------------------------------------------------------------------
const _epdLog = [];
const _epdT0 = Date.now();
function epdTs() { return ((Date.now() - _epdT0) / 1000).toFixed(1); }

const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
const _origWarn = console.warn.bind(console);

console.log = function(...args) {
  const msg = args.map(a => typeof a === "object" ? JSON.stringify(a)?.slice(0, 1000) : String(a)).join(" ");
  if (msg.includes("[EPD")) _epdLog.push({ t: epdTs(), l: "L", m: msg.slice(0, 1500) });
  _origLog.apply(console, args);
};
console.error = function(...args) {
  const msg = args.map(a => typeof a === "object" ? JSON.stringify(a)?.slice(0, 1000) : String(a)).join(" ");
  if (msg.includes("[EPD") || msg.includes("captcha") || msg.includes("Submit")) _epdLog.push({ t: epdTs(), l: "E", m: msg.slice(0, 1500) });
  _origErr.apply(console, args);
};
console.warn = function(...args) {
  const msg = args.map(a => typeof a === "object" ? JSON.stringify(a)?.slice(0, 1000) : String(a)).join(" ");
  _epdLog.push({ t: epdTs(), l: "W", m: msg.slice(0, 1500) });
  _origWarn.apply(console, args);
};

async function _epdBuildLogReport(tag = "") {
  let cacheCount = 0;
  const cachePositions = {};
  try {
    const all = await chrome.storage.local.get(null);
    for (const k of Object.keys(all)) {
      if (k.startsWith("tc_") || k.startsWith("tc2_")) cacheCount++;
    }
  } catch (_) {}

  const analytics = _buildAnalytics();
  return {
    build: EPD_BUILD,
    generated: new Date().toISOString(),
    tag: tag || undefined,
    url: location.href,
    cache: { tiles: cacheCount, positions: cachePositions },
    analytics,
    entries: _epdLog.length,
    logs: _epdLog,
  };
}

/** POST JSON-лог на smrtcrm.ru (через background — без CORS). */
const EPD_LOG_UPLOAD_URL = "https://smrtcrm.ru/api/epd-logs/ingest";

async function _epdGetLogUploadToken() {
  try {
    const { epd_log_api_token: t } = await chrome.storage.local.get("epd_log_api_token");
    return (t || "").trim();
  } catch (_) {
    return "";
  }
}

async function _epdEnsureLogUploadToken() {
  let token = await _epdGetLogUploadToken();
  if (token) return token;
  const entered = prompt(
    "Токен для отправки логов на smrtcrm.ru:\n(сохранится в расширении локально)",
  );
  if (!entered?.trim()) return "";
  token = entered.trim();
  await chrome.storage.local.set({ epd_log_api_token: token });
  return token;
}

async function _epdUploadLogs(tag = "manual", opts = {}) {
  const report = await _epdBuildLogReport(tag);
  if (opts.statusMessage) report.status_message = opts.statusMessage;
  if (opts.testOutcome) {
    report.test_outcome = opts.testOutcome;
    _epdPatchTestOutcomeReport(report, opts.testOutcome);
  }
  const token = opts.promptForToken
    ? await _epdEnsureLogUploadToken()
    : await _epdGetLogUploadToken();
  if (!token) {
    if (!opts.promptForToken) {
      _origLog(`[EPD] Log upload skipped (no token, tag=${tag})`);
      return { ok: false, error: "no_token", skipped: true };
    }
    _origLog("[EPD] Log upload cancelled: no token");
    return { ok: false, error: "no_token" };
  }
  _origLog(`[EPD] Uploading ${report.entries} log entries to smrtcrm.ru (tag=${tag})…`);
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      action: "upload-epd-logs",
      url: EPD_LOG_UPLOAD_URL,
      token,
      report,
    }, (r) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(r || { ok: false, error: "empty_response" });
    });
  });
}

function _epdUploadSuffix(r) {
  if (!r || r.error === "no_token") return "";
  if (r.ok) return ` · 📤 smrtcrm #${r.id || "ok"}`;
  return ` · 📤 ${r.error || r.status || "ошибка"}`;
}

async function _epdUploadLogsAfter(tag, extra = {}) {
  return _epdUploadLogs(tag, { promptForToken: false, ...extra });
}

async function _epdStatusUpload(statusFn, tag, msg) {
  const testOutcome = /✅/.test(msg) && /тест/i.test(msg) ? "ok"
    : /❌/.test(msg) && /тест/i.test(msg) ? "fail" : null;
  const r = await _epdUploadLogsAfter(tag, { statusMessage: msg, testOutcome });
  statusFn(msg + _epdUploadSuffix(r));
  return r;
}

/** Скачать JSON-лог в Downloads (после теста, разметки или по кнопке). */
async function _epdDownloadLogs(tag = "manual") {
  const report = await _epdBuildLogReport(tag);
  const json = JSON.stringify(report, null, 2);
  try {
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `epd_logs_${tag}_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    _origLog(`[EPD] Logs downloaded: ${report.entries} entries (tag=${tag})`);
    _origLog("[EPD] Analytics:", JSON.stringify(report.analytics, null, 2));
  } catch (_) {
    _origLog(json);
  }
}

function _epdDrawClickPoints(ctx, coords, imgW, tone = "solver") {
  if (!coords?.length) return;
  const r = Math.max(8, Math.round(imgW / 60));
  const font = Math.max(10, Math.round(imgW / 40));
  const fill = tone === "ok" ? "rgba(46, 125, 50, 0.85)"
    : tone === "fail" ? "rgba(198, 40, 40, 0.85)"
      : "rgba(33, 150, 243, 0.85)";
  for (let i = 0; i < coords.length; i++) {
    const p = coords[i];
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = Math.max(2, Math.round(r / 5));
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${font}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(i + 1), x, y);
  }
}

/** Скачать click-капчу (поле + strip) с проставленными точками. */
async function _epdDownloadCaptchaImage(front, coords, tag = "test", meta = {}) {
  if (!front?.imageBase64 || !coords?.length) return false;
  const mainImg = await _decodeImg(front.imageBase64);
  const stripImg = front.iconsBase64 ? await _decodeImg(front.iconsBase64) : null;
  if (!mainImg) return false;

  const mW = mainImg.width;
  const mH = mainImg.height;
  const gap = stripImg ? 6 : 0;
  const sH = stripImg?.height || 0;
  const canvas = document.createElement("canvas");
  canvas.width = mW;
  canvas.height = mH + gap + sH;
  const ctx = canvas.getContext("2d");

  const mCanvas = document.createElement("canvas");
  mCanvas.width = mW;
  mCanvas.height = mH;
  mCanvas.getContext("2d").putImageData(mainImg, 0, 0);
  ctx.drawImage(mCanvas, 0, 0);

  const tone = meta.valid === true ? "ok" : meta.valid === false ? "fail" : "solver";
  _epdDrawClickPoints(ctx, coords, mW, tone);

  if (stripImg) {
    const sCanvas = document.createElement("canvas");
    sCanvas.width = stripImg.width;
    sCanvas.height = stripImg.height;
    sCanvas.getContext("2d").putImageData(stripImg, 0, 0);
    ctx.drawImage(sCanvas, 0, mH + gap);
  }

  const suffix = meta.valid === true ? "ok" : meta.valid === false ? "fail" : "solver";
  const fname = `epd_captcha_${tag}_${suffix}_${Date.now()}.jpg`;
  try {
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/jpeg", 0.92);
    a.download = fname;
    a.click();
    _origLog(`[EPD] Captcha saved: ${fname} (${coords.length} pts, ${meta.method || "?"})`);
    return true;
  } catch (e) {
    _origLog(`[EPD] Captcha save failed: ${e.message}`);
    return false;
  }
}

/** Скачать сырую click-капчу (поле + strip) без точек. */
async function _epdDownloadRawCaptchaImage(front, tag = "collect", seq = 0) {
  if (!front?.imageBase64) return false;
  const mainImg = await _decodeImg(front.imageBase64);
  const stripImg = front.iconsBase64 ? await _decodeImg(front.iconsBase64) : null;
  if (!mainImg) return false;

  const mW = mainImg.width;
  const mH = mainImg.height;
  const gap = stripImg ? 6 : 0;
  const sH = stripImg?.height || 0;
  const canvas = document.createElement("canvas");
  canvas.width = mW;
  canvas.height = mH + gap + sH;
  const ctx = canvas.getContext("2d");

  const mCanvas = document.createElement("canvas");
  mCanvas.width = mW;
  mCanvas.height = mH;
  mCanvas.getContext("2d").putImageData(mainImg, 0, 0);
  ctx.drawImage(mCanvas, 0, 0);

  if (stripImg) {
    const sCanvas = document.createElement("canvas");
    sCanvas.width = stripImg.width;
    sCanvas.height = stripImg.height;
    sCanvas.getContext("2d").putImageData(stripImg, 0, 0);
    ctx.drawImage(sCanvas, 0, mH + gap);
  }

  const fname = `epd_captcha_${tag}_${String(seq).padStart(4, "0")}_${Date.now()}.jpg`;
  try {
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/jpeg", 0.92);
    a.download = fname;
    a.click();
    _origLog(`[EPD] Raw captcha saved: ${fname}`);
    return true;
  } catch (e) {
    _origLog(`[EPD] Raw captcha save failed: ${e.message}`);
    return false;
  }
}

function _buildAnalytics() {
  const logs = _epdLog;
  const a = {
    summary: "",
    recommendations: [],
    stats: {},
    timeline: [],
  };

  // Count events
  let slotsChecks = 0, slotsFound = 0, slotsEmpty = 0;
  let captchaRequests = 0, captchaSuccess = 0, captchaFail = 0;
  let wafBlocks = 0, wafCooldowns = 0;
  let aiCalls = 0, aiSuccess = 0, aiFail = 0;
  let validateOK = 0, validateFail = 0, validate500 = 0;
  let testValidateOk = 0, testValidateFail = 0, testRuns = 0;
  let testActive = false;
  let testOutcomeRecorded = false;
  let tokenExpired = 0;
  let totalAiMs = 0, totalAiCost = 0;
  const aiModels = {};
  const captchaTypes = {};
  const errors = [];
  let firstSlotTime = null, lastActionTime = null;

  for (const log of logs) {
    const m = log.m || "";
    lastActionTime = parseFloat(log.t) || 0;

    if (m.includes("AvailableSlots <-")) {
      slotsChecks++;
      if (m.includes("400") || m.includes("null")) slotsEmpty++;
      else slotsFound++;
    }
    if (m.includes("Trying slot")) {
      if (!firstSlotTime) firstSlotTime = lastActionTime;
    }
    if (m.includes("fetchCaptcha RESPONSE status: 200")) {
      captchaRequests++;
      if (/hasImage:\s*true/i.test(m)) {
        captchaTypes.click = (captchaTypes.click || 0) + 1;
      } else if (/type:\s*2|tiles:\s*9/i.test(m)) {
        captchaTypes.puzzle = (captchaTypes.puzzle || 0) + 1;
      }
    }
    if (m.includes("NEW CAPTCHA TYPE")) {
      captchaTypes.click = (captchaTypes.click || 0) + 1;
    }
    if (/(\[EPD TEST\]|\[EPD PREVIEW\]) type:\s*(puzzle|click)/.test(m)) {
      const tm = m.match(/type:\s*(puzzle|click)/);
      if (tm) captchaTypes[tm[1]] = (captchaTypes[tm[1]] || 0) + 1;
    }
    if (m.includes("CLICK:AI]") && (m.includes("за") || /CLICK:AI\] [\w.-]+:/.test(m))) {
      if (!m.includes("composite") && !m.includes("parallel") && !m.includes("picked")) {
        aiCalls++;
        const msMatch = m.match(/за (\d+)мс/);
        const costMatch = m.match(/\(([0-9.]+)₽\)/);
        if (msMatch) totalAiMs += parseInt(msMatch[1]);
        if (costMatch) totalAiCost += parseFloat(costMatch[1]);
        const modelMatch = m.match(/CLICK:AI\] (\S+)/);
        if (modelMatch) {
          const mn = modelMatch[1];
          aiModels[mn] = (aiModels[mn] || 0) + 1;
        }
        if (m.includes("координат найдено") || m.includes("pts, score=")) aiSuccess++;
        else aiFail++;
      }
    }
    if (m.includes("[EPD TEST] slot:") || m.includes("[EPD TEST ML] slot:")) {
      testRuns++;
      testActive = true;
    }
    if (m.includes("[EPD TEST] validate: ✅") || m.includes("[EPD TEST ML] validate: ✅")) {
      if (!testOutcomeRecorded) { testValidateOk++; testOutcomeRecorded = true; }
      testActive = false;
    }
    if (m.includes("[EPD TEST] validate: ❌ TOP-5 failed")
      || m.includes("[EPD TEST] validate: token expired")
      || m.includes("[EPD TEST ML] validate: ❌")
      || m.includes("[EPD TEST ML] validate: token expired")) {
      if (!testOutcomeRecorded) { testValidateFail++; testOutcomeRecorded = true; }
      testActive = false;
    }
    // validateCaptcha() пишет [EPD] ✅ validate до строки [EPD TEST] validate (если upload раньше log)
    if (testActive && !testOutcomeRecorded
      && m.includes("[EPD] ✅ validate:") && m.includes("isValid=true")) {
      testValidateOk++;
      testOutcomeRecorded = true;
      testActive = false;
    }
    if (m.includes("validate: HTTP 200") || m.includes("isValid=true")) validateOK++;
    if (m.includes("validate: HTTP 400")) validateFail++;
    if (m.includes("validate: HTTP 500")) validate500++;
    if (m.includes("Ответ капчи не верный")) captchaFail++;
    if (m.includes("CAPTCHA PASSED") || m.includes("РЕШЕНА")) captchaSuccess++;
    if (m.includes("TOKEN EXPIRED") || m.includes("Токен сгорел") || m.includes("время жизни токена")) tokenExpired++;
    if (m.includes("WAF") && (m.includes("429") || m.includes("403"))) wafBlocks++;
    if (m.includes("Cooldown")) wafCooldowns++;
    if (m.includes("sorry") || m.includes("Load failed") || m.includes("Error:")) {
      errors.push({ t: log.t, msg: m.slice(0, 150) });
    }
  }

  // Build stats
  a.stats = {
    runtime_sec: Math.round(lastActionTime),
    slots_checks: slotsChecks,
    slots_found: slotsFound,
    slots_empty: slotsEmpty,
    captcha_requests: captchaRequests,
    captcha_success: captchaSuccess,
    captcha_fail: captchaFail,
    captcha_types: captchaTypes,
    ai_calls: aiCalls,
    ai_success: aiSuccess,
    ai_fail: aiFail,
    ai_avg_ms: aiCalls > 0 ? Math.round(totalAiMs / aiCalls) : 0,
    ai_total_cost_rub: Math.round(totalAiCost * 100) / 100,
    ai_models_used: aiModels,
    validate_ok: validateOK,
    validate_fail: validateFail,
    validate_500: validate500,
    token_expired: tokenExpired,
    waf_blocks: wafBlocks,
    waf_cooldowns: wafCooldowns,
    errors_count: errors.length,
    errors: errors.slice(0, 10),
    test_runs: testRuns,
    test_validate_ok: testValidateOk,
    test_validate_fail: testValidateFail,
  };

  // Build summary
  const parts = [];
  parts.push(`Работал ${Math.round(lastActionTime)}с.`);
  parts.push(`Проверок слотов: ${slotsChecks} (найдено: ${slotsFound}, пусто: ${slotsEmpty}).`);
  if (captchaRequests > 0) {
    const p = captchaTypes.puzzle || 0;
    const c = captchaTypes.click || 0;
    if (p > 0 && c === 0) parts.push(`Тип капчи: puzzle (${p}×).`);
    else if (c > 0 && p === 0) parts.push(`Тип капчи: click (${c}×).`);
    else if (p > 0 && c > 0) parts.push(`Тип капчи: puzzle ${p}× + click ${c}×.`);
    parts.push(`Капч запрошено: ${captchaRequests}, решено: ${captchaSuccess}, провалено: ${captchaFail}.`);
  }
  if (aiCalls > 0) parts.push(`AI вызовов: ${aiCalls} (успех: ${aiSuccess}), среднее время: ${a.stats.ai_avg_ms}мс, потрачено: ${totalAiCost.toFixed(2)}₽.`);
  if (validate500 > 0) parts.push(`⚠️ HTTP 500 ошибок: ${validate500} (сервер не принял формат ответа).`);
  if (tokenExpired > 0) parts.push(`⚠️ Токенов сгорело: ${tokenExpired}.`);
  if (wafBlocks > 0) parts.push(`🛡 WAF блокировок: ${wafBlocks}, cooldowns: ${wafCooldowns}.`);
  a.summary = parts.join(" ");

  // Build recommendations (type-aware: puzzle vs click)
  const puzzleN = captchaTypes.puzzle || 0;
  const clickN = captchaTypes.click || 0;
  let captchaKind = "unknown";
  if (puzzleN > 0 && clickN === 0) captchaKind = "puzzle";
  else if (clickN > 0 && puzzleN === 0) captchaKind = "click";
  else if (puzzleN > 0 && clickN > 0) captchaKind = "mixed";
  else if (logs.some(l => /EdgeMatch only|type:\s*puzzle|tiles:\s*9/i.test(l.m || ""))) captchaKind = "puzzle";
  else if (logs.some(l => /NEW CAPTCHA TYPE|type:\s*click|hasImage:\s*true/i.test(l.m || ""))) captchaKind = "click";

  a.stats.captcha_kind = captchaKind;

  if (slotsFound === 0 && slotsChecks > 10) {
    a.recommendations.push("📊 Слоты не появлялись. Попробуйте другую дату или оставьте плагин на ночь.");
  }

  if (captchaFail > 0 && captchaSuccess === 0 && slotsChecks > 0) {
    if (captchaKind === "click") {
      a.recommendations.push("❌ Click-капча не решена. Возможные причины:");
      a.recommendations.push("  → NCC/ML неточно находит координаты иконок");
      a.recommendations.push("  → Иконки на поле слишком мелкие или полупрозрачные");
      a.recommendations.push("  → Попробуйте RuCaptcha CoordinatesTask (human workers)");
    } else if (captchaKind === "puzzle" || captchaKind === "mixed") {
      a.recommendations.push("❌ Puzzle-капча не решена в боевом режиме. В «Старт»: EdgeMatch TOP-5 → AI → RuCaptcha.");
      a.recommendations.push("  → Низкий conf EdgeMatch (<85%) — нужен AI или RuCaptcha");
      a.recommendations.push("  → Неверный вариант может сжечь token — не перебирайте вслепую");
    }
  }

  if (validate500 > 0) {
    if (captchaKind === "click") {
      a.recommendations.push("⚠️ HTTP 500 — возможно, неверный формат координат (дробные x/y?)");
    } else {
      a.recommendations.push("⚠️ HTTP 500 — возможно, неверный формат ответа puzzle (массив UUID тайлов)");
    }
  }

  if (tokenExpired > 0) {
    if (captchaKind === "click") {
      a.recommendations.push("⚠️ Click: token одноразовый — после ошибки нужна новая капча.");
    } else if (captchaKind === "puzzle") {
      a.recommendations.push("⚠️ Puzzle: неверный ответ может сжечь token. В тесте — 1 ошибка обрывает TOP-5; в «Старт» — каскад EM → AI → RuCaptcha.");
    } else {
      a.recommendations.push("⚠️ Токены сгорают — не тратьте попытки; puzzle: TOP-5 на token, click: один validate.");
    }
  }

  if (wafBlocks > 2) {
    a.recommendations.push("🛡 Частые WAF блокировки. Увеличьте интервал polling или переключите на stealth/safe.");
  }
  if (aiCalls > 0 && a.stats.ai_avg_ms > 5000) {
    a.recommendations.push("🐌 AI отвечает медленно (>" + a.stats.ai_avg_ms + "мс). Проверьте баланс AITUNNEL.");
  }
  if (errors.length > 0) {
    a.recommendations.push("🔧 Ошибки в логах (" + errors.length + "). Проверьте: " + errors[0].msg.slice(0, 80));
  }
  if (captchaSuccess > 0) {
    a.recommendations.push("✅ Капча решалась успешно в боевом режиме!");
  }

  if (testRuns > 0 && slotsChecks === 0) {
    if (testValidateOk > 0 && testValidateFail > 0) {
      if (captchaKind === "click") {
        a.recommendations.push(`ℹ️ Click-тест: ${testValidateOk} OK, ${testValidateFail} fail — частичный успех NCC/ML.`);
      } else {
        a.recommendations.push(`ℹ️ Puzzle-тест: ${testValidateOk} OK, ${testValidateFail} fail — EdgeMatch без AI (~${Math.round(testValidateOk / testRuns * 100)}% в этой сессии).`);
      }
    } else if (testValidateOk > 0) {
      if (captchaKind === "click") {
        a.recommendations.push("✅ Click-тест: координаты приняты сервером (перезапись не выполнялась).");
      } else {
        a.recommendations.push("✅ Puzzle-тест: вариант EdgeMatch принят сервером (перезапись не выполнялась).");
      }
    } else if (testValidateFail > 0) {
      if (captchaKind === "click") {
        a.recommendations.push("❌ Click-тест: координаты отклонены — проверьте NCC/ML или разметку.");
      } else {
        a.recommendations.push("❌ Puzzle-тест: EdgeMatch TOP-5 не прошёл validate — в «Старт» подключится AI/RuCaptcha.");
      }
    } else {
      a.recommendations.push("ℹ️ Тест solvers без validate — обновите расширение или проверьте puzzle-тест с validate.");
    }
  }

  if (a.recommendations.length === 0) {
    if (testRuns > 0 && slotsChecks === 0) {
      a.recommendations.push("ℹ️ Тест капчи выполнен. Для захвата слота нажмите Старт.");
    } else {
      a.recommendations.push("✅ Плагин работает нормально, ожидает слоты.");
    }
  }

  return a;
}

/** Синхронизировать analytics с явным исходом теста (status UI vs stats). */
function _epdPatchTestOutcomeReport(report, testOutcome) {
  if (!testOutcome || !report?.analytics?.stats) return;
  const s = report.analytics.stats;
  const a = report.analytics;
  const kind = s.captcha_kind || "puzzle";
  if (testOutcome === "ok") {
    s.test_validate_ok = Math.max(s.test_validate_ok || 0, 1);
    if (s.test_validate_fail > 0 && s.test_validate_ok > 0) s.test_validate_fail = 0;
    const okRec = kind === "click"
      ? "✅ Click-тест: координаты приняты сервером (перезапись не выполнялась)."
      : "✅ Puzzle-тест: вариант EdgeMatch принят сервером (перезапись не выполнялась).";
    a.recommendations = (a.recommendations || []).filter(
      (r) => !/Тест solvers без validate|тест.*не прошёл|отклонены/i.test(r),
    );
    if (!a.recommendations.some((r) => /Puzzle-тест:.*принят|Click-тест:.*принят/i.test(r))) {
      a.recommendations.unshift(okRec);
    }
  } else if (testOutcome === "fail") {
    s.test_validate_fail = Math.max(s.test_validate_fail || 0, 1);
    const failRec = kind === "click"
      ? "❌ Click-тест: координаты отклонены — проверьте NCC/ML или разметку."
      : "❌ Puzzle-тест: EdgeMatch TOP-5 не прошёл validate — в «Старт» подключится AI/RuCaptcha.";
    a.recommendations = (a.recommendations || []).filter(
      (r) => !/Тест solvers без validate/i.test(r),
    );
    if (!a.recommendations.some((r) => /тест.*отклонен|не прошёл validate/i.test(r))) {
      a.recommendations.unshift(failRec);
    }
  }
}

const RESCHEDULE_RE =
  /^\/(en|ru)\/reservations\/reservation\/([0-9a-f-]{36})\/(reschedule|edit)$/i;
const RESERVATION_PAGE_RE =
  /^\/(en|ru)\/reservations\/reservation\/([0-9a-f-]{36})/i;

const SPEED_PRESETS = {
  // "Рандом 3-8с": оптимальный баланс — ~8 запросов за 40с, cooldown 25-50с, 0 WAF-блоков.
  random:  { min: 3_000,   max: 8_000,   pause: 0.02, pauseMin: 8_000,   pauseMax: 15_000,  backoff: 25_000,  backoffMax: 50_000  },
  ultra:   { min: 3_000,   max: 7_000,   pause: 0.01, pauseMin: 10_000,  pauseMax: 20_000,  backoff: 15_000,  backoffMax: 45_000  },
  fast:    { min: 15_000,  max: 30_000,  pause: 0.05, pauseMin: 60_000,  pauseMax: 120_000, backoff: 60_000,  backoffMax: 180_000 },
  normal:  { min: 45_000,  max: 90_000,  pause: 0.15, pauseMin: 120_000, pauseMax: 300_000, backoff: 120_000, backoffMax: 300_000 },
  safe:    { min: 90_000,  max: 180_000, pause: 0.20, pauseMin: 180_000, pauseMax: 420_000, backoff: 300_000, backoffMax: 600_000 },
  stealth: { min: 180_000, max: 420_000, pause: 0.30, pauseMin: 300_000, pauseMax: 600_000, backoff: 600_000, backoffMax: 1200_000 },
};
// Для ultra используем меньший множитель, чтобы не уходить в длинные паузы
const BACKOFF_MUL = 1.5;

function getSpeed() {
  const el = document.getElementById("epd2-speed");
  const value = el ? el.value : "normal";

  if (value === "custom") {
    const minEl = document.getElementById("epd2-custom-min");
    const maxEl = document.getElementById("epd2-custom-max");
    const minSec = Math.max(1, parseInt(minEl?.value) || 30);
    const maxSec = Math.max(minSec, parseInt(maxEl?.value) || 60);
    return {
      min: minSec * 1000,
      max: maxSec * 1000,
      pause: 0.10,
      pauseMin: Math.max(60_000, minSec * 1000 * 2),
      pauseMax: Math.max(120_000, maxSec * 1000 * 3),
      backoff: 300_000,
      backoffMax: 600_000,
    };
  }

  return SPEED_PRESETS[value] || SPEED_PRESETS.normal;
}

// ---------------------------------------------------------------------------
//  Утилиты
// ---------------------------------------------------------------------------

function rand(min, max) { return Math.random() * (max - min) + min; }
function hhmm2min(s) { const [h, m] = s.split(":").map(Number); return h * 60 + (m || 0); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function _sleepAbortable(ms, isAborted) {
  const step = 250;
  let left = ms;
  while (left > 0) {
    if (isAborted()) return false;
    await sleep(Math.min(step, left));
    left -= step;
  }
  return !isAborted();
}

function toISOSlot(dateStr, timeStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm, ss] = timeStr.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm, ss || 0)).toISOString();
}

function formatDot(dateStr) {
  const [y, m, d] = dateStr.split("-");
  return `${d}.${m}.${y}`;
}

// ---------------------------------------------------------------------------
//  API helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
//  WAF bypass helpers
// ---------------------------------------------------------------------------

const ACCEPT_LANGS = [
  "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
  "ru-RU,ru;q=0.95,en;q=0.5",
  "ru,en-US;q=0.9,en;q=0.8",
  "ru-RU,ru;q=1.0",
  "ru;q=0.9,en;q=0.8,en-GB;q=0.7",
];

function randHex(n) {
  let s = "";
  while (s.length < n) s += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
  return s.slice(0, n);
}

function ri(a, b) { return Math.floor(rand(a, b + 1)); }

// Generates a random public IPv4 (excluding RFC-1918 / loopback / multicast)
// used for X-Forwarded-For rotation. Some WAFs key rate-limit buckets on
// this header if they trust it — rotating the value creates a new bucket
// for each request.
function randomPublicIP() {
  let a, b, c, d;
  do {
    a = ri(1, 223); b = ri(0, 255); c = ri(0, 255); d = ri(1, 254);
  } while (
    a === 10 || a === 127 || a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
  return `${a}.${b}.${c}.${d}`;
}

// Headers matching Angular HttpClient exactly
function browserHeaders(extra = {}) {
  return {
    "FacilityMode": "false",
    "User-Local-Time": new Date().toISOString(),
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
    ...extra,
  };
}

// Appends cache-busting query params so every request URL is unique —
// breaks WAF rate-limit rules keyed on exact URL and CDN cache aggregation.
function bustUrl(url) {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}_t=${Date.now()}&_r=${randHex(6)}`;
}

// Adaptive jitter: ultra-mode 20-80 ms, other modes 80-350 ms.
// Uses log-normal distribution (human-like) instead of uniform random.
function _boxMuller() {
  const u1 = Math.random(), u2 = Math.random();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

function preJitter() {
  const el = document.getElementById("epd2-speed");
  const v = el ? el.value : "normal";
  const [mean, std] = (v === "ultra" || v === "random") ? [50, 20] : [200, 80];
  const delay = Math.max(10, Math.round(mean + _boxMuller() * std));
  return sleep(delay);
}

// Token bucket: prevents WAF 429 by self-limiting requests
const _tokenBucket = { tokens: 5, max: 5, refillMs: 12000, lastRefill: Date.now() };

function _refillBucket() {
  const now = Date.now();
  const elapsed = now - _tokenBucket.lastRefill;
  const add = (elapsed / _tokenBucket.refillMs) * _tokenBucket.max;
  _tokenBucket.tokens = Math.min(_tokenBucket.max, _tokenBucket.tokens + add);
  _tokenBucket.lastRefill = now;
}

async function _acquireToken() {
  _refillBucket();
  if (_tokenBucket.tokens >= 1) {
    _tokenBucket.tokens -= 1;
    return;
  }
  const waitMs = ((1 - _tokenBucket.tokens) / _tokenBucket.max) * _tokenBucket.refillMs;
  console.log(`[EPD] Token bucket: waiting ${(waitMs / 1000).toFixed(1)}s...`);
  await sleep(waitMs + rand(200, 800));
  _tokenBucket.tokens = 0;
}

// ---------------------------------------------------------------------------
//  MAIN-world API bridge — routes requests through inject.js (page context)
//  This gives us Sec-Fetch-Site: same-origin — invisible to WAF.
// ---------------------------------------------------------------------------

let _apiReqId = 0;
const _apiPending = new Map();

window.addEventListener("message", (ev) => {
  if (!ev.data || ev.data.source !== "__epd_api_response") return;
  const cb = _apiPending.get(ev.data.id);
  if (cb) {
    _apiPending.delete(ev.data.id);
    cb(ev.data);
  }
});

function _apiViaMain(method, url, body, headers) {
  return new Promise((resolve) => {
    const id = ++_apiReqId;
    const timeout = setTimeout(() => {
      _apiPending.delete(id);
      resolve({ status: 0, data: null, retryAfterMs: 0 });
    }, 30_000);

    _apiPending.set(id, (resp) => {
      clearTimeout(timeout);
      resolve(resp);
    });

    window.postMessage({
      source: "__epd_api_request",
      id,
      method,
      url,
      body,
      headers,
    }, "*");
  });
}

// Use XMLHttpRequest like Angular HttpClient — WAF may block fetch differently
async function apiGetJSON(url) {
  await _acquireToken();
  await preJitter();
  const headers = {
    "FacilityMode": "false",
    "User-Local-Time": new Date().toISOString(),
    "Accept": "application/json, text/plain, */*",
  };
  const resp = await _apiViaMain("GET", url, null, headers);
  if (resp.status >= 400) {
    console.log(`[EPD API] ${resp.status} response details:`,
      "\n  data:", JSON.stringify(resp.data)?.slice(0, 500),
      "\n  rawText:", resp.rawText?.slice(0, 500),
      "\n  headers:", JSON.stringify(resp.respHeaders));
  }
  return {
    status: resp.status,
    data: resp.status >= 200 && resp.status < 300 ? resp.data : null,
    errorBody: resp.status >= 300 ? (resp.data || resp.rawText) : null,
    retryAfterMs: resp.retryAfterMs || 0,
  };
}

async function apiPostJSON(url, body) {
  await _acquireToken();
  await preJitter();
  const headers = {
    "FacilityMode": "false",
    "User-Local-Time": new Date().toISOString(),
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
  };
  const resp = await _apiViaMain("POST", url, body, headers);
  return {
    status: resp.status,
    data: resp.status >= 200 && resp.status < 300 ? resp.data : null,
    errorBody: resp.status >= 200 && resp.status < 300 ? null : resp.data,
  };
}

// ---------------------------------------------------------------------------
//  inject.js now runs via manifest "world": "MAIN" at document_start.
//  No manual injection needed — it's already loaded before content.js.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
//  Global WAF request counter — counts ALL AvailableSlots requests
//  (both Angular's own and plugin's) to enforce cooldown before WAF triggers.
// ---------------------------------------------------------------------------
const WAF_LIMIT = 16;           // ~8 real requests per burst (counter += 2 per request)
const WAF_COOLDOWN_MIN = 25_000;
const WAF_COOLDOWN_MAX = 50_000;
const WAF_WINDOW_MS    = 180_000; // WAF sliding window ~90s, we use 180s to be safe
let _wafReqCount = 0;
let _wafWindowStart = Date.now();
let _wafCoolingDown = false;

function _wafCountRequest() {
  const now = Date.now();
  if (now - _wafWindowStart > WAF_WINDOW_MS) {
    _wafReqCount = 0;
    _wafWindowStart = now;
  }
  _wafReqCount++;
  if (_wafReqCount % 5 === 0) {
    console.log(`[EPD WAF] Counter: ${_wafReqCount}/${WAF_LIMIT} in window`);
  }
}

function _wafForceReset() {
  _wafReqCount = 0;
  _wafWindowStart = Date.now();
  console.log("[EPD WAF] 🔄 Counter force-reset (429/403/406 received)");
}

async function _wafGate() {
  if (_wafCoolingDown) {
    while (_wafCoolingDown) await sleep(500);
    return;
  }
  const now = Date.now();
  if (now - _wafWindowStart > WAF_WINDOW_MS) {
    _wafReqCount = 0;
    _wafWindowStart = now;
  }
  if (_wafReqCount >= WAF_LIMIT) {
    _wafCoolingDown = true;
    const cooldown = Math.round(rand(WAF_COOLDOWN_MIN, WAF_COOLDOWN_MAX));
    console.log(`[EPD WAF] ⏸ Cooldown ${cooldown / 1000}s after ${_wafReqCount} requests`);
    await sleep(cooldown);
    _wafReqCount = 0;
    _wafWindowStart = Date.now();
    _wafCoolingDown = false;
    console.log("[EPD WAF] ▶ Counter reset, resuming");
  }
}

// Stores the most recently intercepted AvailableSlots response from the page.
let _interceptedSlots = null;

// ---------------------------------------------------------------------------
//  Creation-mode context
//  Populated progressively by messages from inject.js.
//  When both reservationId + facilityId are ready → show creation UI.
// ---------------------------------------------------------------------------
const _createCtx = {
  reservationId: null,
  facilityId:    null,
  vehicleId:     null,
  transportType: 1,
  availDates:    [],
};

window.addEventListener("message", (e) => {
  if (e.source !== window) return;
  const d = e.data;
  if (!d) return;

  // Free slot data from page's own Angular requests
  if (d.__epd_slots) {
    _interceptedSlots = { status: d.status, data: d.data, ts: d.ts };
    _wafCountRequest();
    console.log("[EPD] ♻️ Intercepted slots, status:", d.status, `(WAF: ${_wafReqCount}/${WAF_LIMIT})`);
    if (d.status >= 400 && d.status !== 400) {
      console.log(`[EPD] ⚠️ Angular got ${d.status}:`, d.data || d.rawText?.slice(0, 500) || "(empty)");
    }
  }

  // Step 1 of creation: draft was created → we have reservationId
  if (d.__epd_draft_created) {
    _createCtx.reservationId = d.reservationId;
    console.log("[EPD] 📝 Draft created, reservationId:", d.reservationId);
    _tryInjectCreate();
  }

  // Step 4 of creation: checkpoint selected → we have facilityId/vehicleId/transportType
  if (d.__epd_create_params) {
    _createCtx.facilityId    = d.facilityId;
    _createCtx.vehicleId     = d.vehicleId;
    _createCtx.transportType = d.transportType || 1;
    _createCtx.availDates    = d.dates || [];
    console.log("[EPD] 🏢 Create params:", d.facilityId, d.vehicleId, d.transportType);
    _tryInjectCreate();
  }
});

// ---------------------------------------------------------------------------
//  Manual captcha solution capture — learns from YOUR manual solutions!
//  When you solve captcha manually on the site, inject.js intercepts it
//  and sends the data here for caching.
// ---------------------------------------------------------------------------

let _lastCaptchaTiles = null; // tiles from the most recent captcha request

window.addEventListener("message", (e) => {
  if (e.source !== window) return;
  const d = e.data;

  // Save puzzle tile data when captcha is requested
  if (d?.__epd_captcha_data) {
    _lastCaptchaTiles = d.tiles; // [{tileId, fp}]
    console.log(`[EPD Cache] Captured ${d.tiles.length} tiles from captcha request`);
  }

  // When YOU solve captcha manually → save correct tile positions to cache
  if (d?.__epd_captcha_solved && d.answer && _lastCaptchaTiles) {
    const tiles = _lastCaptchaTiles;
    const answer = d.answer; // correct order of tileIds
    let saved = 0;
    const updates = {};

    for (let pos = 0; pos < answer.length; pos++) {
      const tileId = answer[pos];
      const tile = tiles.find(t => t.tileId === tileId);
      if (tile?.fp) {
        const key = `tc_${tile.fp}`;
        _tileCacheMemory[tile.fp] = pos;
        updates[key] = pos;
        saved++;
      }
    }

    if (saved > 0) {
      try { chrome.storage.local.set(updates); } catch (_) {}
      const totalCached = Object.keys(_tileCacheMemory).length;
      console.log(`[EPD Cache] ✅ MANUAL SOLVE: saved ${saved}/9 tile positions! Total in memory: ${totalCached}`);
      console.log(`[EPD Cache] Positions: ${answer.map((id, i) => `pos${i}=${id.slice(0,8)}`).join(', ')}`);
    } else {
      console.log("[EPD Cache] ⚠️ No tiles matched between captcha data and answer");
    }
  }
});

// ---------------------------------------------------------------------------
//  SignalR listener — detect slot events in real-time (0ms vs 3-7s polling)
// ---------------------------------------------------------------------------
let _signalrSlotEvent = null;
let _signalrAllEvents = []; // log ALL events for analysis

window.addEventListener("message", (e) => {
  if (e.source !== window || !e.data?.__epd_signalr) return;
  const { target, arguments: args } = e.data;

  // Log ALL events with timestamps for pattern analysis
  _signalrAllEvents.push({ target, args, ts: Date.now() });
  if (_signalrAllEvents.length > 100) _signalrAllEvents.shift();

  console.log(`[EPD SignalR] Event: ${target}`, args);

  // Detect slot-related events — TRIGGER IMMEDIATE POLL
  const t = (target || "").toLowerCase();
  if (t.includes("slot") || t.includes("timeslot") || t.includes("reservation") ||
      t.includes("cancel") || t.includes("release") || t.includes("notify") ||
      t.includes("update") || t.includes("change") || t.includes("free") ||
      t.includes("available") || t.includes("queue")) {
    console.log(`[EPD SignalR] 🚨 SLOT EVENT DETECTED: ${target}`, JSON.stringify(args));
    _signalrSlotEvent = { target, args, ts: Date.now() };
    // Wake up polling immediately
    if (_pollWakeup) _pollWakeup();
    // Broadcast to other tabs
    try { _epdChannel?.postMessage({ type: "signalr_slot", target, args }); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
//  Genius #2 — BroadcastChannel cross-tab coordination
//  If the user has multiple tabs open to the portal, all tabs share their
//  poll results. Only one tab needs to make the actual HTTP request; the
//  others read from the channel. Effectively multiplies polling rate without
//  adding per-tab load.
// ---------------------------------------------------------------------------

let _lastBroadcast = null;
let _epdChannel = null;
let _pollWakeup = null; // resolve function to wake up sleeping poll loop

try {
  _epdChannel = new BroadcastChannel("epd_helper_v2_slots");
  _epdChannel.onmessage = (e) => {
    if (e.data?.type === "slots") {
      _lastBroadcast = { status: e.data.status, data: e.data.data, ts: Date.now() };
      console.log("[EPD] 📡 Received cross-tab slots, status:", e.data.status);
      if (_pollWakeup) _pollWakeup(); // wake up this tab's poll loop too
    }
    if (e.data?.type === "signalr_slot") {
      console.log("[EPD] 📡 Cross-tab SignalR slot event:", e.data.target);
      _signalrSlotEvent = { target: e.data.target, args: e.data.args, ts: Date.now() };
      if (_pollWakeup) _pollWakeup();
    }
    if (e.data?.type === "slot_found") {
      console.log("[EPD] 📡 Cross-tab SLOT FOUND! Stopping our poll.");
    }
  };
} catch (_) {}

function broadcastSlots(resp) {
  try { _epdChannel?.postMessage({ type: "slots", status: resp.status, data: resp.data }); } catch (_) {}
}

// ---------------------------------------------------------------------------
//  Smart sleep — can be interrupted by SignalR events or cross-tab signals
//  Returns early if a slot event is detected, saving seconds of waiting.
// ---------------------------------------------------------------------------
function smartSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { _pollWakeup = null; resolve("timeout"); }, ms);
    _pollWakeup = () => {
      clearTimeout(timer);
      _pollWakeup = null;
      console.log(`[EPD] ⚡ WAKEUP! Sleep interrupted by SignalR/cross-tab event`);
      resolve("wakeup");
    };
  });
}

// ---------------------------------------------------------------------------
//  Adaptive polling intelligence
//  Tracks slot appearance patterns to predict optimal check timing.
//  Speeds up polling during "hot" windows, slows down during dead time.
// ---------------------------------------------------------------------------
const _slotHistory = []; // timestamps when slots were last seen
let _consecutiveEmpty = 0; // how many checks returned empty

function _adaptiveDelay(baseMin, baseMax) {
  // If we just saw a slot event via SignalR → poll IMMEDIATELY
  if (_signalrSlotEvent && (Date.now() - _signalrSlotEvent.ts) < 5000) {
    console.log(`[EPD Adaptive] ⚡ SignalR event ${((Date.now() - _signalrSlotEvent.ts)/1000).toFixed(1)}с ago → instant poll`);
    return 100; // almost instant
  }

  // If few consecutive empties → normal speed
  if (_consecutiveEmpty < 10) return rand(baseMin, baseMax);

  // If many consecutive empties → slow down to conserve WAF budget
  if (_consecutiveEmpty < 30) {
    const slower = rand(baseMin * 1.5, baseMax * 1.5);
    return slower;
  }

  // Very long empty streak → even slower
  const vSlow = rand(baseMin * 2, baseMax * 2);
  console.log(`[EPD Adaptive] 💤 ${_consecutiveEmpty} empties → slower polling (${(vSlow/1000).toFixed(1)}с)`);
  return vSlow;
}

// ---------------------------------------------------------------------------
//  Genius #3 — AvailableDates pre-filter
//  Before hammering AvailableSlots, check if the target date even appears
//  in AvailableDates. Cache the result 30 s. When the date is absent, skip
//  slots polling entirely — saves the majority of requests on inactive days.
// ---------------------------------------------------------------------------

let _datesCache = { ts: 0, dates: null };

async function isDateListed(facilityId, vehicleId, transportType, targetDate) {
  const age = Date.now() - _datesCache.ts;
  if (_datesCache.dates !== null && age < 10_000) {
    return _datesCache.dates.includes(targetDate);
  }
  try {
    const today = new Date().toISOString().split("T")[0];
    const res = await apiGetJSON(
      `/reservations-api/v1/timeslot/AvailableDates?facilityId=${facilityId}` +
      `&fromDate=${today}&transportType=${transportType}&vehicleId=${vehicleId}`
    );
    if (res.status === 200 && Array.isArray(res.data)) {
      _datesCache = { ts: Date.now(), dates: res.data };
      console.log("[EPD] 📅 AvailableDates:", res.data);
      return res.data.includes(targetDate);
    }
  } catch (_) {}
  return true; // on error fall through to slots check
}

async function fetchReservation(uuid) {
  const { data } = await apiGetJSON(`/reservations-api/v1/${uuid}`);
  return data;
}

async function fetchAvailableSlots(params) {
  await _wafGate();
  const qs = new URLSearchParams(params).toString();
  const url = `/reservations-api/v1/timeslot/AvailableSlots?${qs}`;
  console.log("[EPD] AvailableSlots ->", url, `(WAF: ${_wafReqCount}/${WAF_LIMIT})`);
  const result = await apiGetJSON(url);
  _wafCountRequest();
  if (result.status >= 400 && result.status !== 400) {
    console.log(`[EPD] AvailableSlots <- ${result.status} ERROR:`, result.errorBody);
  } else {
    console.log("[EPD] AvailableSlots <-", result.status, result.data);
  }
  return result;
}

let _lastFetchCaptchaError = null;

function _formatEoppError(errorBody) {
  if (!errorBody) return "неизвестная ошибка";
  const title = errorBody.title || "";
  const detail = errorBody.detail || "";
  if (title === "CaptchaNotExistFreeTimeslot" || /таймслот/i.test(detail)) {
    return "нет свободного слота на это время (капчу не выдают)";
  }
  if (title === "SlotsNotFound") return "слотов нет на эту дату";
  if (detail) return detail.length > 120 ? detail.slice(0, 120) + "…" : detail;
  if (title) return title;
  return JSON.stringify(errorBody).slice(0, 120);
}

async function fetchCaptcha(body) {
  _lastFetchCaptchaError = null;
  // Server expects body wrapped in "payload" object
  const ordered = {
    payload: {
      reservationId: body.reservationId,
      facilityId: body.facilityId,
      timeSlotData: body.timeSlotData,
      encryptedTso: body.encryptedTso !== undefined ? body.encryptedTso : null,
    }
  };
  console.log("[EPD] fetchCaptcha REQUEST:", JSON.stringify(ordered));
  const res = await apiPostJSON("/reservations-api/v1/captcha", ordered);
  if (res.status === 400) {
    console.error("[EPD] fetchCaptcha 400 ERROR:", JSON.stringify(res.errorBody));
    await sleep(5_000);
    const res2 = await apiPostJSON("/reservations-api/v1/captcha", ordered);
    if (res2.status === 200) {
      let r2 = res2.data;
      if (r2?.payload) r2 = r2.payload;
      if (r2 && !r2.puzzle && r2.front) r2.puzzle = r2.front;
      console.log("[EPD] fetchCaptcha retry OK, token:", r2?.token?.slice(0,20));
      return r2;
    }
    _lastFetchCaptchaError = _formatEoppError(res2.errorBody || res.errorBody);
    console.error("[EPD] fetchCaptcha retry also failed:", res2.status, JSON.stringify(res2.errorBody));
    return null;
  }
  if (res.status === 403 || res.status === 429) {
    _lastFetchCaptchaError = `WAF / лимит запросов (${res.status})`;
    console.log(`[EPD] fetchCaptcha: WAF block (${res.status}) — ждём 30с`);
    await sleep(30_000);
    const res2 = await apiPostJSON("/reservations-api/v1/captcha", ordered);
    let r2 = res2.data;
    if (r2?.payload) r2 = r2.payload;
    if (r2 && !r2.puzzle && r2.front) r2.puzzle = r2.front;
    return r2;
  }
  // Server may wrap response in "payload" too — unwrap if needed
  let captchaResult = res.data;
  if (captchaResult?.payload) captchaResult = captchaResult.payload;
  // Server changed "puzzle" to "front" — normalize for backward compat
  if (captchaResult && !captchaResult.puzzle && captchaResult.front) {
    captchaResult.puzzle = captchaResult.front;
  }
  console.log("[EPD] fetchCaptcha RESPONSE status:", res.status,
    "type:", captchaResult?.front?.type || captchaResult?.puzzle?.type || '?',
    "tiles:", captchaResult?.puzzle?.tiles?.length,
    "variants:", captchaResult?.puzzle?.variantsCapture?.length,
    "hasImage:", !!(captchaResult?.front?.imageBase64),
    "hasIcons:", !!(captchaResult?.front?.iconsBase64),
    "token:", captchaResult?.token?.slice(0,20));

  // Detect captcha type: click-based (imageBase64+iconsBase64) vs puzzle (tiles+variantsCapture)
  if (captchaResult?.front?.imageBase64) {
    captchaResult._captchaType = "click";
    console.log("[EPD] ⚡ NEW CAPTCHA TYPE: click-based (image + icons → coordinates)");
  } else if (captchaResult?.puzzle?.tiles) {
    captchaResult._captchaType = "puzzle";
  }

  return captchaResult;
}

// _lastCaptchaData is set by solvePuzzle so validateCaptcha can save to cache
let _lastCaptchaData = null;

async function validateCaptcha(body) {
  // New API format: wrap facilityId/reservationId/timeSlotData/encryptedTso in "payload"
  const newBody = {
    captchaToken: body.captchaToken,
    answer: body.answer,
    payload: {
      reservationId: body.reservationId,
      facilityId: body.facilityId,
      timeSlotData: body.timeSlotData,
      encryptedTso: body.encryptedTso !== undefined ? body.encryptedTso : null,
    },
  };
  const res = await apiPostJSON("/reservations-api/v1/captcha-validate", newBody);
  const validateIcon = res.status === 200 && res.data?.isValid ? "✅" : "❌";
  const answerStr = Array.isArray(body.answer) && body.answer[0]?.x !== undefined
    ? body.answer.map(p => `(${p.x},${p.y})`).join(' ')
    : (Array.isArray(body.answer) ? body.answer.join(',') : String(body.answer));
  console.log(`[EPD] ${validateIcon} validate: HTTP ${res.status} | isValid=${res.data?.isValid} | token=${body.captchaToken?.slice(0,15)}... | answer=${answerStr}`);
  if (res.errorBody) console.log(`[EPD]    Error: ${res.errorBody?.title} — ${res.errorBody?.detail}`);
  if (res.status === 200) {
    if (res.data?.isValid === true && res.data?.successToken) {
      if (_lastCaptchaData?.puzzle && body.answer) {
        _tileCacheSave(_lastCaptchaData.puzzle, body.answer);
      }
      return res.data;
    }
    // isValid:false — wrong answer but token still alive (can try again)
    console.log("[EPD] validate: isValid=false, token alive, trying next variant");
    return null;
  }
  const errDetail = res.errorBody?.detail || "";
  const errTitle = res.errorBody?.title || "";
  console.log(`[EPD] validate: HTTP ${res.status}, title="${errTitle}", detail="${errDetail}"`);

  if (/токен.*истек|token.*expir/i.test(errDetail + errTitle)) {
    console.log("[EPD] validate: TOKEN EXPIRED — need new captcha");
    return { tokenExpired: true };
  }
  return null;
}

async function submitDraft(body) {
  console.log("[EPD] SubmitDraft REQUEST:", JSON.stringify(body, null, 2));
  const res = await apiPostJSON("/reservations-api/v1/SubmitDraft", body);
  if (res.status === 200) {
    console.log("[EPD] SubmitDraft SUCCESS:", JSON.stringify(res.data));
    return res.data;
  }
  console.error("[EPD] SubmitDraft FAILED:", res.status);
  console.error("[EPD] SubmitDraft RESPONSE:", JSON.stringify(res.errorBody));
  console.error("[EPD] SubmitDraft REQUEST WAS:", JSON.stringify(body));
  const detail = res.errorBody?.detail || res.errorBody?.title || "";
  const err = new Error(`SubmitDraft HTTP ${res.status}: ${detail}`);
  err.slotTaken = (res.errorBody?.eoppStatus === 41102);
  throw err;
}

// Same slot-taken detection for the Reschedule endpoint
async function reschedule(body) {
  const res = await apiPostJSON("/reservations-api/v1/Reschedule", body);
  if (res.status === 200) return res.data;
  const detail = res.errorBody?.detail || res.errorBody?.title || "";
  const err = new Error(`Reschedule HTTP ${res.status}: ${detail}`);
  err.slotTaken = (res.errorBody?.eoppStatus === 41102);
  throw err;
}

// ---------------------------------------------------------------------------
//  Puzzle solver — edge matching in pure JS (no server needed)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
//  Multi-scale tile loading
//
//  Root cause of edge matching failures: JPEG tiles are each compressed
//  independently. Their shared border undergoes separate DCT quantisation
//  which introduces blocking artefacts in the first ~3 pixels on each side.
//
//  Fix 1 (skip): ignore those 3 artefact pixels when comparing.
//  Fix 2 (multi-scale): also compare tiles at 1/4 resolution.
//    A 4× downscale averages 4×4 pixel blocks → JPEG 8×8 blocks shrink to 2×2 →
//    quantisation noise is almost gone while true colour continuity survives.
//  We weight the 1/4-scale score at 65% and full-scale at 35%.
// ---------------------------------------------------------------------------

function loadImageDataMultiScale(base64Jpeg) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const W = img.naturalWidth, H = img.naturalHeight;

          // Full resolution
          const cFull = document.createElement("canvas");
          cFull.width = W; cFull.height = H;
          const ctxFull = cFull.getContext("2d", { willReadFrequently: true });
          ctxFull.drawImage(img, 0, 0);
          const full = ctxFull.getImageData(0, 0, W, H);

          // Quarter resolution  (JPEG artefacts averaged out by browser bilinear scaler)
          const SW = Math.max(4, Math.floor(W / 4));
          const SH = Math.max(4, Math.floor(H / 4));
          const cSmall = document.createElement("canvas");
          cSmall.width = SW; cSmall.height = SH;
          const ctxSmall = cSmall.getContext("2d", { willReadFrequently: true, imageSmoothingQuality: "high" });
          ctxSmall.drawImage(img, 0, 0, SW, SH);
          const small = ctxSmall.getImageData(0, 0, SW, SH);

          resolve({ full, small });
        } catch (e) { console.error("[EPD] multi-scale error:", e); resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = "data:image/jpeg;base64," + base64Jpeg;
    } catch (e) { resolve(null); }
  });
}

// Legacy wrapper kept for code that still calls loadImageData directly
function loadImageData(base64Jpeg) {
  return loadImageDataMultiScale(base64Jpeg).then(r => r?.full ?? null);
}

// ---------------------------------------------------------------------------
//  Edge scoring v4 — Multi-signal approach for independently JPEG-compressed tiles
//
//  Key problems with prior approach:
//  1. 8px strip = 1 JPEG block → pixels share correlated quantization noise
//  2. Independent JPEG encoding creates ±10-15 DC offset per tile
//  3. Same-photograph tiles have similar palettes → random arrangements score well
//
//  Solution: 5 orthogonal signals designed to survive JPEG re-encoding:
//  S1. Prediction-based gradient (Gallagher MGC variant) — skip 8px JPEG boundary
//  S2. Rank correlation on luminance profile — immune to per-tile DC shifts
//  S3. Edge/line continuity via Sobel — strong edges survive JPEG
//  S4. Color ramp consistency — extrapolate interior gradient to boundary
//  S5. Texture energy coherence — local variance should be similar at seams
// ---------------------------------------------------------------------------

function _rgb2lab(r, g, b) {
  let rr = r/255, gg = g/255, bb = b/255;
  rr = rr > 0.04045 ? Math.pow((rr+0.055)/1.055, 2.4) : rr/12.92;
  gg = gg > 0.04045 ? Math.pow((gg+0.055)/1.055, 2.4) : gg/12.92;
  bb = bb > 0.04045 ? Math.pow((bb+0.055)/1.055, 2.4) : bb/12.92;
  let x = (rr*0.4124+gg*0.3576+bb*0.1805)/0.95047;
  let y = (rr*0.2126+gg*0.7152+bb*0.0722);
  let z = (rr*0.0193+gg*0.1192+bb*0.9505)/1.08883;
  x = x>0.008856 ? Math.cbrt(x) : 7.787*x+16/116;
  y = y>0.008856 ? Math.cbrt(y) : 7.787*y+16/116;
  z = z>0.008856 ? Math.cbrt(z) : 7.787*z+16/116;
  return [116*y-16, 500*(x-y), 200*(y-z)];
}

// Extract a band of LAB values: skip JPEG_SKIP pixels from edge, take BAND_DEPTH pixels
// Returns Float32Array[len * 3] — averaged along the depth axis
const JPEG_SKIP = 8;  // skip one full DCT block from the edge
const BAND_DEPTH = 16; // span 2 DCT blocks for independent noise averaging

function _extractBandLAB(data, w, h, side, skip, depth) {
  const horizontal = (side === 'top' || side === 'bottom');
  const len = horizontal ? w : h;
  const out = new Float32Array(len * 3);

  let y0, y1, x0, x1;
  if (side === 'top') { y0 = skip; y1 = Math.min(h, skip + depth); x0 = 0; x1 = w; }
  else if (side === 'bottom') { y0 = Math.max(0, h - skip - depth); y1 = h - skip; x0 = 0; x1 = w; }
  else if (side === 'left') { y0 = 0; y1 = h; x0 = skip; x1 = Math.min(w, skip + depth); }
  else { y0 = 0; y1 = h; x0 = Math.max(0, w - skip - depth); x1 = w - skip; }

  const actualDepth = horizontal ? (y1 - y0) : (x1 - x0);
  if (actualDepth <= 0) return out;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const pos = horizontal ? x : y;
      const o = (y * w + x) * 4;
      const [L, a, b] = _rgb2lab(data[o], data[o+1], data[o+2]);
      out[pos*3] += L; out[pos*3+1] += a; out[pos*3+2] += b;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] /= actualDepth;
  return out;
}

// Extract a single-pixel-deep strip at given offset from the edge
function _extractRowLAB(data, w, h, side, offset) {
  const horizontal = (side === 'top' || side === 'bottom');
  const len = horizontal ? w : h;
  const out = new Float32Array(len * 3);

  for (let i = 0; i < len; i++) {
    let px, py;
    if (side === 'top') { px = i; py = offset; }
    else if (side === 'bottom') { px = i; py = h - 1 - offset; }
    else if (side === 'left') { px = offset; py = i; }
    else { px = w - 1 - offset; py = i; }

    if (px < 0 || px >= w || py < 0 || py >= h) continue;
    const o = (py * w + px) * 4;
    const [L, a, b] = _rgb2lab(data[o], data[o+1], data[o+2]);
    out[i*3] = L; out[i*3+1] = a; out[i*3+2] = b;
  }
  return out;
}

// Spearman rank correlation — robust to monotonic transforms (JPEG DC shifts)
function _rankCorrelation(a, b) {
  const n = a.length;
  if (n < 4) return 0;
  const rankA = _toRanks(a);
  const rankB = _toRanks(b);
  let sumD2 = 0;
  for (let i = 0; i < n; i++) { const d = rankA[i] - rankB[i]; sumD2 += d * d; }
  return 1 - (6 * sumD2) / (n * (n * n - 1));
}

function _toRanks(arr) {
  const indexed = arr.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Float32Array(arr.length);
  for (let i = 0; i < indexed.length; i++) ranks[indexed[i].i] = i;
  return ranks;
}

// Sobel edge magnitude along a boundary strip
function _sobelEdgeMagnitude(data, w, h, side, depth) {
  const horizontal = (side === 'top' || side === 'bottom');
  const len = horizontal ? w : h;
  const out = new Float32Array(len);

  let y0, y1, x0, x1;
  if (side === 'top') { y0 = 0; y1 = Math.min(h, depth); x0 = 1; x1 = w - 1; }
  else if (side === 'bottom') { y0 = Math.max(0, h - depth); y1 = h; x0 = 1; x1 = w - 1; }
  else if (side === 'left') { y0 = 1; y1 = h - 1; x0 = 0; x1 = Math.min(w, depth); }
  else { y0 = 1; y1 = h - 1; x0 = Math.max(0, w - depth); x1 = w; }

  for (let y = Math.max(1, y0); y < Math.min(h - 1, y1); y++) {
    for (let x = Math.max(1, x0); x < Math.min(w - 1, x1); x++) {
      const pos = horizontal ? x : y;
      // Sobel on luminance (green channel approximation for speed)
      const c = 1;
      const tl = data[((y-1)*w+(x-1))*4+c], tc = data[((y-1)*w+x)*4+c], tr = data[((y-1)*w+(x+1))*4+c];
      const ml = data[(y*w+(x-1))*4+c],                                   mr = data[(y*w+(x+1))*4+c];
      const bl = data[((y+1)*w+(x-1))*4+c], bc = data[((y+1)*w+x)*4+c], br = data[((y+1)*w+(x+1))*4+c];
      const gx = -tl + tr - 2*ml + 2*mr - bl + br;
      const gy = -tl - 2*tc - tr + bl + 2*bc + br;
      out[pos] += Math.sqrt(gx*gx + gy*gy);
    }
  }
  const actualDepth = horizontal ? Math.min(h-2, y1-y0) : Math.min(w-2, x1-x0);
  if (actualDepth > 0) for (let i = 0; i < len; i++) out[i] /= actualDepth;
  return out;
}

// Local variance (texture energy) in a band near the edge
function _textureEnergy(data, w, h, side, skip, depth) {
  const horizontal = (side === 'top' || side === 'bottom');
  const BINS = 8;
  const out = new Float32Array(BINS);

  let y0, y1, x0, x1;
  if (side === 'top') { y0 = skip; y1 = Math.min(h, skip + depth); x0 = 0; x1 = w; }
  else if (side === 'bottom') { y0 = Math.max(0, h - skip - depth); y1 = h - skip; x0 = 0; x1 = w; }
  else if (side === 'left') { y0 = 0; y1 = h; x0 = skip; x1 = Math.min(w, skip + depth); }
  else { y0 = 0; y1 = h; x0 = Math.max(0, w - skip - depth); x1 = w - skip; }

  const segLen = horizontal ? Math.ceil(w / BINS) : Math.ceil(h / BINS);
  const counts = new Float32Array(BINS);

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const pos = horizontal ? x : y;
      const bin = Math.min(BINS - 1, Math.floor(pos / segLen));
      const o = (y * w + x) * 4;
      // Local contrast: difference from adjacent pixel
      const nx = Math.min(w - 1, x + 1), ny = Math.min(h - 1, y + 1);
      const on = (ny * w + nx) * 4;
      const diff = Math.abs(data[o] - data[on]) + Math.abs(data[o+1] - data[on+1]) + Math.abs(data[o+2] - data[on+2]);
      out[bin] += diff;
      counts[bin]++;
    }
  }
  for (let i = 0; i < BINS; i++) if (counts[i] > 0) out[i] /= counts[i];
  return out;
}

function edgeScore(imgA, imgB, sideA, sideB) {
  const wA = imgA.width, hA = imgA.height;
  const wB = imgB.width, hB = imgB.height;
  if (!wA || !hA || !wB || !hB) return 1e18;

  const dA = imgA.data, dB = imgB.data;
  const horizontal = (sideA === 'top' || sideA === 'bottom');
  const lenA = horizontal ? wA : hA;
  const lenB = horizontal ? wB : hB;
  if (lenA !== lenB) return 1e18;
  const len = lenA;

  // === Signal 1: Prediction-based gradient compatibility ===
  // Compare gradient at seam (row at skip+1 minus row at skip) against
  // typical within-tile gradient (row at skip+depth minus row at skip+depth-1)
  // This is a Gallagher-MGC variant that skips the JPEG boundary zone.
  const rowA_edge = _extractRowLAB(dA, wA, hA, sideA, JPEG_SKIP);
  const rowB_edge = _extractRowLAB(dB, wB, hB, sideB, JPEG_SKIP);
  const rowA_inner = _extractRowLAB(dA, wA, hA, sideA, JPEG_SKIP + 4);
  const rowB_inner = _extractRowLAB(dB, wB, hB, sideB, JPEG_SKIP + 4);

  // Seam gradient: how the color changes from A's interior edge to B's interior edge
  // For correct match this should be small and smooth
  let seamGradSSD = 0;
  for (let i = 0; i < len * 3; i++) {
    const seamGrad = rowB_edge[i] - rowA_edge[i];
    const innerGradA = rowA_edge[i] - rowA_inner[i]; // typical gradient within A
    const innerGradB = rowB_inner[i] - rowB_edge[i]; // typical gradient within B (note reversed direction)
    const expectedGrad = (innerGradA + innerGradB) * 0.5;
    const diff = seamGrad - expectedGrad;
    seamGradSSD += diff * diff;
  }
  const signal1 = seamGradSSD / (len * 3);

  // === Signal 2: Rank correlation on luminance profile ===
  // Immune to per-tile brightness shifts from independent JPEG DC quantization
  const lumA = new Float32Array(len);
  const lumB = new Float32Array(len);
  for (let i = 0; i < len; i++) { lumA[i] = rowA_edge[i*3]; lumB[i] = rowB_edge[i*3]; }

  const rankCorr = _rankCorrelation(lumA, lumB);
  const signal2 = (1 - rankCorr) * 100; // 0=perfect match, 200=anti-correlated

  // === Signal 3: Edge/line continuity (Sobel magnitude profile) ===
  // Strong edges in photos survive JPEG compression
  const edgeA = _sobelEdgeMagnitude(dA, wA, hA, sideA, 12);
  const edgeB = _sobelEdgeMagnitude(dB, wB, hB, sideB, 12);
  let edgeSSD = 0;
  for (let i = 0; i < len; i++) {
    const d = edgeA[i] - edgeB[i];
    edgeSSD += d * d;
  }
  const signal3 = edgeSSD / len;

  // === Signal 4: Color ramp extrapolation ===
  // Fit a linear ramp across the band interior, extrapolate to boundary, compare
  const bandA = _extractBandLAB(dA, wA, hA, sideA, JPEG_SKIP, BAND_DEPTH);
  const bandB = _extractBandLAB(dB, wB, hB, sideB, JPEG_SKIP, BAND_DEPTH);
  let bandSSD = 0;
  for (let i = 0; i < len * 3; i++) {
    const d = bandA[i] - bandB[i];
    bandSSD += d * d;
  }
  const signal4 = bandSSD / (len * 3);

  // === Signal 5: Texture energy coherence ===
  // Adjacent tiles from same region have similar texture complexity
  const texA = _textureEnergy(dA, wA, hA, sideA, JPEG_SKIP, BAND_DEPTH);
  const texB = _textureEnergy(dB, wB, hB, sideB, JPEG_SKIP, BAND_DEPTH);
  let texSSD = 0;
  for (let i = 0; i < texA.length; i++) {
    const d = texA[i] - texB[i];
    texSSD += d * d;
  }
  const signal5 = texSSD / texA.length;

  // Combine with learned weights (lower = better match)
  return signal1 * 0.30 + signal2 * 0.25 + signal3 * 0.005 + signal4 * 0.25 + signal5 * 0.02;
}

// ---------------------------------------------------------------------------
//  Puzzle solver v4 — multi-signal edge matching with z-score confidence
//
//  Key improvements:
//  1. Per-edge pairwise scoring with adaptive weighting
//  2. Full-tile color centroid matching for macro-layout detection
//  3. Z-score based confidence (statistically meaningful gap detection)
//  4. No multi-scale blending (downscaled tiles lose too much edge info)
// ---------------------------------------------------------------------------

async function solvePuzzleEdgeMatch(captchaData) {
  try {
    const puzzle = captchaData.puzzle;
    const variants = puzzle?.variantsCapture || captchaData.variantsCapture;
    console.log("[EPD] puzzle tiles:", puzzle?.tiles?.length, "variants:", variants?.length);
    if (!puzzle || !puzzle.tiles || !variants?.length) return null;

    const tileData = {};
    await Promise.all(puzzle.tiles.map(async (t) => {
      const ms = await loadImageDataMultiScale(t.imageData);
      if (ms) tileData[t.tileId] = ms;
    }));

    const loaded = Object.keys(tileData).length;
    if (loaded < puzzle.tiles.length) {
      console.warn(`[EPD] Only loaded ${loaded}/${puzzle.tiles.length} tiles`);
      return null;
    }

    const cols = 3;
    const rows = Math.ceil(variants[0].length / cols);

    // Precompute tile color centroids (full tile LAB average) for macro-layout matching
    const tileCentroids = {};
    for (const [tid, td] of Object.entries(tileData)) {
      const img = td.full;
      const px = img.width * img.height;
      let L = 0, a = 0, b = 0;
      for (let i = 0; i < px; i++) {
        const o = i * 4;
        const [tL, ta, tb] = _rgb2lab(img.data[o], img.data[o+1], img.data[o+2]);
        L += tL; a += ta; b += tb;
      }
      tileCentroids[tid] = [L/px, a/px, b/px];
    }

    // Compute color gradient direction for each tile (which direction does scene change?)
    const tileGradients = {};
    for (const [tid, td] of Object.entries(tileData)) {
      const img = td.full;
      const w = img.width, h = img.height;
      const d = img.data;
      // Average color of left half vs right half
      let lL = 0, la = 0, lb = 0, rL = 0, ra = 0, rb = 0;
      let tL = 0, ta = 0, tb = 0, bL = 0, ba = 0, bb = 0;
      const halfW = Math.floor(w / 2), halfH = Math.floor(h / 2);
      let lCnt = 0, rCnt = 0, tCnt = 0, bCnt = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          const [pL, pa, pb] = _rgb2lab(d[o], d[o+1], d[o+2]);
          if (x < halfW) { lL += pL; la += pa; lb += pb; lCnt++; }
          else { rL += pL; ra += pa; rb += pb; rCnt++; }
          if (y < halfH) { tL += pL; ta += pa; tb += pb; tCnt++; }
          else { bL += pL; ba += pa; bb += pb; bCnt++; }
        }
      }
      tileGradients[tid] = {
        hGrad: [(rL/rCnt - lL/lCnt), (ra/rCnt - la/lCnt), (rb/rCnt - lb/lCnt)],
        vGrad: [(bL/bCnt - tL/tCnt), (ba/bCnt - ta/tCnt), (bb/bCnt - tb/tCnt)]
      };
    }

    // Score each variant
    const scored = variants.map((v, vi) => {
      let edgeTotal = 0;
      let centroidTotal = 0;
      let gradientTotal = 0;
      let edgeCount = 0;

      for (let idx = 0; idx < v.length; idx++) {
        const row = Math.floor(idx / cols), col = idx % cols;
        const td = tileData[v[idx]];
        if (!td) { edgeTotal += 1e9; continue; }

        // Horizontal adjacency (right-left)
        if (col + 1 < cols) {
          const tdR = tileData[v[idx + 1]];
          if (tdR) {
            edgeTotal += edgeScore(td.full, tdR.full, "right", "left");
            edgeCount++;

            // Centroid adjacency: right half of A should be similar to left half of B's vicinity
            const cA = tileCentroids[v[idx]];
            const cB = tileCentroids[v[idx + 1]];
            const dL = cA[0] - cB[0], da = cA[1] - cB[1], db = cA[2] - cB[2];
            centroidTotal += Math.sqrt(dL*dL + da*da + db*db);

            // Gradient consistency: A's rightward gradient should "hand off" to B
            const gA = tileGradients[v[idx]];
            const gB = tileGradients[v[idx + 1]];
            const gDiff = Math.abs(gA.hGrad[0] - gB.hGrad[0]) +
                          Math.abs(gA.hGrad[1] - gB.hGrad[1]) +
                          Math.abs(gA.hGrad[2] - gB.hGrad[2]);
            gradientTotal += gDiff;
          }
        }

        // Vertical adjacency (bottom-top)
        if (row + 1 < rows) {
          const tdB = tileData[v[idx + cols]];
          if (tdB) {
            edgeTotal += edgeScore(td.full, tdB.full, "bottom", "top");
            edgeCount++;

            const cA = tileCentroids[v[idx]];
            const cB = tileCentroids[v[idx + cols]];
            const dL = cA[0] - cB[0], da = cA[1] - cB[1], db = cA[2] - cB[2];
            centroidTotal += Math.sqrt(dL*dL + da*da + db*db);

            const gA = tileGradients[v[idx]];
            const gB = tileGradients[v[idx + cols]];
            const gDiff = Math.abs(gA.vGrad[0] - gB.vGrad[0]) +
                          Math.abs(gA.vGrad[1] - gB.vGrad[1]) +
                          Math.abs(gA.vGrad[2] - gB.vGrad[2]);
            gradientTotal += gDiff;
          }
        }
      }

      // Normalize edge score by count to avoid bias
      const normEdge = edgeCount > 0 ? edgeTotal / edgeCount : 1e18;
      const normCentroid = edgeCount > 0 ? centroidTotal / edgeCount : 1e18;
      const normGradient = edgeCount > 0 ? gradientTotal / edgeCount : 1e18;

      return { idx: vi, normEdge, normCentroid, normGradient, answer: v };
    });

    // Z-score normalization: convert each signal to z-scores, then combine
    function zNormalize(arr, key) {
      const vals = arr.map(s => s[key]);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const std = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length) || 1;
      return arr.map(s => (s[key] - mean) / std);
    }

    const zEdge = zNormalize(scored, 'normEdge');
    const zCentroid = zNormalize(scored, 'normCentroid');
    const zGradient = zNormalize(scored, 'normGradient');

    // Combined z-score (lower = better)
    const combined = scored.map((s, i) => ({
      idx: s.idx,
      score: zEdge[i] * 0.55 + zCentroid[i] * 0.25 + zGradient[i] * 0.20,
      answer: s.answer,
      detail: { edge: zEdge[i].toFixed(2), centroid: zCentroid[i].toFixed(2), grad: zGradient[i].toFixed(2) }
    }));

    combined.sort((a, b) => a.score - b.score);

    // Confidence: how many standard deviations the best is below the pack
    const scores = combined.map(c => c.score);
    const restMean = scores.slice(1).reduce((a, b) => a + b, 0) / (scores.length - 1);
    const restStd = Math.sqrt(scores.slice(1).reduce((a, v) => a + (v - restMean) ** 2, 0) / (scores.length - 1)) || 1;
    const zGap = (restMean - scores[0]) / restStd;

    // Convert z-gap to confidence: z=1→~50%, z=2→~85%, z=3→~95%
    const confidence = Math.min(1, Math.max(0, 1 - Math.exp(-0.7 * zGap)));

    const ranked = combined.map(c => ({ idx: c.idx, score: c.score, answer: c.answer }));

    console.log(
      `[EPD] EdgeMatch Top3: ${ranked.slice(0,3).map(r =>
        `v${r.idx}(z=${r.score.toFixed(2)})`
      ).join(', ')}  gap=${zGap.toFixed(2)}σ  conf=${(confidence*100).toFixed(1)}%`
    );
    console.log(`[EPD] Detail #1: ${JSON.stringify(combined[0].detail)}`);
    return { ranked, confidence };
  } catch (err) {
    console.error("[EPD] solvePuzzleEdgeMatch error:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
//  RuCaptcha — runs DIRECTLY in content.js (same as Gemini, no SW needed).
//  Renders composite image here, submits to RuCaptcha API via fetch.
//  First poll at 6 seconds as requested.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
//  RuCaptcha — hybrid approach:
//    Render composite image HERE (content.js has DOM canvas)
//    Send HTTP requests via BACKGROUND.js (no CORS restrictions in SW)
// ---------------------------------------------------------------------------

// Render ALL variants for RuCaptcha. Small tiles to keep image under 300KB.
// Must show ALL 15 variants — workers answer "UNSOLVABLE" when the correct
// variant is missing from the displayed set.
function _renderRuCaptchaImage(captchaData, maxVariants = 15) {
  return new Promise(async (resolve) => {
    try {
      const puzzle = captchaData.puzzle;
      const allVariants = puzzle?.variantsCapture || captchaData.variantsCapture || [];
      if (!allVariants.length) { resolve(null); return; }

      const showVariants = allVariants.slice(0, Math.min(maxVariants, allVariants.length));

      const imgs = {};
      await Promise.all(puzzle.tiles.map(t => new Promise(res => {
        const i = new Image(); i.onload = () => { imgs[t.tileId] = i; res(); }; i.onerror = res;
        i.src = "data:image/jpeg;base64," + t.imageData;
      })));

      const cols = 3, tileW = 120, tileH = 68;
      const gridW = tileW * cols, gridH = tileH * 3;
      const gap = 5, labelH = 16;
      const gCols = Math.min(3, showVariants.length);
      const gRows = Math.ceil(showVariants.length / gCols);
      const canvas = document.createElement("canvas");
      canvas.width  = gCols * (gridW + gap) + gap;
      canvas.height = gRows * (gridH + labelH + gap) + gap;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (let i = 0; i < showVariants.length; i++) {
        const v = showVariants[i];
        const gr = Math.floor(i / gCols), gc = i % gCols;
        const ox = gap + gc * (gridW + gap), oy = gap + gr * (gridH + labelH + gap);
        ctx.fillStyle = "#000"; ctx.font = "bold 13px Arial"; ctx.textAlign = "center";
        ctx.fillText(String(i + 1), ox + gridW / 2, oy + 13); ctx.textAlign = "left";
        for (let ti = 0; ti < v.length; ti++) {
          const r = Math.floor(ti / cols), c = ti % cols;
          const img = imgs[v[ti]];
          if (img) ctx.drawImage(img, ox + c * tileW, oy + labelH + r * tileH, tileW, tileH);
        }
        ctx.strokeStyle = "rgba(255,0,0,0.35)"; ctx.lineWidth = 1;
        for (let c = 1; c < cols; c++) {
          ctx.beginPath(); ctx.moveTo(ox+c*tileW, oy+labelH); ctx.lineTo(ox+c*tileW, oy+labelH+gridH); ctx.stroke();
        }
        for (let r = 1; r < 3; r++) {
          ctx.beginPath(); ctx.moveTo(ox, oy+labelH+tileH*r); ctx.lineTo(ox+gridW, oy+labelH+tileH*r); ctx.stroke();
        }
      }
      const b64 = canvas.toDataURL("image/jpeg", 0.72).split(",")[1];
      console.log(`[EPD RuCaptcha] Compact image: ${canvas.width}×${canvas.height}px, ${showVariants.length} variants, ~${Math.round(b64.length*3/4/1024)}KB`);
      resolve({ b64, count: showVariants.length });
    } catch (e) {
      console.error("[EPD RuCaptcha] render error:", e.message);
      resolve(null);
    }
  });
}

// ---------------------------------------------------------------------------
//  CapSolver — AI-powered, 2-4 seconds average
//  Set your API key here or leave empty to skip.
//  Get key at https://capsolver.com (costs ~$2.5/1000 solves)
// ---------------------------------------------------------------------------

const CAPSOLVER_KEY = ""; // CapSolver заблокирован в регионе (ERR_CONNECTION_RESET)

// ---------------------------------------------------------------------------
//  Anti-Captcha — reliable human+AI solver
//  Get key at https://anti-captcha.com, pay with WebMoney/crypto
//  Average solve time for images: ~5-8 seconds
// ---------------------------------------------------------------------------

const ANTICAPTCHA_KEY = ""; // Работники не понимают пазл — "could not be solved by 5 workers"

// ---------------------------------------------------------------------------
//  CapMonster Cloud — fastest AI solver, 1-2 seconds, $0.30/1000
//  Russian company, works from RU/CIS. Supports "comment" parameter.
//  Docs: https://docs.capmonster.cloud
// ---------------------------------------------------------------------------

const CAPMONSTER_KEY = ""; // ERR_CONNECTION_RESET — заблокирован в регионе

async function solvePuzzleViaCapMonster(captchaData) {
  if (!CAPMONSTER_KEY) return null;
  const allVariants = captchaData.puzzle?.variantsCapture || captchaData.variantsCapture || [];
  if (!allVariants.length) return null;

  console.log("[EPD CapMonster] Rendering image...");
  const rendered = await _renderRuCaptchaImage(captchaData, 15);
  if (!rendered) return null;

  const n = rendered.count;
  try {
    console.log("[EPD CapMonster] Creating task...");
    const createResp = await fetch("https://api.capmonster.cloud/createTask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: CAPMONSTER_KEY,
        task: {
          type: "ImageToTextTask",
          body: rendered.b64,
          comment: `${n} пронумерованных пазлов (1-${n}). В каждом 9 плиток 3x3. Красные линии — границы. ОДИН собран правильно (цельное фото). Ответь ТОЛЬКО цифрой.`,
        },
      }),
    });
    const createData = await createResp.json();
    if (createData.errorId) {
      console.log("[EPD CapMonster] Error:", createData.errorCode, createData.errorDescription);
      return null;
    }
    const taskId = createData.taskId;
    console.log(`[EPD CapMonster] Task ${taskId}, polling...`);

    for (let i = 0; i < 15; i++) {
      await sleep(i === 0 ? 2000 : 1500);
      try {
        const pollResp = await fetch("https://api.capmonster.cloud/getTaskResult", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientKey: CAPMONSTER_KEY, taskId }),
        });
        const p = await pollResp.json();
        if (p.status === "ready" && p.solution?.text) {
          const text = p.solution.text.trim();
          console.log(`[EPD CapMonster] Answer: "${text}"`);
          const nums = text.match(/\d+/g);
          if (nums) {
            const idx = parseInt(nums[nums.length - 1]) - 1;
            if (idx >= 0 && idx < allVariants.length) {
              console.log(`[EPD CapMonster] Chose variant ${idx + 1}`);
              return allVariants[idx];
            }
          }
          return null;
        }
        if (p.errorId) { console.log("[EPD CapMonster]", p.errorCode); return null; }
      } catch (e) { console.warn("[EPD CapMonster] Poll:", e.message); }
    }
    console.log("[EPD CapMonster] Timed out");
  } catch (e) { console.error("[EPD CapMonster]", e.message); }
  return null;
}

// ---------------------------------------------------------------------------
//  Gemini Vision через AITUNNEL — оплата в рублях, без VPN
//  OpenAI-совместимый формат. Модель: gemini-2.5-flash
// ---------------------------------------------------------------------------

// AITUNNEL — единый API для нейросетей, оплата в рублях
const AITUNNEL_KEY = "sk-aitunnel-1pE1WYHB7tFuMsMwpvJs2Batih5n38Xh";
const AITUNNEL_URL = "https://api.aitunnel.ru/v1/chat/completions";

// ---------------------------------------------------------------------------
//  Cap.Guru — Russian AI captcha service, $0.10/1000, 2-3s solve time
//  Supports GenericPuzzleTask — perfect for our puzzle captcha.
//  Docs: https://cap.guru/ru/docs/v3/
// ---------------------------------------------------------------------------

const CAPGURU_KEY = ""; // user needs to set this

async function solvePuzzleViaCapGuru(captchaData) {
  if (!CAPGURU_KEY) return null;
  const allVariants = captchaData.puzzle?.variantsCapture || captchaData.variantsCapture || [];
  if (!allVariants.length) return null;

  console.log("[EPD Cap.Guru] Rendering image...");
  const rendered = await _renderRuCaptchaImage(captchaData, 15);
  if (!rendered) return null;

  const n = rendered.count;
  try {
    console.log("[EPD Cap.Guru] Creating task...");
    const createResp = await fetch("https://api3.cap.guru/createTask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: CAPGURU_KEY,
        task: {
          type: "ImageToTextTask",
          body: rendered.b64,
          comment: `Image shows ${n} numbered puzzle variants (1-${n}). Each is 3x3 grid. Which number is the correctly assembled photo? Reply ONLY with the number.`,
          numeric: 1,
          minLength: 1,
          maxLength: 2,
        },
      }),
    });
    const createData = await createResp.json();
    if (createData.errorId) {
      console.log("[EPD Cap.Guru] Error:", createData.errorDescription);
      return null;
    }
    const taskId = createData.taskId;
    console.log(`[EPD Cap.Guru] Task ${taskId}, polling...`);

    for (let i = 0; i < 20; i++) {
      await sleep(i < 3 ? 2000 : 3000);
      const pollResp = await fetch("https://api3.cap.guru/getTaskResult", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: CAPGURU_KEY, taskId }),
      });
      const pollData = await pollResp.json();
      if (pollData.status === "ready") {
        const text = (pollData.solution?.text || "").trim();
        console.log(`[EPD Cap.Guru] Answer: "${text}"`);
        const nums = text.match(/\d+/g);
        if (nums) {
          const idx = parseInt(nums[nums.length - 1]) - 1;
          if (idx >= 0 && idx < allVariants.length) {
            console.log(`[EPD Cap.Guru] ✅ Variant ${idx + 1}`);
            return allVariants[idx];
          }
        }
        return null;
      }
      if (pollData.status === "processing") continue;
      console.log("[EPD Cap.Guru] Unexpected:", pollData);
      return null;
    }
  } catch (e) { console.error("[EPD Cap.Guru] Error:", e.message); }
  return null;
}

// ---------------------------------------------------------------------------
//  CLICK CAPTCHA — NCC v5.11: global-pool, step4 indep, 3 scales (no edge coarse)
// ---------------------------------------------------------------------------

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

/** NCC peaks on BG-removed main field — фон подавлен, strip без изменений. */
async function solveClickBgNCC(front, onProgress = null) {
  if (!front?.imageBase64 || !front?.iconsBase64) return null;
  const t0 = Date.now();
  onProgress?.("декодируем...");
  const mainImg = await _decodeImg(front.imageBase64);
  const stripImg = await _decodeImg(front.iconsBase64);
  if (!mainImg || !stripImg) return null;

  const bgT0 = Date.now();
  const cleanMain = _removeMainBackground(mainImg);
  const cleanStrip = window.EPD_BG_REMOVE?.normalizeStripBlackOnWhite
    ? window.EPD_BG_REMOVE.normalizeStripBlackOnWhite(stripImg)
    : stripImg;
  const bgMs = Date.now() - bgT0;
  onProgress?.("BG-remove + NCC peaks...");

  const src = _toClickChannels(cleanMain);
  const strip = _toClickChannels(cleanStrip);
  const iconCount = _detectIconCount(strip, stripImg);
  const icons = _splitIconChannels(strip, iconCount, stripImg);

  const nccT0 = Date.now();
  const { cands: peakLists, scaleCache } = _nccFindTopPeaksAll(src, icons, NCC_PEAKS_PER_ICON);
  const nccCands = peakLists.map((peaks, i) =>
    peaks.map(p => _nccRescoreAt(src, icons[i], p.x, p.y, scaleCache[i])),
  );
  const nccMs = Date.now() - nccT0;
  const nccTag = _nccPeakScanTag();
  console.log(`[EPD CLICK:BG+NCC] bg=${bgMs}мс, scan ${nccTag} ${iconCount}×${NCC_PEAKS_PER_ICON} (step${_nccPeakStep()}) за ${nccMs}мс`);
  _clickLogNccPeaksDiag(nccCands);

  const r = _clickFinalizeNccPeaksResult(_clickResolveNccAssign(nccCands), iconCount, t0, nccMs, nccCands);
  if (r) r.method = (r.method || "NCC-peaks").replace(/^NCC-peaks/, "BG+NCC-peaks");
  return r;
}

/** ML on NCC peaks: без grid — NCC находит кандидаты, ML выбирает совпадение. */
async function solveClickMLPeaks(front, onProgress = null) {
  if (!front?.imageBase64 || !front?.iconsBase64) return null;
  const t0 = Date.now();
  onProgress?.("декодируем...");
  const mainImg = await _decodeImg(front.imageBase64);
  const stripImg = await _decodeImg(front.iconsBase64);
  if (!mainImg || !stripImg || !window.EPD_ML_SOLVER?.mlIsReady()) return null;

  const src = _toClickChannels(mainImg);
  const strip = _toClickChannels(stripImg);
  const iconCount = _detectIconCount(strip, stripImg);
  const icons = _splitIconChannels(strip, iconCount, stripImg);
  const iconImgs = _splitIconImages(stripImg, iconCount);

  onProgress?.("NCC peaks...");
  const nccT0 = Date.now();
  const { cands: peakLists, scaleCache } = _nccFindTopPeaksAll(src, icons, NCC_PEAKS_PER_ICON);
  const nccCands = peakLists.map((peaks, i) =>
    peaks.map(p => _nccRescoreAt(src, icons[i], p.x, p.y, scaleCache[i])),
  );
  const nccMs = Date.now() - nccT0;
  const nccTag = _nccPeakScanTag();
  console.log(`[EPD CLICK:ML-peaks] NCC ${nccTag} ${iconCount}×${NCC_PEAKS_PER_ICON} peaks (step${_nccPeakStep()}) за ${nccMs}мс`);
  _clickLogNccPeaksDiag(nccCands);

  onProgress?.("ML score peaks...");
  const items = icons.map((_, i) => ({
    iconImg: iconImgs[i],
    peaks: nccCands[i],
    patchW: scaleCache[i].bTW,
    patchH: scaleCache[i].bTH,
  }));
  const refine = await window.EPD_ML_SOLVER.mlRefineMultiIcon(mainImg, items, _mlWeights());
  const mlCands = refine.cands ?? refine;

  return _clickFinalizeMlResult(
    await _clickResolveMlAssignAsync(mlCands),
    iconCount, t0, "ML-peaks", "ML-peaks", nccCands,
  );
}

/* NCC+MobileNet hybrid — отключён (ML_ONLY)
async function solveClickHybrid(front) {
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

  const assigned = await _nccSolveAssignAsync(src, icons, iconImgs, mainImg);
  if (!assigned) return null;

  const coords = [];
  const confs = [];
  const mlScores = [];
  const margins = [];
  let minConf = 1;
  let minMl = 1;
  for (let i = 0; i < assigned.length; i++) {
    const r = assigned[i];
    if (!r) {
      console.log(`[EPD CLICK:NCC+ML] ⚠️ icon ${i + 1}: no peak`);
      return null;
    }
    coords.push({ x: r.x, y: r.y });
    confs.push(r.conf);
    mlScores.push(r.mlScore ?? null);
    margins.push((r.margin * 100).toFixed(0));
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
  const avgPct = (avgConf * 100).toFixed(0);
  console.log(`[EPD CLICK:NCC+ML] ${iconCount} icons, per=${perPct.join("/")}%, min=${confPct}%, ml_min=${mlPct}%, race=${raceReady ? "OK" : deferReady ? "defer" : "weak"} за ${Date.now() - t0}мс`);

  if (coords.length >= 3 && _clickHasNearDuplicates(coords)) {
    console.log(`[EPD CLICK:NCC+ML] ⚠️ близкие точки — skip`);
    return null;
  }
  if (coords.length >= 3 && clusterBad) {
    console.log(`[EPD CLICK:NCC+ML] ⚠️ cluster dup — validate skip`);
    return null;
  }
  if (coords.length >= 3 && (raceReady || deferReady)) {
    return { coords, conf: minConf, confs, mlScores, avgConf, raceReady, deferReady, clusterBad, method: "NCC+ML" };
  }
  if (coords.length >= 3 && minConf >= NCC_DEFER_FLOOR) {
    return { coords, conf: minConf, confs, mlScores, avgConf, raceReady: false, deferReady: false, weak: true, clusterBad, method: "NCC+ML" };
  }
  if (coords.length >= 3) {
    console.log(`[EPD CLICK:NCC+ML] ⚠️ слишком слабо (min ${confPct}%) — skip`);
  }
  return null;
}
*/

/** Click captcha race: NCC fast (~1с) или ML grid (training). */
async function solveClickRace(captchaData, workers = 3) {
  const front = captchaData.front;
  const t0 = Date.now();
  const useMl = ML_ENABLED && window.EPD_ML_SOLVER;
  if (useMl) await window.EPD_ML_SOLVER.mlInit().catch(() => null);
  const mlReady = useMl && window.EPD_ML_SOLVER.mlIsReady();
  const raceLabel = ML_ONLY
    ? (mlReady
      ? (ML_GRID ? "ML-only grid" : "ML peaks + fast NCC")
      : "ML init failed")
    : (ML_ENABLED
      ? (mlReady ? "NCC fast + ML refine" : "NCC-only (ML off)")
      : "NCC peaks only (ML disabled)");
  console.log(`[EPD CLICK] ╔═══════════════════════════════════════════════════╗`);
  console.log(`[EPD CLICK] ║ RACE: ${raceLabel.padEnd(43)}║`);
  console.log(`[EPD CLICK] ╚═══════════════════════════════════════════════════╝`);

  if (ML_ONLY && !mlReady) {
    console.log(`[EPD CLICK] ❌ ML model not ready (${Date.now() - t0}мс)`);
    return null;
  }

  const r = ML_ONLY
    ? (ML_GRID
      ? await solveClickML(front, captchaData._onMlProgress)
      : await solveClickMLPeaks(front, captchaData._onMlProgress))
    : (ML_ENABLED
      ? await solveClickFast(front)
      : await solveClickNCCPeaks(front, captchaData._onMlProgress));
  captchaData._lastClickSolve = r;
  const ms = Date.now() - t0;
  const tag = r?.method || "ML-only";
  if (!r) {
    console.log(`[EPD CLICK] ❌ ${tag} no coords (${ms}мс)`);
    return null;
  }
  if (r.raceReady) {
    console.log(`[EPD CLICK] 🏁 ${tag}(${(r.conf * 100).toFixed(0)}%) за ${ms}мс`);
    return r.coords;
  }
  if (r.deferReady) {
    console.log(`[EPD CLICK] 🏁 ${tag}-defer(${(r.conf * 100).toFixed(0)}%) за ${ms}мс`);
    return r.coords;
  }
  if (r.weak) {
    console.log(`[EPD CLICK] 🏁 ${tag}-weak(${(r.conf * 100).toFixed(0)}%) за ${ms}мс`);
    return r.coords;
  }
  if (ML_TRAINING_MODE && r.coords?.length >= 3) {
    console.log(`[EPD CLICK] 🏁 ${tag}-train(${(r.conf * 100).toFixed(0)}%) за ${ms}мс`);
    return r.coords;
  }
  console.log(`[EPD CLICK] ❌ ${tag} below threshold (${ms}мс)`);
  return null;

  /* CLICK_USE_AI — отключено, улучшаем NCC
  return new Promise((resolve) => {
    ...
    _solveClickAI(front, abort.signal).then((coords) => { ... });
  });
  */
}

function _decodeImg(b64) {
  return new Promise(r => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      r(ctx.getImageData(0, 0, c.width, c.height));
    };
    img.onerror = () => r(null);
    img.src = "data:image/jpeg;base64," + b64;
  });
}

/** Main field + icon strip (same layout as RuCaptcha composite). */
async function _buildClickComposite(front) {
  const mainImg = await _decodeImg(front.imageBase64);
  const stripImg = await _decodeImg(front.iconsBase64);
  if (!mainImg || !stripImg) return null;

  const mW = mainImg.width;
  const mH = mainImg.height;
  const sW = stripImg.width;
  const sH = stripImg.height;
  const labelH = 30;
  const canvas = document.createElement("canvas");
  canvas.width = mW;
  canvas.height = mH + labelH + sH;
  const ctx = canvas.getContext("2d");

  const mCanvas = document.createElement("canvas");
  mCanvas.width = mW;
  mCanvas.height = mH;
  mCanvas.getContext("2d").putImageData(mainImg, 0, 0);
  ctx.drawImage(mCanvas, 0, 0);

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, mH, mW, labelH + sH);
  ctx.fillStyle = "#000";
  ctx.font = "bold 14px Arial";
  ctx.fillText("Click each icon on the TOP image in this order (left → right):", 10, mH + 18);

  const sCanvas = document.createElement("canvas");
  sCanvas.width = sW;
  sCanvas.height = sH;
  sCanvas.getContext("2d").putImageData(stripImg, 0, 0);
  ctx.drawImage(sCanvas, 10, mH + labelH + 2);

  const compositeB64 = canvas.toDataURL("image/jpeg", 0.92).split(",")[1];
  return {
    mainImg, stripImg, mW, mH, sW, sH, labelH, compositeB64,
    compositeKB: Math.round(compositeB64.length * 3 / 4 / 1024),
  };
}

const CLICK_LEAKED_EXAMPLE = new Set(["347,192", "195,180", "102,19"]);

/** Parse AI response: ```json``` block, [...] array, or scattered {"x":N,"y":M} objects. */
function _clickParseJsonArray(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      const p = JSON.parse(fenced[1].trim());
      if (Array.isArray(p)) return p;
    } catch (_) {}
  }
  const arrMatch = text.match(/\[[\s\S]*?\]/);
  if (arrMatch) {
    try {
      const p = JSON.parse(arrMatch[0]);
      if (Array.isArray(p)) return p;
    } catch (_) {}
  }
  const objs = [...text.matchAll(/\{\s*"x"\s*:\s*(\d+)\s*,\s*"y"\s*:\s*(\d+)\s*\}/g)];
  if (objs.length >= 3) return objs.map(m => ({ x: +m[1], y: +m[2] }));
  return null;
}

function _clickHasNearDuplicates(coords, minDistPx = NCC_NEAR_DUP_PX) {
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

function _clickAxisMaxFreq(arr) {
  const m = {};
  for (const v of arr) m[v] = (m[v] || 0) + 1;
  return Math.max(...Object.values(m));
}

function _clickClusterScore(coords, iconCount) {
  const xs = coords.map(c => c.x);
  const ys = coords.map(c => c.y);
  const uniqX = new Set(xs).size;
  const uniqY = new Set(ys).size;
  return (iconCount - uniqX) * 10 + (iconCount - uniqY) * 10
    + _clickAxisMaxFreq(xs) + _clickAxisMaxFreq(ys);
}

function _clickRejectGridSnap(coords, iconCount) {
  const xs = coords.map(c => c.x);
  const ys = coords.map(c => c.y);
  const uniqX = new Set(xs).size;
  const uniqY = new Set(ys).size;
  const maxFx = _clickAxisMaxFreq(xs);
  const maxFy = _clickAxisMaxFreq(ys);
  if (uniqX <= 2 || uniqY <= 2) throw new Error("grid snap: too few unique axes");
  if (maxFx >= 3 || maxFy >= 3) throw new Error("grid snap: axis cluster");
  // 5 icons but only 3 distinct y (e.g. y=33×2, y=192×2) — Claude v4.8.6
  if (iconCount >= 4 && (uniqX < iconCount - 1 || uniqY < iconCount - 1)) {
    throw new Error(`axis cluster: uniq x=${uniqX} y=${uniqY} need ≥${iconCount - 1}`);
  }
  if (maxFx >= 2 && maxFy >= 2) throw new Error("axis cluster: dual axis repeat");
  const roundBoth = coords.filter(c => c.x % 10 === 0 && c.y % 10 === 0).length;
  if (roundBoth >= Math.ceil(iconCount * 0.6)) throw new Error("grid snap: round deciles");
}

function _clickValidateCoords(raw, mW, mH, iconCount) {
  if (!Array.isArray(raw) || raw.length < iconCount || raw[0]?.x === undefined) {
    throw new Error(`need ${iconCount} points with x,y`);
  }
  const coords = raw.slice(0, iconCount).map(p => ({
    x: Math.round(Number(p.x)),
    y: Math.round(Number(p.y)),
  }));
  for (let i = 0; i < coords.length; i++) {
    const { x, y } = coords[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`point ${i + 1} not numeric`);
    if (x < 0 || x >= mW || y < 0 || y >= mH) throw new Error(`point ${i + 1} out of bounds (${x},${y})`);
    if (CLICK_LEAKED_EXAMPLE.has(`${x},${y}`)) throw new Error("leaked example coords");
  }
  for (let i = 0; i < coords.length; i++) {
    for (let j = i + 1; j < coords.length; j++) {
      const dx = coords[i].x - coords[j].x;
      const dy = coords[i].y - coords[j].y;
      if (dx * dx + dy * dy < 64) throw new Error("duplicate/near-duplicate points");
    }
  }
  _clickRejectGridSnap(coords, iconCount);
  return coords;
}

async function solveClickCaptcha(captchaData, workers = 5) {
  const front = captchaData.front;
  if (!front?.imageBase64 || !front?.iconsBase64) return null;

  console.log(`[EPD CLICK] RuCaptcha ${workers}x workers (poll ${CLICK_POLL_INITIAL_MS}/${CLICK_POLL_INTERVAL_MS}ms)`);

  const t0 = Date.now();
  const comp = await _buildClickComposite(front);
  if (!comp) { console.log("[EPD CLICK] ❌ Failed to decode"); return null; }

  const { mW, mH, compositeB64, compositeKB } = comp;
  console.log(`[EPD CLICK] Composite: ${mW}×${mH}+strip, ~${compositeKB}KB`);

  // ── Submit the SAME image to N workers in parallel (with timeout + retry) ──
  // background.js (MV3 service worker) может «уснуть» во время fetch — поэтому
  // ставим таймаут на каждое сообщение и логируем причину ошибки RuCaptcha.
  function submitOne(w) {
    return new Promise((resolve) => {
      let settled = false;
      const to = setTimeout(() => { if (!settled) { settled = true; resolve({ error: "timeout 18s" }); } }, 18_000);
      chrome.runtime.sendMessage(
        { action: "solve-click-captcha", b64: compositeB64, imgW: mW, imgH: mH, workerNum: w },
        (r) => {
          if (settled) return; settled = true; clearTimeout(to);
          if (chrome.runtime.lastError) { resolve({ error: "port: " + chrome.runtime.lastError.message }); return; }
          resolve(r || { error: "empty" });
        }
      );
    });
  }
  async function submitBatch() {
    return Promise.all(Array.from({ length: workers }, (_, w) => submitOne(w)));
  }

  let results = await submitBatch();
  let tasks = results.filter(t => t?.taskId);
  if (!tasks.length) {
    const reasons = results.map(r => r?.error || "null").join("; ");
    console.log(`[EPD CLICK] ⚠️ submit failed (${Date.now() - t0}мс), причины: ${reasons} — повтор через 1с`);
    await sleep(1000);
    results = await submitBatch();
    tasks = results.filter(t => t?.taskId);
  }
  if (!tasks.length) {
    console.log(`[EPD CLICK] ❌ Все воркеры: submit failed | ${results.map(r => r?.error || "null").join("; ")}`);
    return null;
  }
  console.log(`[EPD CLICK] ✅ ${tasks.length} воркеров отправлено за ${Date.now() - t0}мс: ${tasks.map(t => t.taskId).join(", ")}`);

  // ── Poll ALL tasks, FIRST valid answer wins ──────────────────────────────
  // Budget 35s: the captcha token expires at ~40s, no point polling beyond that.
  const done = new Array(tasks.length).fill(false);
  await sleep(CLICK_POLL_INITIAL_MS);

  for (let attempt = 0; attempt < 50; attempt++) {
    if (Date.now() - t0 > 35_000) break;

    const pollPromises = tasks.map((task, idx) => {
      if (done[idx]) return Promise.resolve(null);
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "poll-click-captcha", taskId: task.taskId }, (r) => {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve({ idx, r });
        });
      });
    });
    const results = await Promise.all(pollPromises);

    for (const res of results) {
      if (!res) continue;
      const { idx, r } = res;
      if (r?.status === "ready" && r.coords?.length) {
        console.log(`[EPD CLICK] ✅ Воркер #${idx + 1} ответил ПЕРВЫМ за ${Date.now() - t0}мс: ${JSON.stringify(r.coords)}`);
        return r.coords.map(p => ({ x: Math.round(Number(p.x)), y: Math.round(Number(p.y)) }));
      }
      if (r?.status === "error") {
        done[idx] = true;
        console.log(`[EPD CLICK] ⚠️ Воркер #${idx + 1} error: ${r.error}`);
      }
    }

    if (done.every(Boolean)) { console.log("[EPD CLICK] ❌ Все воркеры вернули ошибку"); return null; }
    await sleep(CLICK_POLL_INTERVAL_MS);
  }
  console.log(`[EPD CLICK] ❌ RuCaptcha timeout (${Date.now() - t0}мс)`);
  return null;
}

async function _solveClickAI(front, signal) {
  const comp = await _buildClickComposite(front);
  if (!comp) return null;

  const { mW, mH, compositeB64, compositeKB, stripImg } = comp;
  const iconCount = _detectIconCount(_toGrayClick(stripImg), stripImg);

  const prompt = `Click captcha. One composite image attached.

LAYOUT:
- TOP region (${mW}×${mH}px): the clickable field. Semi-transparent colored icons on a pastel background (~40–60px each).
- BOTTOM strip: ${iconCount} icons showing the EXACT click order (left → right).

COORDINATE SYSTEM (CRITICAL):
- Origin top-left of the TOP region ONLY — ignore the bottom strip when measuring y.
- x: 0..${mW - 1}, y: 0..${mH - 1}. Every y MUST satisfy y ≤ ${mH - 1}.
- The bottom strip starts below y=${mH}; clicks there are INVALID.

TASK:
For strip icon #1, #2, … #${iconCount}, find the pixel CENTER of that same icon on the TOP region.

Rules:
- Return exactly ${iconCount} points in strip order.
- Each point must hit a different icon (unique centers, not grid guesses).
- Use precise integers — avoid snapping to multiples of 10/20/50 unless exact.
- Analyze the image; do not invent or copy placeholder numbers.

Output: ONLY a JSON array, no markdown:
[{"x":NUMBER,"y":NUMBER}, ...]`;

  console.log(`[EPD CLICK:AI] composite ${mW}×${mH}+strip ~${compositeKB}KB, ${iconCount} icons — Claude`);

  const models = ["claude-sonnet-4.5"];

  async function tryModel(model) {
    const t0 = Date.now();
    const resp = await fetch(AITUNNEL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${AITUNNEL_KEY}` },
      signal,
      body: JSON.stringify({
        model, messages: [{ role: "user", content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${compositeB64}` } },
        ]}], max_tokens: 300, temperature: 0,
      }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const text = (data.choices?.[0]?.message?.content || "").trim();
    const cost = data.usage?.cost_rub || '?';
    const ms = Date.now() - t0;
    const raw = _clickParseJsonArray(text);
    if (!raw) {
      console.log(`[EPD CLICK:AI] ${model} raw: ${text.slice(0, 200).replace(/\s+/g, " ")}`);
      throw new Error("no JSON array");
    }
    const coords = _clickValidateCoords(raw, mW, mH, iconCount);
    const score = _clickClusterScore(coords, iconCount);
    console.log(`[EPD CLICK:AI] ${model} за ${ms}мс (${cost}₽) ✅ ${coords.length} pts, score=${score}`);
    return { coords, model, ms, cost, score };
  }

  return new Promise((resolve) => {
    let pending = models.length;
    let finished = false;
    const valid = [];

    const finish = () => {
      if (finished) return;
      finished = true;
      if (!valid.length) {
        resolve(null);
        return;
      }
      valid.sort((a, b) => {
        if (a.score !== b.score) return a.score - b.score;
        const aClaude = a.model.includes("claude") ? 0 : 1;
        const bClaude = b.model.includes("claude") ? 0 : 1;
        if (aClaude !== bClaude) return aClaude - bClaude;
        return a.ms - b.ms;
      });
      const best = valid[0];
      console.log(`[EPD CLICK:AI] 🏁 picked ${best.model} score=${best.score} (${valid.length} valid)`);
      resolve(best.coords);
    };

    for (const model of models) {
      tryModel(model).then((r) => {
        valid.push(r);
      }).catch((e) => {
        if (e.name === "AbortError") return;
        console.log(`[EPD CLICK:AI] ${model}: ${e.message}`);
      }).finally(() => {
        if (--pending === 0) finish();
      });
    }
  });
}

// ---------------------------------------------------------------------------
//  AITUNNEL Triple AI — 3 модели параллельно для PUZZLE captcha
//  Gemini 2.5 Flash (~1-2с, дешёвый) + Claude Sonnet 4.5 (~3-5с, умный) + GPT-4o (~3-5с)
//  Вероятность что все 3 ошибутся: ~1.5%
// ---------------------------------------------------------------------------

const AITUNNEL_MODELS = [
  { id: "gemini-2.5-flash", name: "Gemini Flash", speed: "~1-2с", price: "~0.08₽" },
  { id: "claude-sonnet-4.5", name: "Claude Sonnet", speed: "~3-5с", price: "~1₽" },
  { id: "gpt-4o", name: "GPT-4o", speed: "~3-5с", price: "~0.5₽" },
];

async function _callAITunnel(model, b64Image, n, allVariants) {
  const prompt = `You see ${n} numbered puzzle variants (labeled 1-${n}). Each shows 9 tiles in a 3x3 grid.

ALL variants have slight JPEG compression artifacts at tile borders — ignore those.

Your task: find the ONE variant where the IMAGE CONTENT matches across tile borders. In the correct variant, adjacent tiles show the SAME scene continuing (same sky color, same road, same building, etc.). In wrong variants, tiles from DIFFERENT parts of the photo are placed next to each other, creating obvious scene discontinuities.

Look at what's DEPICTED in adjacent tiles, not pixel-level compression artifacts.

IMPORTANT: Reply with ONLY a single number (1-${n}). No explanation, no reasoning, just the number.`;

  const modelInfo = AITUNNEL_MODELS.find(m => m.id === model) || { name: model };
  const startMs = Date.now();

  try {
    const resp = await fetch(AITUNNEL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${AITUNNEL_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64Image}` } },
          ],
        }],
        max_tokens: 50,
        temperature: 0,
      }),
    });

    const elapsed = Date.now() - startMs;

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.log(`[EPD AI:${modelInfo.name}] ❌ HTTP ${resp.status} за ${elapsed}мс: ${errText.slice(0, 200)}`);
      return null;
    }

    const data = await resp.json();
    const text = (data.choices?.[0]?.message?.content || "").trim();
    const cost = data.usage?.cost_rub || '?';
    const balance = data.usage?.balance || '?';
    const tokIn = data.usage?.prompt_tokens || '?';
    const tokOut = data.usage?.completion_tokens || '?';

    console.log(`[EPD AI:${modelInfo.name}] Ответ за ${elapsed}мс: "${text}" | ${tokIn}→${tokOut} tok | ${cost} ₽ | баланс: ${balance} ₽`);

    const nums = text.match(/\d+/g);
    if (nums) {
      const idx = parseInt(nums[nums.length - 1]) - 1;
      if (idx >= 0 && idx < allVariants.length) {
        return { answer: allVariants[idx], idx, model: modelInfo.name, elapsed, cost };
      }
    }
    console.log(`[EPD AI:${modelInfo.name}] ⚠️ Не удалось извлечь номер из: "${text}"`);
  } catch (e) {
    console.error(`[EPD AI:${modelInfo.name}] ❌ Error за ${Date.now()-startMs}мс: ${e.message}`);
  }
  return null;
}

async function solvePuzzleViaGemini(captchaData) {
  if (!AITUNNEL_KEY) return null;
  const allVariants = captchaData.puzzle?.variantsCapture || captchaData.variantsCapture || [];
  if (!allVariants.length) return null;

  const rendered = await _renderRuCaptchaImage(captchaData, 15);
  if (!rendered) return null;

  const n = rendered.count;
  const imgKB = Math.round(rendered.b64.length * 3 / 4 / 1024);

  console.log(`[EPD AITUNNEL] RACE: ${AITUNNEL_MODELS.map(m => m.name).join(" | ")} | ${imgKB}KB, ${n} variants`);

  const tripleStart = Date.now();
  const promises = AITUNNEL_MODELS.map(m =>
    _callAITunnel(m.id, rendered.b64, n, allVariants).then(r => r ? { ...r, modelName: m.name } : null)
  );

  const winner = await new Promise((resolve) => {
    let settled = false;
    let pending = promises.length;
    for (const p of promises) {
      p.then((r) => {
        if (!settled && r) {
          settled = true;
          console.log(`[EPD AITUNNEL] 🏁 Race winner: ${r.model} → variant ${r.idx + 1} (${r.elapsed}мс)`);
          resolve(r);
        }
        if (--pending === 0 && !settled) resolve(null);
      });
    }
    setTimeout(() => { if (!settled) resolve(null); }, 15_000);
  });

  const totalMs = Date.now() - tripleStart;
  if (!winner) {
    console.log(`[EPD AITUNNEL] └─ ❌ Race timeout (${totalMs}мс)`);
    return null;
  }
  console.log(`[EPD AITUNNEL] └─ ✅ ${winner.modelName}: variant ${winner.idx + 1} (${totalMs}мс total)`);
  return winner.answer;
}

// ---------------------------------------------------------------------------
//  HolySheep AI — GPT-4o/Claude Vision, 2-4 seconds, ~90% accuracy
//  https://www.holysheep.ai
// ---------------------------------------------------------------------------

const HOLYSHEEP_KEY = "sk_a1fbf3d08b9378d2e1f547c2a0a29ad6d1e2cecb55988317ffe139d0bdd190c2";
const HOLYSHEEP_URL = "https://api.holysheep.ai/v1/chat/completions";

async function solvePuzzleViaHolySheep(captchaData) {
  if (!HOLYSHEEP_KEY) return null;
  const allVariants = captchaData.puzzle?.variantsCapture || captchaData.variantsCapture || [];
  if (!allVariants.length) return null;

  console.log("[EPD HolySheep] Rendering image...");
  const rendered = await _renderRuCaptchaImage(captchaData, 15);
  if (!rendered) return null;

  const n = rendered.count;
  const prompt = `Image shows ${n} numbered puzzle variants (1-${n}). Each has 9 tiles in 3x3 grid. ` +
    `EXACTLY ONE variant is correctly assembled (seamless coherent photograph). ` +
    `Others have visible mismatches at tile borders. ` +
    `Reply with ONLY the single number (1-${n}) of the correct variant.`;

  try {
    console.log("[EPD HolySheep] Calling API...");
    const resp = await fetch(HOLYSHEEP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${HOLYSHEEP_KEY}`,
      },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${rendered.b64}` } },
          ],
        }],
        max_tokens: 20,
      }),
    });

    if (!resp.ok) {
      console.log(`[EPD HolySheep] HTTP ${resp.status}`);
      return null;
    }

    const data = await resp.json();
    const text = (data.choices?.[0]?.message?.content || "").trim();
    console.log(`[EPD HolySheep] Answer: "${text}"`);
    const nums = text.match(/\d+/g);
    if (nums) {
      const idx = parseInt(nums[nums.length - 1]) - 1;
      if (idx >= 0 && idx < allVariants.length) {
        console.log(`[EPD HolySheep] ✅ Chose variant ${idx + 1}`);
        return allVariants[idx];
      }
    }
  } catch (e) {
    console.error("[EPD HolySheep] Error:", e.message);
  }
  return null;
}

async function solvePuzzleViaAntiCaptcha(captchaData) {
  if (!ANTICAPTCHA_KEY) return null;

  const allVariants = captchaData.puzzle?.variantsCapture || captchaData.variantsCapture || [];
  if (!allVariants.length) return null;

  console.log("[EPD AntiCaptcha] Rendering image...");
  const rendered = await _renderRuCaptchaImage(captchaData, 15);
  if (!rendered) return null;

  const n = rendered.count;

  try {
    console.log("[EPD AntiCaptcha] Creating task...");
    const createResp = await fetch("https://api.anti-captcha.com/createTask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: ANTICAPTCHA_KEY,
        task: {
          type: "ImageToTextTask",
          body: rendered.b64,
          comment: `На картинке ${n} пронумерованных пазлов (1-${n}). В каждом 9 плиток 3x3. Красные линии — границы. ТОЛЬКО ОДИН собран правильно (цельное фото). Ответьте ОДНОЙ цифрой (1-${n}).`,
          languagePool: "rn",
          numeric: 1,
          minLength: 1,
          maxLength: 2,
        },
      }),
    });
    const createData = await createResp.json();

    if (createData.errorId) {
      console.log("[EPD AntiCaptcha] Create error:", createData.errorDescription);
      return null;
    }

    const taskId = createData.taskId;
    console.log(`[EPD AntiCaptcha] Task ${taskId}, polling...`);

    // Aggressive polling: 3s first, then every 2s
    for (let i = 0; i < 20; i++) {
      await sleep(i === 0 ? 3000 : 2000);
      try {
        const pollResp = await fetch("https://api.anti-captcha.com/getTaskResult", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientKey: ANTICAPTCHA_KEY, taskId }),
        });
        const pollData = await pollResp.json();

        if (pollData.status === "ready" && pollData.solution?.text) {
          const text = pollData.solution.text.trim();
          console.log(`[EPD AntiCaptcha] Answer: "${text}"`);
          const nums = text.match(/\d+/g);
          if (nums) {
            const idx = parseInt(nums[nums.length - 1]) - 1;
            if (idx >= 0 && idx < allVariants.length) {
              console.log(`[EPD AntiCaptcha] Chose variant ${idx + 1}`);
              return allVariants[idx];
            }
          }
          return null;
        }
        if (pollData.errorId) {
          console.log("[EPD AntiCaptcha] Error:", pollData.errorDescription);
          return null;
        }
      } catch (e) { console.warn("[EPD AntiCaptcha] Poll error:", e.message); }
    }
    console.log("[EPD AntiCaptcha] Timed out");
  } catch (e) {
    console.error("[EPD AntiCaptcha] Error:", e.message);
  }
  return null;
}

async function solvePuzzleViaCapSolver(captchaData) {
  if (!CAPSOLVER_KEY) return null;

  const allVariants = captchaData.puzzle?.variantsCapture || captchaData.variantsCapture || [];
  if (!allVariants.length) return null;

  console.log("[EPD CapSolver] Rendering image...");
  const rendered = await _renderRuCaptchaImage(captchaData, 15);
  if (!rendered) return null;

  const n = rendered.count;
  const prompt =
    `Image shows ${n} numbered puzzle variants (1-${n}). ` +
    `Each has 9 tiles in a 3x3 grid. Red lines mark tile borders. ` +
    `ONE variant has seamless borders forming a coherent photo. ` +
    `Reply with ONLY the number (1-${n}).`;

  try {
    console.log("[EPD CapSolver] Submitting task...");
    const createResp = await fetch("https://api.capsolver.com/createTask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: CAPSOLVER_KEY,
        task: {
          type: "ImageToTextTask",
          body: rendered.b64,
          module: "common",
          question: prompt,
        },
      }),
    });
    const createData = await createResp.json();

    if (createData.errorId) {
      console.log("[EPD CapSolver] Create error:", createData.errorDescription);
      return null;
    }

    const taskId = createData.taskId;
    if (!taskId) {
      // Some tasks return solution immediately
      if (createData.solution?.text) {
        const nums = createData.solution.text.match(/\d+/g);
        if (nums) {
          const idx = parseInt(nums[nums.length - 1]) - 1;
          if (idx >= 0 && idx < allVariants.length) {
            console.log(`[EPD CapSolver] Instant answer: variant ${idx + 1}`);
            return allVariants[idx];
          }
        }
      }
      console.log("[EPD CapSolver] No taskId, no solution");
      return null;
    }

    // Poll for result
    console.log(`[EPD CapSolver] Task ${taskId}, polling...`);
    for (let i = 0; i < 15; i++) {
      await sleep(i === 0 ? 2000 : 1500);
      try {
        const pollResp = await fetch("https://api.capsolver.com/getTaskResult", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientKey: CAPSOLVER_KEY, taskId }),
        });
        const pollData = await pollResp.json();

        if (pollData.status === "ready" && pollData.solution?.text) {
          const text = pollData.solution.text.trim();
          console.log(`[EPD CapSolver] Answer: "${text}"`);
          const nums = text.match(/\d+/g);
          if (nums) {
            const idx = parseInt(nums[nums.length - 1]) - 1;
            if (idx >= 0 && idx < allVariants.length) {
              console.log(`[EPD CapSolver] Chose variant ${idx + 1}`);
              return allVariants[idx];
            }
          }
          return null;
        }
        if (pollData.errorId) {
          console.log("[EPD CapSolver] Poll error:", pollData.errorDescription);
          return null;
        }
      } catch (e) { console.warn("[EPD CapSolver] Poll error:", e.message); }
    }
    console.log("[EPD CapSolver] Timed out");
  } catch (e) {
    console.error("[EPD CapSolver] Error:", e.message);
  }
  return null;
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
//  RuCaptcha — Majority Vote: send same image to 3 workers, take consensus
//  If 2/3 agree → ~99% correct. Uses the full 15-variant image.
// ---------------------------------------------------------------------------

async function solvePuzzleViaRuCaptcha(captchaData) {
  if (!chrome?.runtime?.sendMessage) return null;
  const allVariants = captchaData.puzzle?.variantsCapture || captchaData.variantsCapture || [];
  if (!allVariants.length) return null;

  console.log("[EPD RuCaptcha] Rendering image...");
  const rendered = await _renderRuCaptchaImage(captchaData, 15);
  if (!rendered) return null;
  console.log(`[EPD RuCaptcha] Image ~${Math.round(rendered.b64.length*3/4/1024)}KB, submitting 3 workers...`);

  // Submit to 3 workers simultaneously
  const WORKERS = 3;
  const submitPromises = [];
  for (let w = 0; w < WORKERS; w++) {
    submitPromises.push(new Promise(resolve => {
      chrome.runtime.sendMessage(
        { action: "solve-one-numbered", b64: rendered.b64, variantCount: rendered.count, workerNum: w },
        (answer) => {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(answer);
        }
      );
    }));
  }
  const tasks = (await Promise.all(submitPromises)).filter(Boolean);
  console.log(`[EPD RuCaptcha] ${tasks.length} tasks submitted:`, tasks.map(t => t.taskId).join(", "));
  if (!tasks.length) return null;

  // Poll loop in CONTENT SCRIPT (not background — MV3 kills SW during setTimeout)
  const answers = new Array(tasks.length).fill(null);
  const done = new Array(tasks.length).fill(false);
  const startTime = Date.now();

  await sleep(PUZZLE_POLL_INITIAL_MS);

  for (let attempt = 0; attempt < 40; attempt++) {
    if (Date.now() - startTime > 30_000) break;

    // Poll all pending tasks
    const pollPromises = tasks.map((task, idx) => {
      if (done[idx]) return Promise.resolve();
      return new Promise(resolve => {
        chrome.runtime.sendMessage({ action: "poll-one-check", taskId: task.taskId }, (resp) => {
          if (chrome.runtime.lastError) {
            console.log(`[EPD RuCaptcha] Poll error w${task.workerNum}:`, chrome.runtime.lastError.message);
            resolve();
            return;
          }
          if (resp?.status === "done") {
            done[idx] = true;
            answers[idx] = resp.variant ?? -1;
            console.log(`[EPD RuCaptcha] Worker ${task.workerNum}: variant=${resp.variant >= 0 ? resp.variant + 1 : "invalid"} raw="${resp.raw || ""}" err=${resp.error || ""}`);
          } else if (resp?.status === "pending") {
            // still solving, will check again
          } else {
            console.log(`[EPD RuCaptcha] Worker ${task.workerNum}: unexpected resp:`, JSON.stringify(resp));
          }
          resolve();
        });
      });
    });

    await Promise.all(pollPromises);

    // Check majority vote
    const votes = {};
    for (const a of answers) {
      if (a !== null && typeof a === "number" && a >= 0 && a < allVariants.length) {
        votes[a] = (votes[a] || 0) + 1;
        if (votes[a] >= 2) {
          console.log(`[EPD RuCaptcha] ✅ MAJORITY: variant ${a + 1} (${votes[a]} votes, ${((Date.now()-startTime)/1000).toFixed(1)}s)`);
          return allVariants[a];
        }
      }
    }

    // All workers done?
    if (done.every(Boolean)) {
      const best = answers.find(a => typeof a === "number" && a >= 0 && a < allVariants.length);
      if (best !== undefined) {
        console.log(`[EPD RuCaptcha] ⚠️ No majority, using: variant ${best + 1}`);
        return allVariants[best];
      }
      console.log("[EPD RuCaptcha] ❌ All workers done, no valid answer");
      return null;
    }

    await sleep(PUZZLE_POLL_INTERVAL_MS);
  }

  // Timeout fallback
  console.log("[EPD RuCaptcha] Final answers:", JSON.stringify(answers), "done:", JSON.stringify(done));
  const best = answers.find(a => typeof a === "number" && a >= 0 && a < allVariants.length);
  if (best !== undefined) {
    console.log(`[EPD RuCaptcha] ⏰ Timeout, using best: variant ${best + 1}`);
    return allVariants[best];
  }
  console.log("[EPD RuCaptcha] ⏰ Timeout, no answer");
  return null;
}

// ---------------------------------------------------------------------------
//  Master solver — edge matching + optional parallel RuCaptcha
//
//  Strategy:
//    1. Edge matching runs immediately (instant).
//    2. If confidence ≥ CONF_THRESHOLD → trust edge match alone.
//    3. If confidence < CONF_THRESHOLD → launch RuCaptcha IN PARALLEL so
//       it completes while we are still trying EM top-2 variants.
//       The caller can await result.rcPromise when EM variants fail.
//    4. If edge matching fails entirely → await RuCaptcha fully.
// ---------------------------------------------------------------------------

const CONF_THRESHOLD = 0.30;

// ---------------------------------------------------------------------------
//  Tile Cache v2 — Perceptual dHash (JPEG-robust)
//  
//  Problem with v1: base64 slices change every time server re-encodes JPEG.
//  Solution: decode to pixels via Canvas → compute dHash (gradient-based).
//  dHash survives JPEG recompression with only 0-3 bit drift.
//  Uses fuzzy Hamming distance matching (threshold ≤ 5 bits).
// ---------------------------------------------------------------------------

const _tileCacheMemory = {}; // fp → position (exact)
const _tileCacheHashes = []; // [{hash, colorR, colorG, colorB, pos}] for fuzzy
const _DHASH_THRESHOLD = 5;
const _COLOR_TOL = 30;

function _tileToPixelsSync(base64Jpeg) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 9; canvas.height = 8;
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(img, 0, 0, 9, 8);
        const small = ctx.getImageData(0, 0, 9, 8).data;

        const canvas2 = document.createElement("canvas");
        canvas2.width = 8; canvas2.height = 8;
        const ctx2 = canvas2.getContext("2d");
        ctx2.drawImage(img, 0, 0, 8, 8);
        const color = ctx2.getImageData(0, 0, 8, 8).data;

        resolve({ small, color });
      } catch (_) { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = "data:image/jpeg;base64," + base64Jpeg;
  });
}

function _computeDHash(rgba9x8) {
  let hash = "";
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i1 = (y * 9 + x) * 4;
      const i2 = (y * 9 + x + 1) * 4;
      const lum1 = rgba9x8[i1] * 0.299 + rgba9x8[i1+1] * 0.587 + rgba9x8[i1+2] * 0.114;
      const lum2 = rgba9x8[i2] * 0.299 + rgba9x8[i2+1] * 0.587 + rgba9x8[i2+2] * 0.114;
      hash += lum1 > lum2 ? "1" : "0";
    }
  }
  return hash;
}

function _avgColor(rgba8x8) {
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < 64; i++) {
    r += rgba8x8[i*4]; g += rgba8x8[i*4+1]; b += rgba8x8[i*4+2];
  }
  return { r: Math.round(r/64), g: Math.round(g/64), b: Math.round(b/64) };
}

function _hammingDist(h1, h2) {
  let d = 0;
  for (let i = 0; i < 64; i++) if (h1[i] !== h2[i]) d++;
  return d;
}

function _hashToHex(bin) {
  let hex = "";
  for (let i = 0; i < bin.length; i += 4)
    hex += parseInt(bin.slice(i, i + 4), 2).toString(16);
  return hex;
}

async function _tileFingerprint(imageData) {
  const pixels = await _tileToPixelsSync(imageData);
  if (!pixels) return null;
  const hash = _computeDHash(pixels.small);
  const color = _avgColor(pixels.color);
  const hex = _hashToHex(hash);
  return { hash, hex, color, fp: `${hex}_${color.r>>4}_${color.g>>4}_${color.b>>4}` };
}

async function _tileCacheSave(puzzle, correctVariant) {
  if (!puzzle?.tiles || !correctVariant?.length) return;
  const updates = {};
  let saved = 0;
  for (let pos = 0; pos < correctVariant.length; pos++) {
    const tileId = correctVariant[pos];
    const tile = puzzle.tiles.find(t => t.tileId === tileId);
    if (!tile?.imageData) continue;
    const fp = await _tileFingerprint(tile.imageData);
    if (!fp) continue;
    _tileCacheMemory[fp.fp] = pos;
    _tileCacheHashes.push({ hash: fp.hash, r: fp.color.r, g: fp.color.g, b: fp.color.b, pos });
    updates[`tc2_${fp.hex}`] = { pos, r: fp.color.r, g: fp.color.g, b: fp.color.b };
    saved++;
  }
  if (saved > 0) {
    try {
      await chrome.storage.local.set(updates);
      console.log(`[EPD Cache] ✅ Saved ${saved} dHash fingerprints (total: ${_tileCacheHashes.length})`);
    } catch (e) { console.warn("[EPD Cache] Save error:", e.message); }
  }
}

async function _tileCacheLoad() {
  try {
    const all = await chrome.storage.local.get(null);
    let count = 0;
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith("tc2_") && typeof v === 'object') {
        let hash = "";
        const hex = k.slice(4);
        for (let i = 0; i < hex.length; i++)
          hash += parseInt(hex[i], 16).toString(2).padStart(4, "0");
        _tileCacheHashes.push({ hash, r: v.r, g: v.g, b: v.b, pos: v.pos });
        const fp = `${hex}_${v.r>>4}_${v.g>>4}_${v.b>>4}`;
        _tileCacheMemory[fp] = v.pos;
        count++;
      }
    }
    if (count > 0) console.log(`[EPD Cache] Loaded ${count} dHash fingerprints`);
  } catch (e) { console.warn("[EPD Cache] Load error:", e.message); }
}

async function _tileCacheSolve(captchaData) {
  const puzzle = captchaData.puzzle;
  const variants = puzzle?.variantsCapture || captchaData.variantsCapture;
  if (!puzzle?.tiles || !variants?.length) return null;
  if (_tileCacheHashes.length === 0) return null;

  const knownPositions = {};
  let knownCount = 0;

  for (const tile of puzzle.tiles) {
    if (!tile.imageData) continue;
    const fp = await _tileFingerprint(tile.imageData);
    if (!fp) continue;

    // Exact match
    if (_tileCacheMemory[fp.fp] !== undefined) {
      knownPositions[tile.tileId] = _tileCacheMemory[fp.fp];
      knownCount++;
      continue;
    }

    // Fuzzy dHash match
    let bestDist = 999, bestPos = -1;
    for (const cached of _tileCacheHashes) {
      const dist = _hammingDist(fp.hash, cached.hash);
      if (dist <= _DHASH_THRESHOLD) {
        const cDist = Math.max(Math.abs(fp.color.r - cached.r), Math.abs(fp.color.g - cached.g), Math.abs(fp.color.b - cached.b));
        if (cDist <= _COLOR_TOL && dist < bestDist) {
          bestDist = dist;
          bestPos = cached.pos;
        }
      }
    }
    if (bestPos >= 0) {
      knownPositions[tile.tileId] = bestPos;
      knownCount++;
    }
  }

  console.log(`[EPD Cache] Lookup: ${knownCount}/9 tiles matched (dHash fuzzy, threshold=${_DHASH_THRESHOLD})`);
  if (knownCount < 4) return null;

  let bestVariant = null, bestMatch = 0, bestIdx = -1;
  for (let vi = 0; vi < variants.length; vi++) {
    const v = variants[vi];
    let matches = 0;
    for (let pos = 0; pos < v.length; pos++) {
      if (knownPositions[v[pos]] === pos) matches++;
    }
    if (matches > bestMatch) { bestMatch = matches; bestVariant = v; bestIdx = vi; }
  }

  if (bestMatch >= 4) {
    console.log(`[EPD Cache] 🎯 HIT! Variant ${bestIdx} matches ${bestMatch}/9 positions`);
    return { variant: bestVariant, idx: bestIdx, matches: bestMatch };
  }
  return null;
}

// Load cache on script start
_tileCacheLoad();

// ---------------------------------------------------------------------------
//  Master solver — EM + RuCaptcha launched IN PARALLEL
//
//  Solver 1 (EM):       instant, free
//  Solver 2 (RuCaptcha): ~10-30 seconds, paid, ~93% accurate
//
//  Returns { ranked, confidence, ruPromise }
//  Callers use phased approach:
//    Phase A → try EM#1 immediately
//    Phase B → await ruPromise → try RuCaptcha answer
//    Phase C → new captcha token (if all fail)
// ---------------------------------------------------------------------------

async function solvePuzzle(captchaData, opts = {}) {
  const skipRu = !!opts.skipRuCaptcha;
  const skipAI = !!opts.skipAI;
  const edgeOnly = skipRu && skipAI;
  // Store for cache save on successful validate
  _lastCaptchaData = captchaData;

  // Layer 3: Check tile cache FIRST (instant, 100% accurate if hit)
  const cacheHit = await _tileCacheSolve(captchaData);
  if (cacheHit) {
    console.log(`[EPD] CACHE HIT! Variant ${cacheHit.idx} (${cacheHit.matches}/9 tiles matched)`);
    return {
      ranked: [{ idx: cacheHit.idx, score: 0, answer: cacheHit.variant }],
      confidence: 1.0, // 100% confident
      ruPromise: Promise.resolve(null), // no need for RuCaptcha
      fromCache: true,
      edgeMs: 0,
    };
  }

  if (edgeOnly) {
    console.log("[EPD] ═══ EdgeMatch only (test: no AI, no RuCaptcha) ═══");
  } else if (skipRu) {
    console.log("[EPD] ═══ CASCADE: EdgeMatch + AITUNNEL (test, RuCaptcha off) ═══");
  } else {
    console.log("[EPD] ═══ CASCADE: EdgeMatch + AITUNNEL Gemini + RuCaptcha ═══");
  }

  const edgeT0 = Date.now();
  const emPromise = solvePuzzleEdgeMatch(captchaData);
  const gemPromise = skipAI ? null : solvePuzzleViaGemini(captchaData);
  const ruPromise = skipRu ? null : solvePuzzleViaRuCaptcha(captchaData);

  const emResult = await emPromise;
  const edgeMs = Date.now() - edgeT0;
  const emConf = emResult?.confidence || 0;
  const emTop = emResult?.ranked?.[0];

  if (emConf > 0.25 && emTop) {
    console.log(`[EPD] EdgeMatch: conf=${(emConf*100).toFixed(1)}%, variant ${emTop.idx} (${edgeMs}мс)`);
  } else {
    console.log(`[EPD] EdgeMatch: conf=${(emConf*100).toFixed(1)}% — too low (${edgeMs}мс)`);
  }

  if (edgeOnly) {
    return {
      ranked:     emResult?.ranked || [],
      confidence: emConf,
      edgeMs,
      racePromise: Promise.resolve(null),
      ruPromise:   Promise.resolve(null),
      gemPromise:  Promise.resolve(null),
    };
  }

  const gemP = gemPromise ?? Promise.resolve(null);
  const ruP = ruPromise ?? Promise.resolve(null);

  // Race: Gemini (fastest AI) vs RuCaptcha (backup)
  const racePromise = skipRu
    ? Promise.race([
        gemP.then(a => a ? a : new Promise(() => {})).catch(() => new Promise(() => {})),
        sleep(45_000).then(() => null),
      ])
    : Promise.race([
        gemP.then(a => a ? a : new Promise(() => {})).catch(() => new Promise(() => {})),
        ruP.then(a => a ? a : new Promise(() => {})).catch(() => new Promise(() => {})),
        sleep(45_000).then(() => null),
      ]);

  return {
    ranked:     emResult?.ranked || [],
    confidence: emConf,
    edgeMs,
    racePromise,
    ruPromise: ruP,
    gemPromise: gemP,
  };
}

// ---------------------------------------------------------------------------
//  UI
// ---------------------------------------------------------------------------

function buildUI(container) {
  container.innerHTML = `
    <span id="epd2-toggle" class="epd2-toggle" title="EPD Helper v2">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <path d="M17.75 9.25C17.75 13.39 14.62 16.75 10.75 16.75C8.94 16.75
          7.28 16.03 6 14.75L7.5 13.25C8.48 14.23 9.77 14.75 11.25 14.75
          C13.65 14.75 15.75 12.8 15.75 9.75H13.75L17 6.5L20.25 9.75H17.75Z
          M6.25 10.75C6.25 6.61 9.38 3.25 13.25 3.25C15.06 3.25 16.72 4.03
          18 5.25L16.5 6.75C15.52 5.77 14.23 5.25 12.75 5.25C10.35 5.25
          8.25 7.2 8.25 10.25H10.25L7 13.5L3.75 10.25H6.25Z" fill="red"/>
      </svg>
    </span>
    <div id="epd2-panel" class="epd2-panel" style="display:none">
      <div style="font-size:9px;color:#888;margin-bottom:6px">v${EPD_BUILD}</div>
      <label>Дата:<input id="epd2-date" type="date"></label>
      <label>Время от:<input id="epd2-from" type="time"></label>
      <label>Время до:<input id="epd2-to"   type="time"></label>
      <label>Скорость проверки:
        <select id="epd2-speed">
          <option value="random" selected>🎲 Рандом (3-8с) — антиWAF</option>
          <option value="ultra">⚡ Ультра (3-7с)</option>
          <option value="fast">Быстро (15-30с)</option>
          <option value="normal">Нормально (45-90с)</option>
          <option value="safe">Безопасно (90-180с)</option>
          <option value="stealth">Невидимка (3-7 мин)</option>
          <option value="custom">Свой интервал...</option>
        </select>
      </label>
      <div id="epd2-custom-row" style="display:none">
        <label>Мин (сек):<input id="epd2-custom-min" type="number" min="1" max="600" value="30"></label>
        <label>Макс (сек):<input id="epd2-custom-max" type="number" min="1" max="600" value="60"></label>
      </div>
      <label>Задержка капчи (мс):<input id="epd2-captcha-delay" type="number"
             min="500" max="5000" step="100" value="1000"></label>
      <div id="epd2-status" class="epd2-status"></div>
      <button id="epd2-start" class="epd2-btn epd2-btn-start">Старт</button>
      <button id="epd2-stop"  class="epd2-btn epd2-btn-stop" style="display:none">Стоп</button>
      <button id="epd2-test"  class="epd2-btn" style="background:#555;margin-top:4px">Тест капчи</button>
      <button id="epd2-preview" class="epd2-btn" style="background:#1565c0;margin-top:4px">👁 Показать капчу</button>
      <button id="epd2-logs" class="epd2-btn" style="background:#333;margin-top:4px;font-size:11px">📋 Скачать логи</button>
      <button id="epd2-upload-logs" class="epd2-btn" style="background:#1b5e20;margin-top:4px;font-size:11px">📤 Отправить логи → smrtcrm</button>
    </div>
    <div id="epd2-captcha-overlay" class="epd2-captcha-overlay" style="display:none">
      <div id="epd2-captcha-box" class="epd2-captcha-box">
        <h3 id="epd2-captcha-title"></h3>
        <div id="epd2-preview-meta" class="epd2-preview-meta" style="display:none"></div>
        <img id="epd2-captcha-icons" class="epd2-label-icons" alt="icons">
        <canvas id="epd2-captcha-canvas" class="epd2-label-canvas"></canvas>
        <div id="epd2-label-hint" class="epd2-label-hint">Кликните по иконкам на поле слева направо</div>
        <div id="epd2-label-toolbar" class="epd2-label-toolbar">
          <button type="button" id="epd2-label-save" class="epd2-label-btn epd2-label-btn-save">Сохранить valid=true</button>
          <button type="button" id="epd2-label-validate" class="epd2-label-btn">Сохранить + validate</button>
          <button type="button" id="epd2-label-undo" class="epd2-label-btn">Отменить точку</button>
          <button type="button" id="epd2-label-clear" class="epd2-label-btn">Сбросить</button>
        </div>
        <span id="epd2-captcha-close" class="epd2-captcha-close">&times;</span>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
//  Основная логика
// ---------------------------------------------------------------------------

function tryInject() {
  const match = window.location.pathname.match(RESERVATION_PAGE_RE);
  if (!match) return;
  if (document.getElementById("epd2-root")) return;

  const reservationUuid = match[2];
  const root = document.createElement("div");
  root.id = "epd2-root";
  document.body.appendChild(root);
  buildUI(root);
  attachLogic(root, reservationUuid);
  console.log("[EPD Helper v2] Injected for", reservationUuid);
}

function cleanup() {
  const old = document.getElementById("epd2-root");
  if (old) old.remove();
}

function attachLogic(root, reservationUuid) {
  const $ = (sel) => root.querySelector(sel);
  const toggle = $("#epd2-toggle");
  const panel  = $("#epd2-panel");
  const btnStart = $("#epd2-start");
  const btnStop  = $("#epd2-stop");
  const statusEl = $("#epd2-status");
  const dateIn   = $("#epd2-date");
  const fromIn   = $("#epd2-from");
  const toIn     = $("#epd2-to");
  const captchaDelayIn = $("#epd2-captcha-delay");

  const captchaOverlay = $("#epd2-captcha-overlay");
  const captchaBox     = $("#epd2-captcha-box");
  const captchaTitle   = $("#epd2-captcha-title");
  const previewMeta    = $("#epd2-preview-meta");
  const captchaIcons   = $("#epd2-captcha-icons");
  const captchaCanvas  = $("#epd2-captcha-canvas");
  const captchaClose   = $("#epd2-captcha-close");
  const labelHint      = $("#epd2-label-hint");
  const labelSave      = $("#epd2-label-save");
  const labelValidate  = $("#epd2-label-validate");
  const labelUndo      = $("#epd2-label-undo");
  const labelClear     = $("#epd2-label-clear");
  const labelToolbar = $("#epd2-label-toolbar");

  let labelState = null;
  let previewMode = false;

  let notifSound = null;
  try {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
      notifSound = new Audio(chrome.runtime.getURL("sounds/notification.mp3"));
    }
  } catch {}

  let running = false;
  let testInProgress = false;
  let collectInProgress = false;
  let collectAbort = false;
  let abortCtrl = null;
  let reservation = null;
  let vehicle = null;
  let backoffMs = 0;
  let checkCount = 0;

  toggle.addEventListener("click", () => {
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  });

  btnStart.addEventListener("click", start);
  btnStop.addEventListener("click",  stop);
  $("#epd2-test").addEventListener("click", testCaptcha);
  $("#epd2-preview").addEventListener("click", previewCaptcha);
  $("#epd2-logs").addEventListener("click", () => _epdDownloadLogs("manual"));
  $("#epd2-upload-logs").addEventListener("click", async () => {
    status("Отправка логов на smrtcrm.ru…");
    const r = await _epdUploadLogs("manual", { promptForToken: true });
    if (r.ok) {
      status(`✅ Логи на smrtcrm${r.id ? ` #${r.id}` : ""}`);
    } else {
      status(`❌ Логи: ${r.error || r.status || "ошибка"}`);
    }
  });
  labelSave.addEventListener("click", () => _labelSave(false));
  labelValidate.addEventListener("click", () => _labelSave(true));
  labelUndo.addEventListener("click", _labelUndo);
  labelClear.addEventListener("click", _labelClearPoints);
  captchaCanvas.addEventListener("click", _labelOnCanvasClick);

  // Show/hide custom interval inputs
  const speedSelect = $("#epd2-speed");
  const customRow = $("#epd2-custom-row");
  speedSelect.addEventListener("change", () => {
    customRow.style.display = speedSelect.value === "custom" ? "block" : "none";
  });

  function status(msg) { statusEl.textContent = msg; }

  function _labelClose() {
    captchaOverlay.style.display = "none";
    labelHint.style.display = "none";
    labelToolbar.style.display = "none";
    previewMeta.style.display = "none";
    captchaBox.classList.remove("epd2-captcha-box--wide");
    captchaCanvas.classList.remove("epd2-preview-canvas");
    captchaIcons.style.display = "";
    labelState = null;
    previewMode = false;
    testInProgress = false;
  }

  function _previewMetaHtml(captchaData, captchaType, slotCaption) {
    const apiType = captchaData.front?.type ?? captchaData.puzzle?.type ?? "?";
    const token = captchaData.token?.slice(0, 18) || "?";
    if (captchaType === "click") {
      return `Тип: <b>click</b> (type ${apiType}) · token ${token}…<br>` +
        `Поле + полоска иконок. Кликать нужно слева направо по образцу снизу.<br>` +
        `Слот: ${slotCaption}`;
    }
    const tiles = captchaData.puzzle?.tiles?.length ?? 0;
    const variants = captchaData.puzzle?.variantsCapture?.length ?? 0;
    return `Тип: <b>puzzle</b> (type ${apiType}) · token ${token}…<br>` +
      `${tiles} тайлов, ${variants} вариантов (номера 1–${variants}). Выбрать один правильно собранный 3×3.<br>` +
      `Слот: ${slotCaption}`;
  }

  async function _previewShowClick(captchaData, slotCaption, captchaType) {
    const front = captchaData.front;
    const img = await _decodeImg(front.imageBase64);
    const stripImg = front.iconsBase64 ? await _decodeImg(front.iconsBase64) : null;
    if (!img) {
      status("Просмотр: не удалось декодировать изображение");
      return;
    }
    const maxW = Math.min(640, window.innerWidth * 0.9);
    const scale = Math.min(1, maxW / img.width);
    captchaCanvas.width = Math.max(1, Math.round(img.width * scale));
    captchaCanvas.height = Math.max(1, Math.round(img.height * scale));
    const tmp = document.createElement("canvas");
    tmp.width = img.width;
    tmp.height = img.height;
    tmp.getContext("2d").putImageData(img, 0, 0);
    const ctx = captchaCanvas.getContext("2d");
    ctx.drawImage(tmp, 0, 0, captchaCanvas.width, captchaCanvas.height);
    if (stripImg && front.iconsBase64) {
      captchaIcons.src = "data:image/jpeg;base64," + front.iconsBase64;
      captchaIcons.style.display = "block";
    } else {
      captchaIcons.style.display = "none";
    }
    previewMode = true;
    labelState = null;
    captchaTitle.textContent = "Просмотр: click-капча";
    previewMeta.innerHTML = _previewMetaHtml(captchaData, captchaType, slotCaption);
    previewMeta.style.display = "block";
    labelHint.textContent = "Только просмотр — клики по полю не сохраняются.";
    labelHint.style.display = "block";
    labelToolbar.style.display = "none";
    captchaCanvas.classList.add("epd2-preview-canvas");
    captchaBox.classList.remove("epd2-captcha-box--wide");
    captchaOverlay.style.display = "flex";
    captchaClose.onclick = () => { _labelClose(); };
  }

  async function _previewShowPuzzle(captchaData, slotCaption, captchaType) {
    status("Просмотр: рендер 15 вариантов...");
    const rendered = await _renderRuCaptchaImage(captchaData, 15);
    if (!rendered?.b64) {
      status("Просмотр: не удалось отрисовать puzzle");
      return;
    }
    const img = await _decodeImg(rendered.b64);
    if (!img) {
      status("Просмотр: ошибка декодирования");
      return;
    }
    const maxW = Math.min(920, window.innerWidth * 0.95);
    const scale = Math.min(1, maxW / img.width);
    captchaCanvas.width = Math.max(1, Math.round(img.width * scale));
    captchaCanvas.height = Math.max(1, Math.round(img.height * scale));
    const tmp = document.createElement("canvas");
    tmp.width = img.width;
    tmp.height = img.height;
    tmp.getContext("2d").putImageData(img, 0, 0);
    captchaCanvas.getContext("2d").drawImage(tmp, 0, 0, captchaCanvas.width, captchaCanvas.height);
    captchaIcons.style.display = "none";
    previewMode = true;
    labelState = null;
    captchaTitle.textContent = "Просмотр: puzzle-капча";
    previewMeta.innerHTML = _previewMetaHtml(captchaData, captchaType, slotCaption);
    previewMeta.style.display = "block";
    labelHint.textContent = "Только просмотр. Красные линии — границы тайлов 3×3 в каждом варианте.";
    labelHint.style.display = "block";
    labelToolbar.style.display = "none";
    captchaCanvas.classList.add("epd2-preview-canvas");
    captchaBox.classList.add("epd2-captcha-box--wide");
    captchaOverlay.style.display = "flex";
    captchaClose.onclick = () => { _labelClose(); };
  }

  async function previewCaptcha() {
    if (running) {
      status("Сначала остановите мониторинг (Стоп)");
      return;
    }
    if (testInProgress) {
      status("Дождитесь завершения теста");
      return;
    }
    if (collectInProgress) {
      status("Сбор капчи выполняется — нажмите «Стоп сбор»");
      return;
    }
    status("Просмотр: ищем слот и запрашиваем капчу...");
    const ctx = await _fetchTestClickCaptcha("[EPD PREVIEW]");
    if (!ctx) return;
    const { captchaData, testDate, testSlot, captchaType } = ctx;
    const caption = `${testSlot.slotCaption}, ${testDate}`;
    if (captchaType === "click") {
      await _previewShowClick(captchaData, caption, captchaType);
    } else {
      await _previewShowPuzzle(captchaData, caption, captchaType);
    }
    status(`Просмотр: ${captchaType === "click" ? "click" : "puzzle"} · ${caption}`);
    await _epdStatusUpload(status, "preview", statusEl.textContent);
  }

  function _labelRedraw() {
    if (!labelState?.ctx || !labelState?.img) return;
    const { ctx, img, scale, points } = labelState;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.drawImage(img, 0, 0, ctx.canvas.width, ctx.canvas.height);
    points.forEach((p, i) => {
      const cx = p.x * scale, cy = p.y * scale;
      ctx.fillStyle = "rgba(46, 125, 50, 0.85)";
      ctx.beginPath();
      ctx.arc(cx, cy, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), cx, cy);
    });
  }

  function _labelUpdateHint() {
    if (!labelState) return;
    const n = labelState.points.length;
    const need = labelState.iconCount;
    if (n === 0 && labelState.diffTag === "[EPD TEST ML]") {
      labelHint.textContent = `ML отклонён — кликните ${need} иконок вручную; при сохранении в консоли будет diff ML vs manual`;
      labelSave.disabled = true;
      labelValidate.disabled = true;
      return;
    }
    if (n >= need) {
      labelHint.textContent = `Готово: ${n}/${need} точек — сохраните в датасет`;
      labelSave.disabled = false;
      labelValidate.disabled = false;
    } else {
      labelHint.textContent = `Точка ${n + 1} из ${need} — кликните иконку #${n + 1} на поле`;
      labelSave.disabled = n < 3;
      labelValidate.disabled = n < 3;
    }
  }

  function _labelOnCanvasClick(ev) {
    if (!labelState?.scale) return;
    const rect = captchaCanvas.getBoundingClientRect();
    const cx = (ev.clientX - rect.left) * (captchaCanvas.width / rect.width);
    const cy = (ev.clientY - rect.top) * (captchaCanvas.height / rect.height);
    if (labelState.points.length >= labelState.iconCount) return;
    labelState.points.push({
      x: Math.round(cx / labelState.scale),
      y: Math.round(cy / labelState.scale),
    });
    _labelRedraw();
    _labelUpdateHint();
    const last = labelState.points[labelState.points.length - 1];
    console.log("[EPD LABEL] point", labelState.points.length, last);
  }

  function _labelUndo() {
    if (!labelState?.points.length) return;
    labelState.points.pop();
    _labelRedraw();
    _labelUpdateHint();
  }

  function _labelClearPoints() {
    if (!labelState) return;
    labelState.points = [];
    _labelRedraw();
    _labelUpdateHint();
  }

  async function _labelSave(runValidate) {
    if (!labelState || labelState.points.length < 3) {
      status("Разметка: нужно минимум 3 точки");
      return;
    }
    const coords = labelState.points.map(p => ({ x: p.x, y: p.y }));
    if (labelState.mlCoords?.length) {
      _clickLogMlManualDiff(
        labelState.diffTag || "[EPD LABEL]",
        labelState.mlCoords,
        coords,
        labelState.mlMeta || {},
      );
    }
    let id = null;
    if (window.EPD_ML_COLLECT?.saveLabeled) {
      id = await window.EPD_ML_COLLECT.saveLabeled(labelState.front, coords, {
        iconCount: labelState.iconCount,
        method: "manual",
      });
    }
    status(`Разметка сохранена: ${coords.length} точек, valid=true`);
    console.log("[EPD LABEL] saved", id, coords);

    if (runValidate && labelState.token) {
      status("Разметка: проверяем на сервере...");
      const ok = await validateCaptcha({
        answer: coords,
        captchaToken: labelState.token,
        encryptedTso: null,
        facilityId: reservation.facilityId,
        reservationId: reservation.id,
        timeSlotData: labelState.tsd,
      });
      const valid = !!ok?.successToken;
      if (id && window.EPD_ML_COLLECT) {
        await window.EPD_ML_COLLECT.updateOutcome(id, valid, { coords, method: "manual" });
      }
      status(valid
        ? "Разметка: сервер принял coords (valid=true подтверждён)"
        : "Разметка: сохранено valid=true, сервер отклонил (coords для обучения всё равно полезны)");
      console.log("[EPD LABEL] validate:", valid);
    }
    _labelClose();
    await _epdStatusUpload(
      status,
      runValidate ? "label-validate" : "label",
      statusEl.textContent,
    );
  }

  async function _labelOpen(front, token, tsd, slotCaption, initialPoints = null, mlMeta = null) {
    const img = await _decodeImg(front.imageBase64);
    const stripImg = await _decodeImg(front.iconsBase64);
    if (!img || !stripImg) {
      status("Разметка: не удалось декодировать изображения");
      return;
    }
    const strip = _toClickChannels(stripImg);
    const iconCount = _detectIconCount(strip, stripImg);
    const maxW = 480;
    const scale = Math.min(1, maxW / img.width);
    captchaCanvas.width = Math.max(1, Math.round(img.width * scale));
    captchaCanvas.height = Math.max(1, Math.round(img.height * scale));
    const tmp = document.createElement("canvas");
    tmp.width = img.width;
    tmp.height = img.height;
    tmp.getContext("2d").putImageData(img, 0, 0);
    const ctx = captchaCanvas.getContext("2d");
    const points = Array.isArray(initialPoints)
      ? initialPoints.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }))
      : [];
    const mlCoords = mlMeta?.coords?.length
      ? mlMeta.coords.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }))
      : (Array.isArray(initialPoints) && initialPoints.length
        ? initialPoints.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }))
        : null);
    labelState = {
      front,
      token,
      tsd,
      img: tmp,
      ctx,
      scale,
      iconCount,
      points,
      mlCoords,
      mlMeta: mlMeta || null,
      diffTag: mlMeta?.diffTag || "[EPD LABEL]",
    };
    _labelRedraw();
    captchaIcons.src = "data:image/jpeg;base64," + front.iconsBase64;
    captchaTitle.textContent = `Разметка: ${slotCaption || "click-капча"}`;
    labelHint.style.display = "block";
    labelToolbar.style.display = "flex";
    _labelUpdateHint();
    captchaOverlay.style.display = "flex";
    captchaClose.onclick = () => { _labelClose(); };
  }

  async function _fetchTestSlotForLabel() {
    reservation = reservation || await fetchReservation(reservationUuid);
    if (!reservation) return null;
    vehicle = vehicle || reservation.vehicleData?.[0];
    if (!vehicle) return null;
    const emptyGuid = "00000000-0000-0000-0000-000000000000";
    if (!reservation.facilityId || reservation.facilityId === emptyGuid) return null;

    const datesRes = await apiGetJSON(
      `/reservations-api/v1/timeslot/AvailableDates?facilityId=${reservation.facilityId}` +
      `&fromDate=${new Date().toISOString().split("T")[0]}` +
      `&transportType=${vehicle.subTypeId || 1}` +
      `&vehicleId=${vehicle.vehicleId}`
    );
    if (!datesRes.data?.length) return null;

    for (const d of datesRes.data.slice(0, 14)) {
      const slotRes = await apiGetJSON(
        `/reservations-api/v1/timeslot/AvailableSlots?facilityId=${reservation.facilityId}` +
        `&vehicleId=${vehicle.vehicleId}&date=${d}` +
        `&transportType=${vehicle.subTypeId || 1}` +
        `&isCreateReservation=false&reservationId=${reservation.id}`
      );
      const slots = (slotRes.data?.slots || []).filter(s => !s.count || s.count > 0);
      if (slots.length) {
        return {
          date: d,
          slot: slots[0],
          tsd: toISOSlot(d, slots[0].time),
        };
      }
    }
    return null;
  }

  function _collectResetBtn() {
    btnCollect.textContent = "📷 Сбор капчи";
    btnCollect.style.background = "#4e342e";
  }

  async function collectCaptchas() {
    if (collectInProgress) {
      collectAbort = true;
      status("Сбор: останавливаем...");
      return;
    }
    if (running) {
      status("Сбор: сначала остановите мониторинг (Стоп)");
      return;
    }
    if (testInProgress) {
      status("Сбор: дождитесь завершения теста / разметки");
      return;
    }

    collectInProgress = true;
    collectAbort = false;
    btnCollect.textContent = "⏹ Стоп сбор";
    btnCollect.style.background = "#b71c1c";

    status("Сбор: ищем слот...");
    const picked = await _fetchTestSlotForLabel();
    if (!picked || collectAbort) {
      collectInProgress = false;
      collectAbort = false;
      _collectResetBtn();
      status(collectAbort ? "Сбор: остановлен" : "Сбор: нет слотов / заявка недоступна");
      return;
    }

    const body = {
      facilityId: reservation.facilityId,
      reservationId: reservation.id,
      timeSlotData: picked.tsd,
    };
    let count = 0;
    let stopReason = "";

    while (!collectAbort) {
      status(`Сбор: запрашиваем капчу #${count + 1} (${picked.slot.slotCaption})...`);
      const captchaData = await fetchCaptcha(body);
      if (!captchaData) {
        stopReason = _lastFetchCaptchaError || "сервер не отдал капчу";
        break;
      }
      if (collectAbort) break;

      const front = captchaData.front;
      if (!front?.imageBase64) {
        stopReason = "не click-капча";
        break;
      }

      const saved = await _epdDownloadRawCaptchaImage(front, "collect", count + 1);
      if (!saved) {
        stopReason = "ошибка сохранения файла";
        break;
      }
      count++;

      if (collectAbort) break;

      const pauseMs = Math.floor(Math.random() * 15_001);
      status(`Сбор: сохранено ${count}, пауза ${(pauseMs / 1000).toFixed(1)}с...`);
      const cont = await _sleepAbortable(pauseMs, () => collectAbort);
      if (!cont) break;
    }

    collectInProgress = false;
    collectAbort = false;
    _collectResetBtn();
    if (stopReason) {
      status(`Сбор завершён: ${count} капч — ${stopReason}`);
    } else {
      status(`Сбор остановлен: сохранено ${count} капч`);
    }
    console.log(`[EPD COLLECT] done: ${count} images, reason: ${stopReason || "user stop"}`);
  }

  async function labelCaptcha() {
    if (collectInProgress) {
      status("Сбор капчи выполняется — нажмите «Стоп сбор»");
      return;
    }
    status("Разметка: загрузка...");
    const picked = await _fetchTestSlotForLabel();
    if (!picked) {
      status("Разметка: нет слотов / заявка недоступна");
      return;
    }
    status(`Разметка: запрашиваем капчу (${picked.slot.slotCaption})...`);
    const captchaData = await fetchCaptcha({
      facilityId: reservation.facilityId,
      reservationId: reservation.id,
      timeSlotData: picked.tsd,
    });
    if (!captchaData?.front?.imageBase64) {
      status("Разметка: капча недоступна");
      return;
    }
    await _labelOpen(captchaData.front, captchaData.token, picked.tsd, picked.slot.slotCaption);
    status("Разметка: кликайте по иконкам на поле (сверху — полоска иконок)");
  }

  async function _fetchTestClickCaptcha(logTag = "[EPD TEST]") {
    status("Тест: загрузка заявки...");
    reservation = await fetchReservation(reservationUuid);
    if (!reservation) { status("Тест: заявка не найдена"); return null; }
    vehicle = reservation.vehicleData?.[0];
    if (!vehicle) { status("Тест: в заявке нет ТС"); return null; }
    const emptyGuid = "00000000-0000-0000-0000-000000000000";
    if (!reservation.facilityId || reservation.facilityId === emptyGuid) {
      status("Тест: АПП не выбран (черновик?). Откройте подтверждённую заявку.");
      return null;
    }

    status("Тест: ищем дату со свободными слотами...");
    const datesRes = await apiGetJSON(
      `/reservations-api/v1/timeslot/AvailableDates?facilityId=${reservation.facilityId}` +
      `&fromDate=${new Date().toISOString().split("T")[0]}` +
      `&transportType=${vehicle.subTypeId || 1}` +
      `&vehicleId=${vehicle.vehicleId}`
    );
    if (!datesRes.data || !datesRes.data.length) {
      status("Тест: нет доступных дат на этом АПП");
      return null;
    }

    let testDate = null;
    let testSlot = null;
    let tsd = null;
    const datesToTry = datesRes.data.slice(0, 14);
    for (const d of datesToTry) {
      status(`Тест: проверяем слоты на ${d}...`);
      const slotRes = await apiGetJSON(
        `/reservations-api/v1/timeslot/AvailableSlots?facilityId=${reservation.facilityId}` +
        `&vehicleId=${vehicle.vehicleId}&date=${d}` +
        `&transportType=${vehicle.subTypeId || 1}` +
        `&isCreateReservation=false&reservationId=${reservation.id}`
      );
      const slots = (slotRes.data?.slots || []).filter(s => !s.count || s.count > 0);
      if (slots.length) {
        testDate = d;
        testSlot = slots[0];
        tsd = toISOSlot(testDate, testSlot.time);
        console.log(`${logTag} slot:`, testSlot.slotCaption, "date:", testDate, "tsd:", tsd);
        break;
      }
      console.log(`${logTag} no slots on`, d);
    }

    if (!tsd) {
      status(`Тест: слотов нет на ${datesToTry.length} ближ. дн. — это нормально. Нажмите Старт и ждите.`);
      return null;
    }

    status(`Тест: запрашиваем капчу (${testSlot.slotCaption}, ${testDate})...`);
    const captchaData = await fetchCaptcha({
      facilityId: reservation.facilityId,
      reservationId: reservation.id,
      timeSlotData: tsd,
    });
    if (!captchaData) {
      const why = _lastFetchCaptchaError || "сервер не отдал капчу";
      status(`Тест: капча недоступна — ${why}`);
      return null;
    }

    const captchaType = captchaData._captchaType ||
      (captchaData.front?.imageBase64 ? "click" : "puzzle");
    console.log(`${logTag} type:`, captchaType,
      "tiles:", captchaData.puzzle?.tiles?.length,
      "variants:", captchaData.puzzle?.variantsCapture?.length);

    return { captchaData, testDate, testSlot, tsd, captchaType };
  }

  async function testMlValidate() {
    if (collectInProgress) {
      status("Сбор капчи выполняется — нажмите «Стоп сбор»");
      return;
    }
    if (testInProgress) {
      status("ML тест: уже выполняется");
      return;
    }
    testInProgress = true;
    const ctx = await _fetchTestClickCaptcha("[EPD TEST ML]");
    if (!ctx) { testInProgress = false; return; }
    const { captchaData, testDate, testSlot, tsd, captchaType } = ctx;
    if (captchaType !== "click") {
      status("ML тест: только click-капча");
      testInProgress = false;
      return;
    }

    status("ML тест: ML peaks (fast NCC → pure ML)...");
    const t0 = Date.now();
    const token = captchaData.token;
    captchaData._onMlProgress = (msg) => status(`ML тест: ${msg}`);
    const coords = await solveClickRace(captchaData, 3).catch(() => null);
    const solveMeta = captchaData._lastClickSolve;
    const ms = Date.now() - t0;
    let mlCollectId = null;
    if (window.EPD_ML_COLLECT?.enabled && captchaData.front) {
      mlCollectId = await window.EPD_ML_COLLECT.saveSample(captchaData.front, {
        coords,
        confs: solveMeta?.confs,
        method: solveMeta?.method,
        mlScores: solveMeta?.mlScores,
      });
    }
    if (!coords || coords.length < 3) {
      if (window.EPD_ML_COLLECT && mlCollectId) {
        await window.EPD_ML_COLLECT.updateOutcome(mlCollectId, false, { coords: null, method: solveMeta?.method });
      }
      status(`ML тест: solvers не вернули координаты (${ms}мс)`);
      console.log("[EPD TEST ML] validate: ❌ no coords");
      testInProgress = false;
      return;
    }

    console.log("[EPD TEST ML] coords:", coords);
    _clickLogMlPerIcon("[EPD TEST ML]", coords, solveMeta);
    status(`ML тест: ${coords.length} точек за ${ms}мс — validate...`);
    const ok = await validateCaptcha({
      answer: coords,
      captchaToken: token,
      encryptedTso: null,
      facilityId: reservation.facilityId,
      reservationId: reservation.id,
      timeSlotData: tsd,
    });
    const valid = !!ok?.successToken;
    if (window.EPD_ML_COLLECT && mlCollectId) {
      await window.EPD_ML_COLLECT.updateOutcome(mlCollectId, valid, {
        coords,
        method: solveMeta?.method,
      });
    }
    const confPct = solveMeta?.conf != null ? (solveMeta.conf * 100).toFixed(0) : "?";
    if (valid) {
      status(`ML тест OK! Сервер принял за ${ms}мс (min ${confPct}%)`);
      console.log("[EPD TEST ML] validate: ✅ isValid=true");
    } else if (ok?.tokenExpired) {
      status(`ML тест: токен сгорел (${ms}мс)`);
      console.log("[EPD TEST ML] validate: token expired");
    } else {
      status(`ML тест: отклонено — кликните правильные точки для сравнения с ML`);
      console.log("[EPD TEST ML] validate: ❌ isValid=false");
      await _labelOpen(
        captchaData.front,
        token,
        tsd,
        `ML тест: ${testSlot.slotCaption}, ${testDate}`,
        [],
        {
          coords,
          mlScores: solveMeta?.mlScores,
          confs: solveMeta?.confs,
          method: solveMeta?.method,
          diffTag: "[EPD TEST ML]",
        },
      );
      return;
    }
    testInProgress = false;
  }

  async function testCaptchaBg() {
    if (collectInProgress) {
      status("Сбор капчи выполняется — нажмите «Стоп сбор»");
      return;
    }
    if (testInProgress) {
      status("Тест BG: уже выполняется — дождитесь разметки");
      return;
    }
    if (!BG_REMOVE_ENABLED || !window.EPD_BG_REMOVE) {
      status("BG-remove модуль не загружен");
      return;
    }
    testInProgress = true;
    const ctx = await _fetchTestClickCaptcha("[EPD TEST BG]");
    if (!ctx) { testInProgress = false; return; }
    const { captchaData, testDate, testSlot, tsd, captchaType } = ctx;

    if (captchaType !== "click") {
      status("BG+NCC: только click-капча");
      testInProgress = false;
      return;
    }

    _epdPreviewBgRemoved(captchaData.front);
    status("Тест BG: удаляем фон → NCC peaks...");
    const t0 = Date.now();
    const token = captchaData.token;
    captchaData._onMlProgress = (msg) => status(`Тест BG: ${msg}`);
    const solveMeta = await solveClickBgNCC(captchaData.front, captchaData._onMlProgress).catch(() => null);
    captchaData._lastClickSolve = solveMeta;
    const coords = solveMeta?.coords || null;
    let mlCollectId = null;
    if (window.EPD_ML_COLLECT?.enabled && captchaData.front) {
      mlCollectId = await window.EPD_ML_COLLECT.saveSample(captchaData.front, {
        coords,
        confs: solveMeta?.confs,
        method: solveMeta?.method,
        mlScores: solveMeta?.mlScores,
      });
    }
    if (coords && coords.length >= 3) {
      console.log("[EPD TEST BG] coords:", coords);
      const caption = `${testSlot.slotCaption}, ${testDate}`;
      status(`Тест BG: ${coords.length} точек за ${Date.now() - t0}мс — отредактируйте и сохраните`);
      await _labelOpen(
        captchaData.front,
        token,
        tsd,
        `BG+NCC: ${caption}`,
        coords,
        {
          coords,
          mlScores: solveMeta?.mlScores,
          confs: solveMeta?.confs,
          method: solveMeta?.method,
          nccCands: solveMeta?.nccCands,
          diffTag: "[EPD TEST BG]",
        },
      );
    } else {
      if (window.EPD_ML_COLLECT && mlCollectId) {
        await window.EPD_ML_COLLECT.updateOutcome(mlCollectId, false, { coords: null, method: solveMeta?.method });
      }
      status("Тест BG: solvers не вернули координаты (см. превью фона)");
      testInProgress = false;
    }
  }

  async function testCaptcha() {
    if (collectInProgress) {
      status("Сбор капчи выполняется — нажмите «Стоп сбор»");
      return;
    }
    if (testInProgress) {
      status("Тест: уже выполняется — дождитесь разметки");
      return;
    }
    testInProgress = true;
    const ctx = await _fetchTestClickCaptcha("[EPD TEST]");
    if (!ctx) {
      testInProgress = false;
      await _epdStatusUpload(status, "test", statusEl.textContent);
      return;
    }
    const { captchaData, testDate, testSlot, tsd, captchaType } = ctx;

    if (captchaType === "click") {
      status("Тест: решаем click-капчу (NCC → разметка)...");
      const t0 = Date.now();
      const token = captchaData.token;
      captchaData._onMlProgress = (msg) => status(`Тест: ${msg}`);
      const coords = await solveClickRace(captchaData, 3).catch(() => null);
      const solveMeta = captchaData._lastClickSolve;
      let mlCollectId = null;
      if (window.EPD_ML_COLLECT?.enabled && captchaData.front) {
        mlCollectId = await window.EPD_ML_COLLECT.saveSample(captchaData.front, {
          coords,
          confs: solveMeta?.confs,
          method: solveMeta?.method,
          mlScores: solveMeta?.mlScores,
        });
      }
      if (coords && coords.length >= 3) {
        console.log("[EPD TEST] coords:", coords);
        const caption = `${testSlot.slotCaption}, ${testDate}`;
        status(`Тест: ${coords.length} точек за ${Date.now() - t0}мс — отредактируйте и сохраните`);
        await _labelOpen(
          captchaData.front,
          token,
          tsd,
          `Тест: ${caption}`,
          coords,
          {
            coords,
            mlScores: solveMeta?.mlScores,
            confs: solveMeta?.confs,
            method: solveMeta?.method,
            nccCands: solveMeta?.nccCands,
            diffTag: "[EPD TEST]",
          },
        );
      } else {
        if (window.EPD_ML_COLLECT && mlCollectId) {
          await window.EPD_ML_COLLECT.updateOutcome(mlCollectId, false, { coords: null, method: solveMeta?.method });
        }
        testInProgress = false;
        await _epdStatusUpload(status, "test", "Тест: solvers не вернули координаты");
      }
      return;
    }

    status("Тест: EdgeMatch без AI/RuCaptcha...");
    const testT0 = Date.now();
    _lastCaptchaData = captchaData;
    const token = captchaData.token;
    const result = await solvePuzzle(captchaData, { skipRuCaptcha: true, skipAI: true });
    const ranked = result?.ranked || [];
    const edgeMs = result?.edgeMs ?? 0;

    if (result?.fromCache && ranked[0]?.answer) {
      status("Тест: кэш — validate...");
      const vT0 = Date.now();
      const ok = await validateCaptcha({
        answer: ranked[0].answer,
        captchaToken: token,
        encryptedTso: null,
        facilityId: reservation.facilityId,
        reservationId: reservation.id,
        timeSlotData: tsd,
      });
      const totalMs = Date.now() - testT0;
      const vMs = Date.now() - vT0;
      if (ok?.successToken) {
        const totalMs = Date.now() - testT0;
        testInProgress = false;
        console.log(`[EPD TEST] validate: ✅ isValid=true | cache variant ${ranked[0].idx + 1} | ${totalMs}мс total`);
        await _epdStatusUpload(status, "test-puzzle", `✅ Тест: кэш OK! ${totalMs}мс (validate ${vMs}мс)`);
      } else if (ok?.tokenExpired) {
        const totalMs = Date.now() - testT0;
        testInProgress = false;
        console.log("[EPD TEST] validate: token expired");
        await _epdStatusUpload(status, "test-puzzle", `Тест: токен сгорел (${totalMs}мс)`);
      } else {
        const totalMs = Date.now() - testT0;
        testInProgress = false;
        console.log(`[EPD TEST] validate: ❌ cache miss on server | ${totalMs}мс total`);
        await _epdStatusUpload(status, "test-puzzle", `❌ Тест: кэш не прошёл validate (${totalMs}мс)`);
      }
      return;
    }

    if (!ranked.length) {
      testInProgress = false;
      await _epdStatusUpload(status, "test-puzzle", "Тест: EdgeMatch не дал вариантов");
      return;
    }

    status(`Тест: EdgeMatch ${edgeMs}мс, validate TOP-5...`);
    const maxTries = Math.min(5, ranked.length);
    for (let attempt = 0; attempt < maxTries; attempt++) {
      const c = ranked[attempt];
      if (attempt > 0) await sleep(300);
      status(`Тест: validate ${attempt + 1}/${maxTries}, вариант ${c.idx + 1}...`);
      const vT0 = Date.now();
      const ok = await validateCaptcha({
        answer: c.answer,
        captchaToken: token,
        encryptedTso: null,
        facilityId: reservation.facilityId,
        reservationId: reservation.id,
        timeSlotData: tsd,
      });
      const vMs = Date.now() - vT0;
      if (ok?.successToken) {
        const totalMs = Date.now() - testT0;
        testInProgress = false;
        console.log(
          `[EPD TEST] validate: ✅ isValid=true | variant ${c.idx + 1}/${maxTries} | ` +
          `EdgeMatch ${edgeMs}мс + validate ${vMs}мс = ${totalMs}мс total | conf ${((result.confidence || 0) * 100).toFixed(0)}%`,
        );
        await _epdStatusUpload(
          status,
          "test-puzzle",
          `✅ Тест OK! вариант ${c.idx + 1}, ${totalMs}мс (EM ${edgeMs}мс + v ${vMs}мс)`,
        );
        return;
      }
      if (ok?.tokenExpired) {
        const totalMs = Date.now() - testT0;
        testInProgress = false;
        console.log(`[EPD TEST] validate: token expired | ${totalMs}мс total`);
        await _epdStatusUpload(status, "test-puzzle", `Тест: токен сгорел на ${attempt + 1}/${maxTries} (${totalMs}мс)`);
        return;
      }
      console.log(`[EPD TEST] validate: ❌ variant ${c.idx + 1} (${vMs}мс)`);
    }

    const totalMs = Date.now() - testT0;
    testInProgress = false;
    console.log(
      `[EPD TEST] validate: ❌ TOP-5 failed | EdgeMatch ${edgeMs}мс | ${totalMs}мс total | ` +
      `conf ${((result.confidence || 0) * 100).toFixed(0)}%`,
    );
    await _epdStatusUpload(
      status,
      "test-puzzle",
      `❌ Тест: TOP-5 не угадали, ${totalMs}мс (EM ${edgeMs}мс)`,
    );
  }

  async function start() {
    const date = dateIn.value;
    const from = fromIn.value;
    const to   = toIn.value;
    if (!date || !from || !to) { status("Заполните все поля"); return; }

    status("Loading reservation...");
    reservation = await fetchReservation(reservationUuid);
    if (!reservation) { status("Reservation not found"); return; }
    vehicle = reservation.vehicleData?.[0];
    if (!vehicle) { status("No vehicle"); return; }
    const emptyGuid = "00000000-0000-0000-0000-000000000000";
    if (!reservation.facilityId || reservation.facilityId === emptyGuid) {
      status("ERROR: no facility selected (draft?). Use confirmed reservation.");
      return;
    }

    running = true;
    backoffMs = 0;
    checkCount = 0;
    abortCtrl = new AbortController();
    btnStart.style.display = "none";
    btnStop.style.display = "block";
    dateIn.disabled = fromIn.disabled = toIn.disabled = true;

    if (ML_ENABLED && window.EPD_ML_SOLVER) {
      window.EPD_ML_SOLVER.mlInit().catch(() => null);
    }

    pollLoop(date, hhmm2min(from), hhmm2min(to));
  }

  function stop() {
    running = false;
    if (abortCtrl) abortCtrl.abort();
    btnStart.style.display = "block";
    btnStop.style.display = "none";
    dateIn.disabled = fromIn.disabled = toIn.disabled = false;
    _epdStatusUpload(status, "stop", "Остановлено");
  }

  async function pollLoop(date, minT, maxT) {
    while (running) {
      checkCount++;

      if (backoffMs > 0) {
        const waitSec = Math.round(backoffMs / 1000);
        status(`⏳ Backoff ${waitSec}с после 429… (проверка #${checkCount})`);
        // Sleep in short slices so we can show countdown and stay "alive"
        const sliceSz = 15_000;
        let remaining = backoffMs;
        while (remaining > 0 && running) {
          const chunk = Math.min(sliceSz, remaining);
          await sleep(chunk);
          remaining -= chunk;
          if (remaining > 0 && running) {
            status(`⏳ Backoff ещё ${Math.round(remaining / 1000)}с… (#${checkCount})`);
          }
        }
        if (!running) break;
      }

      // WAF cooldown check before making any request
      if (_wafReqCount >= WAF_LIMIT && !_wafCoolingDown) {
        status(`🛡 WAF cooldown (${_wafReqCount} запросов), пауза 10-15с… (#${checkCount})`);
      }
      if (_wafCoolingDown) {
        status(`🛡 WAF cooldown, ждём… (#${checkCount})`);
      }
      await _wafGate();

      status(`🔍 Проверка #${checkCount} (WAF: ${_wafReqCount}/${WAF_LIMIT})…`);

      const params = {
        facilityId: reservation.facilityId,
        vehicleId: vehicle.vehicleId,
        date: date,
        transportType: vehicle.subTypeId || 1,
        isCreateReservation: "false",
        reservationId: reservation.id,
      };

      let resp;

      // ── Genius #1: use intercepted page response if fresh (< 4 s) ────────
      const interceptAge = _interceptedSlots ? Date.now() - _interceptedSlots.ts : Infinity;
      const broadcastAge = _lastBroadcast    ? Date.now() - _lastBroadcast.ts    : Infinity;

      if (interceptAge < 4_000) {
        resp = _interceptedSlots;
        _interceptedSlots = null;
        status(`♻️ Используем перехваченный ответ страницы (#${checkCount})`);
      } else if (broadcastAge < 4_000) {
        // ── Genius #2: use cross-tab result if fresh ──────────────────────
        resp = _lastBroadcast;
        _lastBroadcast = null;
        status(`📡 Используем результат другой вкладки (#${checkCount})`);
      } else {
        try {
          resp = await fetchAvailableSlots(params);
          broadcastSlots(resp); // share result with other open tabs
        } catch (err) {
          status(`⚠️ Сеть: ${err.message}`);
          await sleep(5_000);
          continue;
        }
      }

      if (resp.status === 401) {
        console.log("[EPD] 🔑 401 Unauthorized — сессия истекла, перезагрузка...");
        status("🔑 Сессия истекла! Перезагрузка страницы...");
        running = false;
        await sleep(2000);
        window.location.reload();
        return;
      }

      if (resp.status === 429 || resp.status === 403 || resp.status === 406 || resp.status === 500) {
        if (_wafCheckBan(resp)) { running = false; return; }
        _wafForceReset();
        const forceCooldown = Math.round(rand(WAF_COOLDOWN_MIN, WAF_COOLDOWN_MAX));
        console.log(`[EPD] ${resp.status} → forced WAF cooldown ${forceCooldown / 1000}s`);
        backoffMs = forceCooldown;

        try {
          window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: Math.floor(rand(100, 900)), clientY: Math.floor(rand(100, 600)) }));
          window.dispatchEvent(new Event("focus"));
          window.scrollBy(0, Math.floor(rand(-20, 20)));
        } catch (_) {}

        status(`🛡 [${resp.status}] WAF cooldown ${Math.round(forceCooldown / 1000)}с (#${checkCount})`);
        continue;
      }

      if (resp.status === 400) {
        backoffMs = 0;
        const sp1 = getSpeed();
        let waitMs = rand(sp1.min, sp1.max);
        if (Math.random() < sp1.pause) {
          waitMs = rand(sp1.pauseMin, sp1.pauseMax);
        }
        const sec = Math.round(waitMs / 1000);
        status(`-- No slots ${date}, next in ${sec}s (#${checkCount})`);
        await sleep(waitMs);
        continue;
      }

      if (!resp.data) {
        const waitMs = rand(3_000, 8_000);
        status(`?? Empty response (${resp.status}), retry ${Math.round(waitMs/1000)}s`);
        await sleep(waitMs);
        continue;
      }

      backoffMs = 0;

      const slots = resp.data.slots || [];
      const matched = slots.filter(s => {
        const t = hhmm2min(s.time);
        if (minT <= maxT) return t >= minT && t <= maxT;
        return t >= minT || t <= maxT;
      });

      status(`++ Slots: ${slots.length}, matched: ${matched.length} (#${checkCount})`);

      if (matched.length > 0) {
        _consecutiveEmpty = 0; // reset empty counter
        _slotHistory.push(Date.now());
        if (_slotHistory.length > 50) _slotHistory.shift();
        if (notifSound) notifSound.play().catch(() => {});

        // Sort: highest count first — more spots = higher chance of grabbing
        matched.sort((a, b) => (b.count || 0) - (a.count || 0));

        let allTaken = true;
        for (let si = 0; si < matched.length; si++) {
          const slot = matched[si];
          status(`🎯 Слот ${si+1}/${matched.length}: ${slot.slotCaption} (count=${slot.count})`);
          console.log(`[EPD] Trying slot ${si+1}/${matched.length}: ${slot.slotCaption} count=${slot.count}`);

          if (slot.count !== undefined && slot.count <= 0) continue;

          running = false;
          const captchaResult = await handleCaptchaFlow(slot, date);
          if (captchaResult === "slot_taken") {
            status(`⚡ Слот ${slot.slotCaption} занят, следующий...`);
            console.log(`[EPD] Slot ${slot.slotCaption} taken → next`);
            running = true;
            continue;
          }
          allTaken = false;
          return;
        }

        if (allTaken) {
          running = true;
          btnStart.style.display = "none";
          btnStop.style.display = "block";
          status("⚡ Все слоты заняты, ждём новые...");
          await sleep(3_000);
          continue;
        }
      }

      _consecutiveEmpty++;

      const sp2 = getSpeed();
      let waitMs = _adaptiveDelay(sp2.min, sp2.max);
      if (Math.random() < sp2.pause && _consecutiveEmpty > 5) {
        waitMs = rand(sp2.pauseMin, sp2.pauseMax);
      }
      const nextSec = Math.round(waitMs / 1000);
      status(`Next in ${nextSec}s (#${checkCount}, empty×${_consecutiveEmpty})`);
      await smartSleep(waitMs);
    }
  }

  // ---------------------------------------------------------------------------
  //  Captcha flow — rewritten as a loop (no recursion → no stack overflow)
  //
  //  Strategy per captcha token:
  //    Phase A — try EM top-2 variants immediately (fast, no wait)
  //    Phase B — if EM confidence was low, await RuCaptcha result and try it
  //    Phase C — try remaining EM variants (bottom of ranking)
  //  If all phases fail: request a NEW captcha token and repeat.
  //  Hard limit: MAX_CAPTCHA_ROUNDS rounds total before giving up.
  // ---------------------------------------------------------------------------

  async function handleCaptchaFlow(slot, date) {
    captchaOverlay.style.display = "flex";
    labelHint.style.display = "none";
    labelToolbar.style.display = "none";
    captchaTitle.textContent = slot.slotCaption;
    const tsd = toISOSlot(date, slot.time);
    const delay = parseInt(captchaDelayIn.value) || 800;
    const MAX_CAPTCHA_ROUNDS = 15;

    captchaClose.onclick = () => {
      captchaOverlay.style.display = "none";
      stop();
    };

    // Returns "success" | "slot_taken" | { tokenExpired: true } | false
    async function tryAnswer(answer, token, label) {
      try {
        const success = await validateCaptcha({
          answer, captchaToken: token, encryptedTso: null,
          facilityId: reservation.facilityId,
          reservationId: reservation.id,
          timeSlotData: tsd,
        });
        if (success?.tokenExpired) return { tokenExpired: true };
        if (success) {
          console.log(`[EPD] ✅ CAPTCHA PASSED (${label}) — reschedule...`);
          try {
            await reschedule({
              captchaToken: success.successToken, date,
              facilityId: reservation.facilityId,
              intervalIndex: slot.intervalIndex,
              reservationRequestId: reservation.id,
              timeslot: `${formatDot(date)}, ${slot.slotCaption}`,
              transportType: vehicle.subTypeId || 1,
            });
            captchaOverlay.style.display = "none";
            status("🎉 Перезапись выполнена!");
            window.location.href = `/en/reservations/reservation/${reservation.id}`;
            return "success";
          } catch (e2) {
            if (e2.slotTaken) {
              console.log(`[EPD] ⚡ ${label}: капча OK, но слот занят!`);
              return "slot_taken";
            }
            console.log(`[EPD] ❌ ${label} reschedule error:`, e2.message);
          }
        }
      } catch (e) {
        console.log(`[EPD] ❌ ${label} rejected:`, e.message);
      }
      return false;
    }

    for (let round = 1; round <= MAX_CAPTCHA_ROUNDS; round++) {
      status(`Загружаем капчу (попытка ${round}/${MAX_CAPTCHA_ROUNDS})...`);

      const captchaData = await fetchCaptcha({
        facilityId: reservation.facilityId,
        reservationId: reservation.id,
        timeSlotData: tsd,
        encryptedTso: null,
      });
      if (!captchaData) {
        status("Капча недоступна, ждём 5с...");
        await sleep(5_000);
        continue;
      }

      const token = captchaData.token;
      const captchaType = captchaData._captchaType || (captchaData.front?.imageBase64 ? "click" : "puzzle");
      console.log(`[EPD] ─── Round ${round}: token=${token?.slice(0,12)}... type=${captchaType}`);

      // ═══ CLICK-BASED CAPTCHA (new type since ~29.05.2026) ═══
      if (captchaType === "click") {
        console.log(`[EPD] ═══════════════════════════════════════════════════════════`);
        console.log(`[EPD] ═══ CLICK CAPTCHA Round ${round} | token=${token?.slice(0,15)}...`);
        console.log(`[EPD] ═══ Слот: ${slot?.slotCaption || '?'}`);
        console.log(`[EPD] ═══════════════════════════════════════════════════════════`);

        // One-shot token: NCC+MobileNet hybrid (~0.3–0.7с), validate once.
        status(`⚡ Click CAPTCHA → MobileNet ML-only...`);
        const clickT0 = Date.now();
        captchaData._onMlProgress = (msg) => status(`⚡ ML: ${msg}`);
        const coords = await solveClickRace(captchaData, 3).catch(() => null);
        const solveMeta = captchaData._lastClickSolve;
        let mlCollectId = null;
        if (window.EPD_ML_COLLECT?.enabled && captchaData.front) {
          mlCollectId = await window.EPD_ML_COLLECT.saveSample(captchaData.front, {
            coords,
            confs: solveMeta?.confs,
            method: solveMeta?.method,
            mlScores: solveMeta?.mlScores,
          });
        }

        if (coords && coords.length >= 3) {
          console.log(`[EPD] 🎯 Race: ${coords.length} coords за ${Date.now() - clickT0}мс: ${JSON.stringify(coords)}`);
          status(`🎯 Проверяем ${coords.length} точек...`);
          let r = await tryAnswer(coords, token, `Race(${coords.length}pts)`);
          if (window.EPD_ML_COLLECT && mlCollectId) {
            await window.EPD_ML_COLLECT.updateOutcome(mlCollectId, r === "success", { coords, method: solveMeta?.method });
          }
          if (r === "success") { console.log(`[EPD] └─ ✅✅✅ CLICK solved за ${Date.now() - clickT0}мс!`); return; }
          if (r === "slot_taken") { captchaOverlay.style.display = "none"; return "slot_taken"; }
          if (r?.tokenExpired) { console.log(`[EPD] └─ ⚠️ Токен сгорел до ответа`); await sleep(300); continue; }
          console.log(`[EPD] └─ ❌ Координаты неверны, новый токен...`);
        } else {
          console.log(`[EPD] └─ ❌ Race не вернул координаты`);
        }
        await sleep(500);
        continue;
      }

      // ═══ PUZZLE CAPTCHA (old type) ═══
      // Save for cache
      _lastCaptchaData = captchaData;

      // Cache check first (instant, 100% if hit)
      const cacheHit = await _tileCacheSolve(captchaData);
      if (cacheHit) {
        console.log(`[EPD] CACHE HIT! variant ${cacheHit.idx}`);
        status(`⚡ Кэш: вариант ${cacheHit.idx + 1}`);
        let r = await tryAnswer(cacheHit.variant, token, `Cache#${cacheHit.idx}`);
        if (r === "success") return;
        if (r === "slot_taken") { captchaOverlay.style.display = "none"; return "slot_taken"; }
        if (r?.tokenExpired) { await sleep(500); continue; }
      }

      // ═══════════════════════════════════════════════════════════════════════
      //  СТРАТЕГИЯ (как в рабочем плагине):
      //  1. EdgeMatch TOP-5 перебор (тот же токен, сервер НЕ сжигает)
      //  2. TRIPLE AI (Gemini + Claude + GPT-4o) параллельно
      //  3. RuCaptcha (запасной)
      // ═══════════════════════════════════════════════════════════════════════
      const cascadeStart = Date.now();

      console.log(`[EPD] ═══════════════════════════════════════════════════════════`);
      console.log(`[EPD] ═══ КАСКАД Round ${round} | token=${token?.slice(0,15)}...`);
      console.log(`[EPD] ═══ Слот: ${slot?.slotCaption || '?'} | Тайлы: ${captchaData.puzzle?.tiles?.length}`);
      console.log(`[EPD] ═══ Стратегия: TOP-5 EdgeMatch → TRIPLE AI → RuCaptcha`);
      console.log(`[EPD] ═══════════════════════════════════════════════════════════`);

      // Запускаем ИИ и RuCaptcha СРАЗУ параллельно (не ждём — они долгие)
      const gemPromise = solvePuzzleViaGemini(captchaData);
      const ruPromise = solvePuzzleViaRuCaptcha(captchaData);

      // --- Layer 1: EdgeMatch TOP-5 (~1-2с, 5 попыток на одном токене) ---
      status(`⚡ EdgeMatch TOP-5...`);
      const emResult = await solvePuzzleEdgeMatch(captchaData);
      const emConf = emResult?.confidence || 0;
      const ranked = emResult?.ranked || [];
      const emMs = Date.now() - cascadeStart;
      const emTop5 = ranked.slice(0, 5).map(r => `v${r.idx}(${r.score.toFixed(0)})`).join(', ');

      console.log(`[EPD] ┌─ EdgeMatch ГОТОВ за ${emMs}мс | conf=${(emConf*100).toFixed(1)}%`);
      console.log(`[EPD] │  TOP-5: [${emTop5}]`);

      const maxTries = Math.min(5, ranked.length);
      let emSuccess = false;

      for (let attempt = 0; attempt < maxTries; attempt++) {
        const c = ranked[attempt];
        console.log(`[EPD] │  Попытка ${attempt+1}/${maxTries}: вариант ${c.idx + 1} (score=${c.score.toFixed(0)})`);
        status(`⚡ EM попытка ${attempt+1}/5: вариант ${c.idx + 1}...`);

        if (attempt > 0) await sleep(300);

        let r = await tryAnswer(c.answer, token, `EM#${c.idx}(${attempt+1}/5)`);
        if (r === "success") {
          console.log(`[EPD] │  ✅ ПОПЫТКА ${attempt+1}: вариант ${c.idx + 1} — ВЕРНО!`);
          console.log(`[EPD] └─ ✅ EdgeMatch решил капчу за ${Date.now()-cascadeStart}мс (попытка ${attempt+1}/5)`);
          emSuccess = true;
          return;
        }
        if (r === "slot_taken") { console.log(`[EPD] └─ ⚠️ Слот занят`); captchaOverlay.style.display = "none"; return "slot_taken"; }
        if (r?.tokenExpired) {
          console.log(`[EPD] │  ⚠️ Токен СГОРЕЛ на попытке ${attempt+1} — сервер сжигает токен!`);
          console.log(`[EPD] └─ Переходим к новому раунду...`);
          await sleep(300);
          break;
        }
        console.log(`[EPD] │  ❌ Попытка ${attempt+1}: вариант ${c.idx + 1} — неверно`);
      }

      if (emSuccess) return;

      // Проверяем — если токен сгорел, нужна новая капча
      // Если нет — пробуем TRIPLE AI

      // --- Layer 2: TRIPLE AI (~3-8s) ---
      console.log(`[EPD] ├─ EdgeMatch TOP-5 не угадал, ждём TRIPLE AI (таймаут 12с)...`);
      status(`🧩 TRIPLE AI думает...`);
      const gemAnswer = await Promise.race([
        gemPromise.then(a => a || null).catch(() => null),
        sleep(12000).then(() => null),
      ]);
      const aiMs = Date.now() - cascadeStart;

      if (gemAnswer) {
        console.log(`[EPD] ├─ TRIPLE AI ОТВЕТИЛ за ${aiMs}мс`);
        console.log(`[EPD] │  → Пробуем ответ AI...`);
        status(`🧩 AI ответил, проверяем...`);
        let r = await tryAnswer(gemAnswer, token, "TRIPLE-AI");
        if (r === "success") { console.log(`[EPD] └─ ✅ TRIPLE AI УГАДАЛ! Капча решена за ${Date.now()-cascadeStart}мс`); return; }
        if (r === "slot_taken") { console.log(`[EPD] └─ ⚠️ Слот занят`); captchaOverlay.style.display = "none"; return "slot_taken"; }
        if (r?.tokenExpired) { console.log(`[EPD] └─ ⚠️ Токен сгорел`); await sleep(300); continue; }
        console.log(`[EPD] │  ❌ TRIPLE AI ответ — НЕВЕРНО`);
      } else {
        console.log(`[EPD] ├─ TRIPLE AI: ТАЙМАУТ ${aiMs}мс`);
      }

      // --- Layer 3: RuCaptcha (~8-30s) ---
      console.log(`[EPD] ├─ Ждём RuCaptcha 3x workers (таймаут 30с)...`);
      status(`🧩 RuCaptcha workers...`);
      const ruAnswer = await Promise.race([
        ruPromise.then(a => a || null).catch(() => null),
        sleep(30000).then(() => null),
      ]);
      const ruMs = Date.now() - cascadeStart;

      if (ruAnswer) {
        console.log(`[EPD] ├─ RuCaptcha ОТВЕТИЛА за ${ruMs}мс`);
        status(`🧩 RuCaptcha, проверяем...`);
        let r = await tryAnswer(ruAnswer, token, "RuCaptcha");
        if (r === "success") { console.log(`[EPD] └─ ✅ RuCaptcha УГАДАЛА! за ${ruMs}мс`); return; }
        if (r === "slot_taken") { console.log(`[EPD] └─ ⚠️ Слот занят`); captchaOverlay.style.display = "none"; return "slot_taken"; }
        if (r?.tokenExpired) { console.log(`[EPD] └─ ⚠️ Токен сгорел`); await sleep(300); continue; }
        console.log(`[EPD] │  ❌ RuCaptcha — НЕВЕРНО`);
      } else {
        console.log(`[EPD] ├─ RuCaptcha: ТАЙМАУТ ${ruMs}мс`);
      }

      // --- Все провалились ---
      const totalMs = Date.now() - cascadeStart;
      console.log(`[EPD] └─ ❌ Round ${round} ПРОВАЛЕН за ${(totalMs/1000).toFixed(1)}с`);
      console.log(`[EPD]    Попытки: EM×5 + AI + RuCaptcha = 0 верных. Новая капча...`);
      status(`🔄 Round ${round} провал, новая капча...`);
      await sleep(500);
      continue;

      if (r === "success") return;
      if (r === "slot_taken") { captchaOverlay.style.display = "none"; return "slot_taken"; }

      // Token expired → immediately get new captcha (don't waste time)
      if (r && r.tokenExpired) {
        console.log(`[EPD] Round ${round}: token expired → new captcha immediately`);
        status(`🔄 Токен истёк, новая капча...`);
        await sleep(500);
        continue;
      }

      console.log(`[EPD] Round ${round}: wrong answer → new captcha`);
      status(`❌ Round ${round}: новая капча...`);
      await sleep(1_000);
    }

    status("❌ Не удалось пройти капчу. Попробуйте нажать Тест капчи или вручную.");
  }
}

// ---------------------------------------------------------------------------
//  Creation mode — slot finder for NEW reservations
//  Triggered when inject.js detects both CreateDraftStepOne + AvailableDates.
// ---------------------------------------------------------------------------

function _tryInjectCreate() {
  // Need both reservationId (step 1) and facilityId (step 4)
  if (!_createCtx.reservationId || !_createCtx.facilityId) return;
  // Don't overlap with reschedule widget
  if (document.getElementById("epd2-root")) return;
  // Don't inject twice
  if (document.getElementById("epd2-create-root")) return;

  const root = document.createElement("div");
  root.id = "epd2-create-root";
  document.body.appendChild(root);
  _buildCreateUI(root);
  _attachCreateLogic(root);
  console.log("[EPD] ✅ Create-mode widget injected");
}

function _buildCreateUI(container) {
  // First available date as default
  const defaultDate = _createCtx.availDates[0] || new Date().toISOString().split("T")[0];
  container.innerHTML = `
    <div id="epd2c-panel" style="
      position:fixed;bottom:20px;right:20px;z-index:999999;
      background:#1a1a2e;color:#e0e0e0;border-radius:10px;
      padding:14px 16px;width:270px;font:13px/1.4 sans-serif;
      box-shadow:0 4px 24px rgba(0,0,0,.6);border:1px solid #444;">
      <div style="font-weight:700;font-size:14px;margin-bottom:10px;color:#7eb8f7">
        ⚡ EPD Helper — Новая заявка
      </div>
      <div style="font-size:9px;color:#666;margin-bottom:8px">
        Обновлено: ${EPD_BUILD}
      </div>
      <label style="display:block;margin-bottom:6px">
        Дата:
        <input id="epd2c-date" type="date" value="${defaultDate}"
          style="width:100%;margin-top:2px;padding:4px;border-radius:4px;border:1px solid #555;background:#2a2a40;color:#e0e0e0">
      </label>
      <label style="display:block;margin-bottom:6px">
        Время с:
        <input id="epd2c-from" type="time" value="00:00"
          style="width:100%;margin-top:2px;padding:4px;border-radius:4px;border:1px solid #555;background:#2a2a40;color:#e0e0e0">
      </label>
      <label style="display:block;margin-bottom:10px">
        Время до:
        <input id="epd2c-to" type="time" value="23:59"
          style="width:100%;margin-top:2px;padding:4px;border-radius:4px;border:1px solid #555;background:#2a2a40;color:#e0e0e0">
      </label>
      <label style="display:block;margin-bottom:10px">Скорость:
        <select id="epd2c-speed" style="width:100%;margin-top:2px;padding:4px;border-radius:4px;border:1px solid #555;background:#2a2a40;color:#e0e0e0">
          <option value="random" selected>🎲 Рандом (3-8с) — антиWAF</option>
          <option value="ultra">⚡ Ультра (3-7с)</option>
          <option value="fast">Быстро (15-30с)</option>
          <option value="normal">Нормально (45-90с)</option>
          <option value="safe">Безопасно (90-180с)</option>
        </select>
      </label>
      <div id="epd2c-status" style="min-height:32px;font-size:11px;background:#111;border-radius:4px;padding:5px 7px;margin-bottom:8px;color:#aaa;word-break:break-word"></div>
      <button id="epd2c-start" style="width:100%;padding:7px;border-radius:5px;border:none;background:#2ecc71;color:#fff;font-weight:700;cursor:pointer">▶ Старт</button>
      <button id="epd2c-stop"  style="width:100%;padding:7px;border-radius:5px;border:none;background:#e74c3c;color:#fff;font-weight:700;cursor:pointer;display:none">⏹ Стоп</button>
      <button id="epd2c-logs" style="width:100%;padding:5px;border-radius:4px;border:1px solid #555;background:#2a2a40;color:#aaa;font-size:11px;cursor:pointer;margin-top:6px">📋 Скачать логи</button>
      <button id="epd2c-upload-logs" style="width:100%;padding:5px;border-radius:4px;border:1px solid #555;background:#1b5e20;color:#ddd;font-size:11px;cursor:pointer;margin-top:4px">📤 Отправить логи → smrtcrm</button>
      <button id="epd2c-close" style="position:absolute;top:8px;right:10px;background:none;border:none;color:#888;font-size:18px;cursor:pointer">×</button>
    </div>`;
}

function _attachCreateLogic(root) {
  const $ = (id) => document.getElementById(id);
  const dateIn  = $("epd2c-date");
  const fromIn  = $("epd2c-from");
  const toIn    = $("epd2c-to");
  const statusEl = $("epd2c-status");
  const btnStart = $("epd2c-start");
  const btnStop  = $("epd2c-stop");
  const btnClose = $("epd2c-close");
  const btnLogs  = $("epd2c-logs");
  if (btnLogs) btnLogs.addEventListener("click", () => _epdDownloadLogs("manual"));
  const btnUploadLogs = $("epd2c-upload-logs");
  if (btnUploadLogs) {
    btnUploadLogs.addEventListener("click", async () => {
      st("Отправка логов на smrtcrm.ru…");
      const r = await _epdUploadLogs("manual", { promptForToken: true });
      if (r.ok) st(`✅ Логи на smrtcrm${r.id ? ` #${r.id}` : ""}`);
      else st(`❌ Логи: ${r.error || r.status || "ошибка"}`);
    });
  }

  let running = false;
  let checkCount = 0;
  let backoffMs  = 0;
  let _preSolvedToken = null; // { successToken, time, intervalIndex }

  function st(msg) { statusEl.textContent = msg; }

  function getSpeedCreate() {
    return SPEED_PRESETS[$("epd2c-speed")?.value] || SPEED_PRESETS.normal;
  }

  btnClose.addEventListener("click", () => {
    running = false;
    root.remove();
  });

  btnStart.addEventListener("click", () => {
    const date = dateIn.value;
    const from = fromIn.value;
    const to   = toIn.value;
    if (!date || !from || !to) { st("Заполните все поля"); return; }
    if (!_createCtx.reservationId) { st("⚠️ reservationId не получен. Обновите страницу."); return; }
    running    = true;
    backoffMs  = 0;
    checkCount = 0;
    btnStart.style.display = "none";
    btnStop.style.display  = "block";
    _pollCreate(date, hhmm2min(from), hhmm2min(to));
  });

  btnStop.addEventListener("click", () => {
    running = false;
    btnStart.style.display = "block";
    btnStop.style.display  = "none";
    _epdStatusUpload(st, "stop", "Остановлено");
  });

  async function _pollCreate(date, minT, maxT) {
    while (running) {
      checkCount++;

      if (backoffMs > 0) {
        let rem = backoffMs;
        while (rem > 0 && running) {
          const chunk = Math.min(10_000, rem);
          await sleep(chunk); rem -= chunk;
          if (rem > 0 && running) st(`⏳ Backoff ещё ${Math.round(rem/1000)}с… (#${checkCount})`);
        }
        if (!running) break;
        backoffMs = 0;
      }

      // WAF cooldown check
      if (_wafReqCount >= WAF_LIMIT && !_wafCoolingDown) {
        st(`🛡 WAF cooldown (${_wafReqCount} запросов), пауза 10-15с… (#${checkCount})`);
      }
      if (_wafCoolingDown) {
        st(`🛡 WAF cooldown, ждём… (#${checkCount})`);
      }
      await _wafGate();

      st(`🔍 Проверка #${checkCount} (WAF: ${_wafReqCount}/${WAF_LIMIT})…`);

      const params = {
        facilityId:          _createCtx.facilityId,
        vehicleId:           _createCtx.vehicleId,
        date:                date,
        transportType:       _createCtx.transportType,
        isCreateReservation: "true",   // KEY DIFFERENCE vs reschedule
      };

      // Check for intercepted response first
      let resp;
      const iAge = _interceptedSlots ? Date.now() - _interceptedSlots.ts : Infinity;
      if (iAge < 4_000) {
        resp = _interceptedSlots; _interceptedSlots = null;
        st(`♻️ Перехваченный ответ (#${checkCount})`);
      } else {
        try {
          resp = await fetchAvailableSlots(params);
          broadcastSlots(resp);
        } catch (err) {
          st(`⚠️ Сеть: ${err.message}`);
          await sleep(5_000); continue;
        }
      }

      if (resp.status === 401) {
        console.log("[EPD Create] 🔑 401 Unauthorized — сессия истекла, перезагрузка...");
        st("🔑 Сессия истекла! Перезагрузка...");
        running = false;
        await sleep(2000);
        window.location.reload();
        return;
      }

      if (resp.status === 429 || resp.status === 403 || resp.status === 406 || resp.status === 500) {
        if (_wafCheckBan(resp)) { running = false; return; }
        _wafForceReset();
        const forceCooldown = Math.round(rand(WAF_COOLDOWN_MIN, WAF_COOLDOWN_MAX));
        console.log(`[EPD Create] ${resp.status} → forced WAF cooldown ${forceCooldown / 1000}s`);
        backoffMs = forceCooldown;
        try {
          window.dispatchEvent(new MouseEvent("mousemove", { bubbles:true, clientX:Math.floor(rand(100,900)), clientY:Math.floor(rand(100,600)) }));
          window.dispatchEvent(new Event("focus"));
        } catch (_) {}
        st(`🛡 [${resp.status}] WAF cooldown ${Math.round(forceCooldown/1000)}с (#${checkCount})`);
        continue;
      }

      if (resp.status === 400 || !resp.data) {
        const sp = getSpeedCreate();
        const waitMs = rand(sp.min, sp.max);

        // PRE-SOLVE: while waiting for next poll, request and solve captcha
        // so when a slot appears, we already have a successToken ready.
        if (!_preSolvedToken && _createCtx.reservationId && _createCtx.facilityId) {
          st(`-- Нет слотов, pre-solving капчу пока ждём... (#${checkCount})`);
          console.log("[EPD Create] PRE-SOLVE: solving captcha during idle wait...");
          const preTsd = toISOSlot(date, "00:00:00"); // pre-solve for midnight slot
          const preCaptcha = await fetchCaptcha({
            facilityId: _createCtx.facilityId,
            reservationId: _createCtx.reservationId,
            timeSlotData: preTsd,
          });
          if (preCaptcha) {
            const preResult = await solvePuzzle(preCaptcha);
            if (preResult?.ranked?.length) {
              const emConf = preResult.confidence || 0;
              // If EM confident, validate now
              if (emConf > 0.25 && preResult.ranked[0]) {
                try {
                  const ok = await validateCaptcha({
                    answer: preResult.ranked[0].answer, captchaToken: preCaptcha.token, encryptedTso: null,
                    facilityId: _createCtx.facilityId,
                    reservationId: _createCtx.reservationId,
                    timeSlotData: preTsd,
                  });
                  if (ok) {
                    _preSolvedToken = { successToken: ok.successToken, time: "00:00:00", intervalIndex: 0 };
                    console.log("[EPD Create] PRE-SOLVED via EM! Token ready for slot 00:00");
                  }
                } catch (_) {}
              }
              // Also wait for RuCaptcha in background
              if (!_preSolvedToken) {
                const ruAns = await preResult.ruPromise;
                if (ruAns) {
                  try {
                    const ok = await validateCaptcha({
                      answer: ruAns, captchaToken: preCaptcha.token, encryptedTso: null,
                      facilityId: _createCtx.facilityId,
                      reservationId: _createCtx.reservationId,
                      timeSlotData: preTsd,
                    });
                    if (ok) {
                      _preSolvedToken = { successToken: ok.successToken, time: "00:00:00", intervalIndex: 0 };
                      console.log("[EPD Create] PRE-SOLVED via RuCaptcha! Token ready for slot 00:00");
                    }
                  } catch (_) {}
                }
              }
            }
          }
          if (!_preSolvedToken) st(`-- Нет слотов ${date}, ждём (#${checkCount})`);
        } else {
          st(`-- Нет слотов ${date}, через ${Math.round(waitMs/1000)}с (#${checkCount})`);
          await sleep(waitMs);
        }
        continue;
      }

      backoffMs = 0;
      const slots = (resp.data.slots || []).filter(s => {
        const t = hhmm2min(s.time);
        return minT <= maxT ? t >= minT && t <= maxT : t >= minT || t <= maxT;
      });

      st(`++ Слотов: ${(resp.data.slots||[]).length}, подходящих: ${slots.length} (#${checkCount})`);

      if (slots.length > 0) {
        try { new Audio(chrome.runtime.getURL("sounds/notification.mp3")).play().catch(()=>{}); } catch (_) {}

        slots.sort((a, b) => (b.count || 0) - (a.count || 0));
        const validSlots = slots.filter(s => !s.count || s.count > 0);
        console.log(`[EPD Create] ${validSlots.length} valid slots sorted by count`);

        // Check if we have a PRE-SOLVED token ready (solved during idle time)
        if (_preSolvedToken) {
          // Find a slot matching the pre-solved time
          const preSlot = validSlots.find(s => s.time === _preSolvedToken.time)
                       || validSlots.find(s => s.intervalIndex === _preSolvedToken.intervalIndex);
          if (preSlot) {
            st(`PRE-SOLVED! Мгновенная отправка ${preSlot.slotCaption}...`);
            console.log(`[EPD Create] PRE-SOLVED TOKEN USED for ${preSlot.slotCaption}!`);
            const tk = _preSolvedToken.successToken;
            _preSolvedToken = null;
            try {
              await submitDraft({
                reservationId: _createCtx.reservationId,
                facilityId: _createCtx.facilityId,
                arrivalDatePlan: date,
                intervalIndex: preSlot.intervalIndex,
                transportType: _createCtx.transportType,
                modeType: 1, isTso: false, encryptedTso: null,
                captchaToken: tk,
              });
              st(`🎉 МГНОВЕННО! Слот: ${preSlot.slotCaption}`);
              console.log(`[EPD Create] 🎉 INSTANT SUCCESS: ${preSlot.slotCaption}`);
              setTimeout(() => { window.location.href = `/en/reservations/reservation/${_createCtx.reservationId}`; }, 1500);
              running = false;
              btnStart.style.display = "block";
              btnStop.style.display  = "none";
              return;
            } catch (e) {
              if (e.slotTaken) {
                console.log(`[EPD Create] Pre-solved slot ${preSlot.slotCaption} taken, continuing...`);
              } else {
                console.log("[EPD Create] Pre-solved SubmitDraft error:", e.message);
              }
            }
          } else {
            _preSolvedToken = null;
            console.log("[EPD Create] Pre-solved token time doesn't match available slots");
          }
        }

        let gotSlot = false;
        for (let si = 0; si < validSlots.length && !gotSlot; si++) {
          const slot = validSlots[si];
          st(`🎯 Слот ${si+1}/${validSlots.length}: ${slot.slotCaption} (count=${slot.count})`);
          console.log(`[EPD Create] ═══ Slot ${si+1}/${validSlots.length}: ${slot.slotCaption} count=${slot.count} ═══`);

          const tsd = toISOSlot(date, slot.time);

          // Request captcha for THIS specific slot
          const captchaData = await fetchCaptcha({
            facilityId: _createCtx.facilityId,
            reservationId: _createCtx.reservationId,
            timeSlotData: tsd,
          });
          if (!captchaData) { st("Капча недоступна…"); await sleep(3_000); continue; }

          const result = await solvePuzzle(captchaData);
          if (!result?.ranked?.length) { st("Solver пуст…"); continue; }

          // Like ORIGINAL plugin: try TOP 5 variants with same token!
          // Server does NOT burn token on wrong answer.
          let successToken = null;
          const ranked = result.ranked;
          const delay = 800;
          const maxTries = Math.min(5, ranked.length);

          for (let attempt = 0; attempt < maxTries && !successToken; attempt++) {
            const c = ranked[attempt];
            st(`🧩 Вариант ${c.idx+1} (${attempt+1}/${maxTries})...`);
            console.log(`[EPD Create] Attempt ${attempt+1}/${maxTries}: variant ${c.idx}`);
            if (attempt > 0) await sleep(delay);
            try {
              const ok = await validateCaptcha({
                answer: c.answer, captchaToken: captchaData.token, encryptedTso: null,
                facilityId: _createCtx.facilityId,
                reservationId: _createCtx.reservationId,
                timeSlotData: tsd,
              });
              if (ok) { successToken = ok.successToken; console.log(`[EPD Create] ✅ Variant ${c.idx+1} validated!`); }
            } catch (e) { console.log(`[EPD Create] Variant ${c.idx+1}:`, e.message); break; }
          }

          // If EM failed, try RuCaptcha
          if (!successToken) {
            const ruAns = await result.ruPromise;
            if (ruAns) {
              st("👤 RuCaptcha ответил!");
              try {
                const ok = await validateCaptcha({
                  answer: ruAns, captchaToken: captchaData.token, encryptedTso: null,
                  facilityId: _createCtx.facilityId,
                  reservationId: _createCtx.reservationId,
                  timeSlotData: tsd,
                });
                if (ok) { successToken = ok.successToken; console.log("[EPD Create] ✅ RuCaptcha validated!"); }
              } catch (e) { console.log("[EPD Create] RuCaptcha:", e.message); }
            }
          }

          if (!successToken) {
            console.log("[EPD Create] No valid answer → next slot");
            continue;
          }

          // ── Submit with the validated token ──
          st(`✅ Капча OK → отправляем ${slot.slotCaption}...`);
          try {
            await submitDraft({
              reservationId:   _createCtx.reservationId,
              facilityId:      _createCtx.facilityId,
              arrivalDatePlan: date,
              intervalIndex:   slot.intervalIndex,
              transportType:   _createCtx.transportType,
              modeType: 1, isTso: false, encryptedTso: null,
              captchaToken: successToken,
            });
            st(`🎉 Заявка создана! Слот: ${slot.slotCaption}`);
            console.log(`[EPD Create] 🎉 SUCCESS: ${slot.slotCaption}`);
            setTimeout(() => { window.location.href = `/en/reservations/reservation/${_createCtx.reservationId}`; }, 1500);
            gotSlot = true;
            running = false;
            btnStart.style.display = "block";
            btnStop.style.display  = "none";
            return;
          } catch (e) {
            if (e.slotTaken) {
              console.log(`[EPD Create] ${slot.slotCaption} taken → next slot`);
              st(`⚡ ${slot.slotCaption} занят → следующий...`);
              continue;
            }
            console.log(`[EPD Create] SubmitDraft error:`, e.message);
            break;
          }
        }

        if (!gotSlot) {
          st("⚡ Все слоты заняты, ждём новые...");
          await sleep(3_000);
          continue;
        }
      }

      const sp2 = getSpeedCreate();
      const waitMs = rand(sp2.min, sp2.max);
      st(`Next in ${Math.round(waitMs/1000)}с (#${checkCount})`);
      await sleep(waitMs);
    }
  }

  async function _captchaCreate(slot, date, stFn) {
    const tsd = toISOSlot(date, slot.time);
    const MAX_ROUNDS = 6;
    const delay = 800;

    // Returns "success" | "slot_taken" | false
    async function tryAns(answer, token, label) {
      try {
        const ok = await validateCaptcha({
          answer, captchaToken: token, encryptedTso: null,
          facilityId: _createCtx.facilityId,
          reservationId: _createCtx.reservationId,
          timeSlotData: tsd,
        });
        if (ok) {
          stFn("✅ Капча OK! Подтверждаем заявку…");
          try {
            await submitDraft({
              reservationId:   _createCtx.reservationId,
              facilityId:      _createCtx.facilityId,
              arrivalDatePlan: date,
              intervalIndex:   slot.intervalIndex,
              transportType:   _createCtx.transportType,
              modeType: 1, isTso: false, encryptedTso: null,
              captchaToken: ok.successToken,
            });
            stFn("🎉 Заявка создана! Перенаправляем…");
            setTimeout(() => { window.location.href = `/en/reservations/reservation/${_createCtx.reservationId}`; }, 1500);
            return "success";
          } catch (e2) {
            if (e2.slotTaken) {
              console.log(`[EPD Create] ⚡ ${label}: капча OK, слот занят!`);
              stFn("⚡ Слот занят кем-то другим!");
              return "slot_taken";
            }
            console.log(`[EPD Create] ${label} submitDraft error:`, e2.message);
          }
        }
      } catch (e) {
        console.log(`[EPD Create] ${label} rejected:`, e.message);
      }
      return false;
    }

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      stFn(`Загружаем капчу (попытка ${round}/${MAX_ROUNDS})…`);
      const captchaData = await fetchCaptcha({
        facilityId:    _createCtx.facilityId,
        reservationId: _createCtx.reservationId,
        timeSlotData:  tsd,
      });
      if (!captchaData) { stFn("Капча недоступна, ждём 5с…"); await sleep(5_000); continue; }

      const result = await solvePuzzle(captchaData);
      if (!result?.ranked?.length) { stFn("Solver не вернул вариантов…"); await sleep(3_000); continue; }

      const { token } = captchaData;
      const ranked = result.ranked;
      let r;
      console.log(`[EPD Create] ─── Round ${round}: token=${token?.slice(0,12)}... variants=${ranked.length}`);

      // ── Phase A: EM#1 немедленно ──────────────────────────────────────────
      let validateCount = 0;
      const MAX_VALIDATES = 3;

      // ── Phase A: EM#1 немедленно ─────────────────────────────────────────
      if (ranked[0] && validateCount < MAX_VALIDATES) {
        const c = ranked[0]; stFn(`🧩 [A] EM#${c.idx+1} (conf=${(result.confidence*100).toFixed(1)}%)`);
        console.log(`[EPD Create] Phase A → EM#${c.idx}`);
        r = await tryAns(c.answer, token, `EM#${c.idx}`);
        validateCount++;
        if (r === "success") return;
        if (r === "slot_taken") return "slot_taken";
      }

      // ── Phase B: RuCaptcha (93% точность) ────────────────────────────────
      if (validateCount < MAX_VALIDATES) {
        stFn("👤 [B] Ждём RuCaptcha…"); console.log("[EPD Create] Phase B → RuCaptcha...");
        const ruAns = await result.ruPromise;
        if (ruAns) {
          stFn("👤 [B] RuCaptcha ответил!"); console.log("[EPD Create] Phase B → trying RuCaptcha...");
          r = await tryAns(ruAns, token, "RuCaptcha");
          validateCount++;
          if (r === "success") return;
          if (r === "slot_taken") return "slot_taken";
        } else { console.log("[EPD Create] Phase B → RuCaptcha: нет ответа"); }
      }

      // (Gemini removed)

      console.log(`[EPD Create] Round ${round}: все → новая капча`);
      stFn(`❌ Round ${round} → новая капча через 3с`); await sleep(3_000);
    }
    stFn("❌ Не удалось пройти капчу. Попробуйте вручную.");
  }
}

// ---------------------------------------------------------------------------
//  WAF ban detection — consecutive 403 with HTML → session is banned
// ---------------------------------------------------------------------------
let _wafBanCount = 0;
const WAF_BAN_THRESHOLD = 2;
const WAF_RUCAPTCHA_TIMEOUT_MS = 55_000;
const WAF_RUCAPTCHA_POLL_MS = 1500;
const WAF_RUCAPTCHA_KEY = "4d0958214769784f541776343e0ac05f";
const WAF_RUCAPTCHA_IN = "https://rucaptcha.com/in.php";
const WAF_RUCAPTCHA_RES = "https://rucaptcha.com/res.php";

function _wafExtensionAlive() {
  try {
    return !!chrome?.runtime?.id;
  } catch {
    return false;
  }
}

function _wafIsFetchError(msg) {
  return /failed to fetch|networkerror|network error|timeout|ERR_/i.test(String(msg || ""));
}

function _wafNetworkErrorHint(msg) {
  const m = String(msg || "");
  if (/failed to fetch/i.test(m)) {
    return "нет связи с rucaptcha.com — VPN или F5 после обновления расширения";
  }
  if (/extension context invalidated/i.test(m)) {
    return "Extension context invalidated";
  }
  return m;
}

function _wafSendMessage(msg, timeoutMs = 12_000) {
  return new Promise((resolve) => {
    let settled = false;
    const to = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ error: `timeout ${timeoutMs}ms` });
    }, timeoutMs);
    try {
      if (!_wafExtensionAlive()) {
        settled = true;
        clearTimeout(to);
        resolve({ error: "Extension context invalidated" });
        return;
      }
      chrome.runtime.sendMessage(msg, (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(to);
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message });
          return;
        }
        resolve(r ?? { error: "empty response" });
      });
    } catch (e) {
      if (!settled) { settled = true; clearTimeout(to); resolve({ error: e.message }); }
    }
  });
}

async function _wafRuCaptchaSubmitFetch(b64) {
  const formData = new URLSearchParams();
  formData.append("key", WAF_RUCAPTCHA_KEY);
  formData.append("method", "rotatecaptcha");
  formData.append("body", b64);
  formData.append("json", "1");
  const r = await fetch(WAF_RUCAPTCHA_IN, { method: "POST", body: formData });
  const res = await r.json();
  if (res.status === 1) return { taskId: res.request, via: "fetch" };
  return { error: String(res.request || "submit failed"), via: "fetch" };
}

async function _wafRuCaptchaPollFetch(taskId) {
  const pr = await fetch(`${WAF_RUCAPTCHA_RES}?key=${WAF_RUCAPTCHA_KEY}&action=get&id=${taskId}&json=1`);
  const poll = await pr.json();
  if (poll.status === 1) {
    return { status: "ready", angle: parseFloat(poll.request) || 0, via: "fetch" };
  }
  if (poll.request === "CAPCHA_NOT_READY") return { status: "pending", via: "fetch" };
  if (poll.request === "ERROR_CAPTCHA_UNSOLVABLE") return { status: "error", error: "UNSOLVABLE", via: "fetch" };
  return { status: "error", error: String(poll.request), via: "fetch" };
}

/** RuCaptcha: SW primary (надёжнее с WAF-страницы), fetch fallback. */
async function _wafRuCaptchaSubmit(b64) {
  if (_wafExtensionAlive()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const sw = await _wafSendMessage({ action: "submit-waf-rotate", b64 }, 20_000);
      if (sw?.taskId) {
        console.log("[EPD WAF Solver] RuCaptcha submit via SW");
        return sw;
      }
      const err = sw?.error || "submit failed";
      if (_wafIsContextInvalidated(err)) return { error: err };
      if (attempt === 0) {
        console.warn(`[EPD WAF Solver] SW submit attempt ${attempt + 1} failed:`, err);
        await sleep(400);
        continue;
      }
      console.warn("[EPD WAF Solver] SW submit failed, trying fetch:", err);
    }
  } else {
    console.warn("[EPD WAF Solver] Extension context stale — RuCaptcha via fetch");
  }

  try {
    const res = await _wafRuCaptchaSubmitFetch(b64);
    if (res?.taskId) console.log("[EPD WAF Solver] RuCaptcha submit via fetch");
    return res;
  } catch (e) {
    return { error: _wafNetworkErrorHint(e.message) };
  }
}

async function _wafRuCaptchaPoll(taskId) {
  if (_wafExtensionAlive()) {
    const sw = await _wafSendMessage({ action: "poll-waf-rotate", taskId }, 10_000);
    if (sw?.status) return sw;
    if (sw?.error && !_wafIsFetchError(sw.error)) {
      return { status: "error", error: sw.error };
    }
  }

  try {
    return await _wafRuCaptchaPollFetch(taskId);
  } catch (e) {
    return { status: "error", error: _wafNetworkErrorHint(e.message) };
  }
}

/** AITunnel vision — fallback когда rucaptcha.com недоступен (РФ/VPN). */
async function _wafSolveAngleAI(b64) {
  if (!AITUNNEL_KEY) return null;
  const prompt = `Rotation captcha. The photo must be rotated CLOCKWISE to appear upright and natural.
Return ONLY JSON: {"angle":NUMBER} — clockwise degrees 0-360 (integer or one decimal). No markdown, no text.`;
  const models = ["gemini-2.5-flash", "claude-sonnet-4.5"];

  for (const model of models) {
    try {
      const t0 = Date.now();
      const resp = await fetch(AITUNNEL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${AITUNNEL_KEY}` },
        body: JSON.stringify({
          model,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
            ],
          }],
          max_tokens: 80,
          temperature: 0,
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const text = (data.choices?.[0]?.message?.content || "").trim();
      let angle = null;
      const jsonM = text.match(/\{[\s\S]*?"angle"\s*:\s*(-?\d+(?:\.\d+)?)[\s\S]*?\}/);
      if (jsonM) angle = parseFloat(jsonM[1]);
      if (angle == null || Number.isNaN(angle)) {
        const numM = text.match(/(-?\d+(?:\.\d+)?)/);
        if (numM) angle = parseFloat(numM[1]);
      }
      if (angle == null || Number.isNaN(angle)) throw new Error(`bad angle: ${text.slice(0, 80)}`);
      angle = ((angle % 360) + 360) % 360;
      const ms = Date.now() - t0;
      const cost = data.usage?.cost_rub ?? "?";
      console.log(`[EPD WAF Solver] AI angle ${angle}° via ${model} (${ms}мс, ${cost}₽)`);
      return { angle, source: `AI:${model}` };
    } catch (e) {
      console.warn(`[EPD WAF Solver] AI ${model} failed:`, e.message);
    }
  }
  return null;
}

/** RuCaptcha → AITunnel cascade. */
async function _wafGetRotationAngle(b64, statusDiv) {
  statusDiv.textContent = "🤖 RuCaptcha…";
  const submit = await _wafRuCaptchaSubmit(b64);
  if (submit?.taskId) {
    statusDiv.textContent = "🤖 RuCaptcha ждёт ответ…";
    const result = await _wafPollRuCaptcha(submit.taskId);
    if (result?.angle !== undefined) {
      return { angle: result.angle, source: "RuCaptcha" };
    }
    console.warn("[EPD WAF Solver] RuCaptcha poll failed — fallback AI");
  } else {
    console.warn("[EPD WAF Solver] RuCaptcha unavailable:", submit?.error, "— fallback AI");
  }

  statusDiv.textContent = "🤖 AI определяет угол (AITunnel)…";
  const ai = await _wafSolveAngleAI(b64);
  if (ai) return ai;
  return null;
}

async function _wafApplyAngle(angle) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1200);
    const solveResult = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve({ method: "timeout", success: false }), 12_000);
      const handler = (ev) => {
        if (ev.data && ev.data.__epd_waf_solve_result) {
          window.removeEventListener("message", handler);
          clearTimeout(timeout);
          resolve(ev.data);
        }
      };
      window.addEventListener("message", handler);
      window.postMessage({ __epd_waf_solve: true, angle, attempt }, "*");
    });
    if (solveResult.success) return solveResult;
    console.warn(`[EPD WAF Solver] apply attempt ${attempt + 1} failed:`, solveResult.method);
  }
  return { method: "retries-exhausted", success: false };
}

/** Pick rotate-captcha image (not logo/banner). Prefer #captcha-holder, square ~100–320px. */
function _wafFindCaptchaElement() {
  const holders = document.querySelectorAll("#captcha-holder, .captcha, [class*='captcha'], [id*='captcha']");
  const candidates = [];
  for (const holder of holders) {
    for (const el of holder.querySelectorAll("img, canvas")) candidates.push(el);
  }
  if (!candidates.length) {
    for (const el of document.querySelectorAll("img, canvas")) candidates.push(el);
  }
  let best = null, bestScore = Infinity;
  for (const el of candidates) {
    const w = el.naturalWidth || el.width || 0;
    const h = el.naturalHeight || el.height || 0;
    if (w < 40 || h < 40) continue;
    const maxSide = Math.max(w, h);
    if (maxSide > 480) continue;
    const squareness = Math.abs(w - h);
    const sizePenalty = maxSide > 320 ? (maxSide - 320) * 2 : 0;
    const score = squareness + sizePenalty + maxSide * 0.1;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  return best;
}

function _wafElementToB64(el, maxDim = 320) {
  let w = el.naturalWidth || el.width || 200;
  let h = el.naturalHeight || el.height || 200;
  if (!w || !h) return null;
  if (w > maxDim || h > maxDim) {
    const scale = maxDim / Math.max(w, h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(el, 0, 0, w, h);
  return canvas.toDataURL("image/png").replace(/^data:image\/\w+;base64,/, "");
}

async function _wafPollRuCaptcha(taskId) {
  const t0 = Date.now();
  await sleep(2000);
  while (Date.now() - t0 < WAF_RUCAPTCHA_TIMEOUT_MS) {
    try {
      const poll = await _wafRuCaptchaPoll(taskId);
      if (poll?.status === "ready" && poll.angle !== undefined) return poll;
      if (poll?.status === "error") {
        console.error("[EPD WAF Solver] RuCaptcha poll error:", poll.error);
        return null;
      }
    } catch (e) {
      console.error("[EPD WAF Solver] RuCaptcha poll fetch error:", e.message);
      return null;
    }
    await sleep(WAF_RUCAPTCHA_POLL_MS);
  }
  console.error("[EPD WAF Solver] RuCaptcha poll timeout");
  return null;
}

function _wafIsContextInvalidated(reason) {
  return /extension context invalidated/i.test(String(reason || ""));
}

function _wafShowManualExit(statusDiv, reason) {
  const invalidated = _wafIsContextInvalidated(reason);
  if (invalidated) {
    statusDiv.textContent = "⚠️ Расширение обновлено — перезагрузите страницу (F5)";
  } else if (reason) {
    statusDiv.textContent = reason;
  }
  statusDiv.style.color = "#f39c12";
  const params = new URLSearchParams(location.search);
  const backUrl = params.get("back_location") || "https://eopp.epd-portal.ru/";
  if (invalidated) {
    const reloadBtn = document.createElement("button");
    reloadBtn.textContent = "🔄 Перезагрузить страницу (F5)";
    reloadBtn.style.cssText = "display:block;margin-top:8px;padding:6px 12px;border:none;border-radius:4px;background:#27ae60;color:#fff;cursor:pointer;font:13px sans-serif";
    reloadBtn.onclick = () => { window.location.reload(); };
    statusDiv.appendChild(reloadBtn);
  }
  const retryBtn = document.createElement("button");
  retryBtn.textContent = "🔄 Повторить авто-решение";
  retryBtn.style.cssText = "display:block;margin-top:8px;padding:6px 12px;border:none;border-radius:4px;background:#8e44ad;color:#fff;cursor:pointer;font:13px sans-serif";
  retryBtn.onclick = () => { statusDiv.remove(); _wafCaptchaSolver(); };
  statusDiv.appendChild(retryBtn);
  const btn = document.createElement("button");
  btn.textContent = "↩ Вернуться на сайт";
  btn.style.cssText = "display:block;margin-top:8px;padding:6px 12px;border:none;border-radius:4px;background:#3498db;color:#fff;cursor:pointer;font:13px sans-serif";
  btn.onclick = () => { window.location.href = backUrl; };
  statusDiv.appendChild(btn);
  const hint = document.createElement("div");
  hint.style.cssText = "margin-top:6px;font:12px sans-serif;color:#bdc3c7";
  const manualRotate = /вручную|авто-решение/i.test(String(reason || ""));
  hint.textContent = invalidated
    ? "Старая вкладка потеряла связь с расширением после его перезагрузки"
    : manualRotate
      ? "Поверните изображение слайдером до правильного положения и нажмите «Подтвердить»"
      : "Или решите капчу вручную на этой странице";
  statusDiv.appendChild(hint);
}

function _wafCheckBan(resp) {
  if (resp.status === 403 && resp.errorBody && typeof resp.errorBody === "string" && resp.errorBody.includes("<!DOCTYPE")) {
    _wafBanCount++;
    console.log(`[EPD WAF] Ban counter: ${_wafBanCount}/${WAF_BAN_THRESHOLD}`);
    if (_wafBanCount >= WAF_BAN_THRESHOLD) {
      console.log("[EPD WAF] 🚨 Session banned! Attempting page reload to clear WAF state...");
      // Don't redirect to /xpvnsulc/ — WAF may show bare 403 or captcha.
      // Reload the current page; if WAF wants captcha, browser will redirect there automatically.
      window.location.reload();
      return true;
    }
  } else if (resp.status >= 200 && resp.status < 400) {
    _wafBanCount = 0;
  }
  return false;
}

// ---------------------------------------------------------------------------
//  WAF CAPTCHA auto-solver — runs on /xpvnsulc/ page
//  Extracts the rotation image, sends to RuCaptcha, moves slider, submits.
// ---------------------------------------------------------------------------
async function _wafCaptchaSolver() {
  if (!location.pathname.startsWith("/xpvnsulc")) return;

  console.log("[EPD WAF Solver] 🔓 CAPTCHA page detected, starting auto-solve...");

  if (!_wafExtensionAlive()) {
    console.warn("[EPD WAF Solver] Extension context stale — RuCaptcha через fetch; если не сработает, F5");
  }

  await sleep(2000);

  const bodyText = document.body?.innerText || "";
  const hasCaptchaWidget = document.querySelector("#captcha-holder, .captcha, [class*='captcha']");

  if (!hasCaptchaWidget && (bodyText.includes("403") || bodyText.includes("Forbidden"))) {
    console.log("[EPD WAF Solver] No CAPTCHA widget found — bare 403 page. Redirecting to back_location...");
    const params = new URLSearchParams(location.search);
    const backUrl = params.get("back_location");
    if (backUrl) {
      console.log("[EPD WAF Solver] Returning to:", backUrl);
      await sleep(3000);
      window.location.href = backUrl;
    } else {
      console.log("[EPD WAF Solver] No back_location, going to main page...");
      await sleep(3000);
      window.location.href = "https://eopp.epd-portal.ru/";
    }
    return;
  }

  const statusDiv = document.createElement("div");
  statusDiv.style.cssText = "position:fixed;bottom:20px;right:20px;background:#1a1a2e;color:#2ecc71;padding:12px 18px;border-radius:8px;font:14px sans-serif;z-index:999999;box-shadow:0 4px 12px rgba(0,0,0,.5);max-width:320px";
  statusDiv.textContent = "🤖 Решаю WAF-капчу через RuCaptcha...";
  document.body.appendChild(statusDiv);

  const captchaEl = _wafFindCaptchaElement();
  if (!captchaEl) {
    console.error("[EPD WAF Solver] CAPTCHA element not found");
    _wafShowManualExit(statusDiv, "⚠️ Капча не найдена на странице.");
    return;
  }

  let b64 = null;
  try {
    b64 = _wafElementToB64(captchaEl);
  } catch (e) {
    console.error("[EPD WAF Solver] Cannot extract image:", e.message);
    if (captchaEl.tagName === "IMG" && captchaEl.src?.startsWith("data:")) {
      b64 = captchaEl.src.replace(/^data:image\/\w+;base64,/, "");
    }
  }

  if (!b64 || b64.length < 100) {
    console.error("[EPD WAF Solver] Image extraction failed (too small or empty)");
    _wafShowManualExit(statusDiv, "⚠️ Не удалось извлечь изображение капчи.");
    return;
  }

  const elW = captchaEl.naturalWidth || captchaEl.width || "?";
  const elH = captchaEl.naturalHeight || captchaEl.height || "?";
  console.log(`[EPD WAF Solver] Image ${elW}×${elH}, ${(b64.length / 1024).toFixed(1)}KB b64, sending to RuCaptcha...`);
  statusDiv.textContent = `🤖 RuCaptcha… (${elW}×${elH})`;

  try {
    const solved = await _wafGetRotationAngle(b64, statusDiv);
    if (!solved) {
      console.error("[EPD WAF Solver] RuCaptcha + AI failed");
      _wafShowManualExit(statusDiv, "❌ Авто-решение недоступно — поверните слайдер вручную");
      return;
    }

    const { angle, source } = solved;
    console.log(`[EPD WAF Solver] ✅ Angle: ${angle}° (${source}), applying…`);
    statusDiv.textContent = `✅ Угол: ${angle}° (${source}), применяю…`;

    const solveResult = await _wafApplyAngle(angle);
    console.log("[EPD WAF Solver] MAIN world result:", JSON.stringify(solveResult));

    if (solveResult.success) {
      statusDiv.textContent = `⏳ Капча решена (${solveResult.method}), ожидаем redirect…`;
      statusDiv.style.color = "#2ecc71";
    } else {
      _wafShowManualExit(statusDiv, `⚠️ Авто-поворот не сработал (${solveResult.method || "fail"}).`);
    }

    await sleep(5000);
    if (location.pathname.startsWith("/xpvnsulc")) {
      _wafShowManualExit(statusDiv, "⚠️ Redirect не произошёл.");
    }
  } catch (err) {
    const msg = _wafNetworkErrorHint(err.message);
    console.error("[EPD WAF Solver] Error:", msg);
    _wafShowManualExit(statusDiv, _wafIsContextInvalidated(msg) ? msg : `❌ Ошибка: ${msg}`);
  }
}

// SPA URL watcher — Angular changes URL without page reload
let lastUrl = location.href;
setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    cleanup();
    setTimeout(tryInject, 1000);
  }
}, 500);

if (location.pathname.startsWith("/xpvnsulc")) {
  _wafCaptchaSolver();
} else {
  setTimeout(tryInject, 2000);
}
