// ---------------------------------------------------------------------------
//  EPD Helper v2 — Background Service Worker
//  RuCaptcha: submit and poll individual numbered tasks (majority vote)
// ---------------------------------------------------------------------------

const RUCAPTCHA_KEY = "4d0958214769784f541776343e0ac05f";
const RUCAPTCHA_IN  = "https://rucaptcha.com/in.php";
const RUCAPTCHA_RES = "https://rucaptcha.com/res.php";

/** HTTP header values must be ISO-8859-1; strip/replace everything else. */
function _latin1Header(value, maxLen = 200) {
  return String(value ?? "")
    .replace(/\u2014|\u2013/g, "-")
    .replace(/[^\u0000-\u00FF]/g, "?")
    .slice(0, maxLen);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  // Submit one numbered image task
  if (msg.action === "solve-one-numbered") {
    (async () => {
      try {
        const n = msg.variantCount;
        const formData = new URLSearchParams();
        formData.append("key", RUCAPTCHA_KEY);
        formData.append("method", "base64");
        formData.append("body", msg.b64);
        formData.append("json", "1");
        formData.append("numeric", "1");
        formData.append("minLength", "1");
        formData.append("maxLength", "2");
        formData.append("lang", "ru");
        formData.append("textinstructions",
          `На картинке ${n} пронумерованных пазлов (1-${n}). ` +
          `Каждый пазл — это сетка 3×3 из 9 кусочков фотографии. ` +
          `Только в ОДНОМ пазле все 9 кусочков правильно сложены и образуют целую фотографию без видимых разрывов на стыках. ` +
          `В остальных пазлах кусочки перемешаны — видны резкие границы между соседними кусочками. ` +
          `Напишите ОДНУ цифру — номер правильно собранного пазла.`
        );

        const r = await fetch(RUCAPTCHA_IN, { method: "POST", body: formData });
        const res = await r.json();
        if (res.status === 1) {
          console.log(`[BG] Worker ${msg.workerNum}: task ${res.request}`);
          sendResponse({ taskId: res.request, workerNum: msg.workerNum });
        } else {
          console.log(`[BG] Worker ${msg.workerNum} submit failed:`, res.request);
          sendResponse(null);
        }
      } catch (e) {
        console.error("[BG] Submit:", e.message);
        sendResponse(null);
      }
    })();
    return true;
  }

  // Single poll check — content script calls this repeatedly
  if (msg.action === "poll-one-check") {
    (async () => {
      try {
        const r = await fetch(`${RUCAPTCHA_RES}?key=${RUCAPTCHA_KEY}&action=get&id=${msg.taskId}&json=1`);
        const poll = await r.json();
        if (poll.status === 1) {
          const raw = String(poll.request).trim();
          const nums = raw.match(/\d+/g);
          if (nums) {
            const variant = parseInt(nums[0]) - 1;
            sendResponse({ status: "done", variant: (variant >= 0 && variant < 15) ? variant : -1, raw });
          } else {
            sendResponse({ status: "done", variant: -1, raw });
          }
        } else if (poll.request === "ERROR_CAPTCHA_UNSOLVABLE") {
          sendResponse({ status: "done", variant: -1, raw: "UNSOLVABLE" });
        } else if (poll.request === "CAPCHA_NOT_READY") {
          sendResponse({ status: "pending" });
        } else {
          sendResponse({ status: "done", variant: -1, error: String(poll.request) });
        }
      } catch (e) {
        sendResponse({ status: "error", error: e.message });
      }
    })();
    return true;
  }

  // WAF rotation CAPTCHA — submit only (poll from content.js to avoid SW sleep)
  if (msg.action === "submit-waf-rotate") {
    (async () => {
      try {
        const formData = new URLSearchParams();
        formData.append("key", RUCAPTCHA_KEY);
        formData.append("method", "rotatecaptcha");
        formData.append("body", msg.b64);
        formData.append("json", "1");

        const r = await fetch(RUCAPTCHA_IN, { method: "POST", body: formData });
        const res = await r.json();
        if (res.status === 1) {
          console.log(`[BG] WAF rotate: task ${res.request}`);
          sendResponse({ taskId: res.request });
        } else {
          console.log("[BG] WAF rotate submit failed:", res.request);
          sendResponse({ error: String(res.request || "submit failed") });
        }
      } catch (e) {
        console.error("[BG] WAF rotate submit:", e.message);
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (msg.action === "poll-waf-rotate") {
    (async () => {
      try {
        const pr = await fetch(`${RUCAPTCHA_RES}?key=${RUCAPTCHA_KEY}&action=get&id=${msg.taskId}&json=1`);
        const poll = await pr.json();
        if (poll.status === 1) {
          const angle = parseFloat(poll.request) || 0;
          console.log(`[BG] WAF rotate solved: angle=${angle}°`);
          sendResponse({ status: "ready", angle });
        } else if (poll.request === "CAPCHA_NOT_READY") {
          sendResponse({ status: "pending" });
        } else if (poll.request === "ERROR_CAPTCHA_UNSOLVABLE") {
          sendResponse({ status: "error", error: "UNSOLVABLE" });
        } else {
          sendResponse({ status: "error", error: String(poll.request) });
        }
      } catch (e) {
        sendResponse({ status: "error", error: e.message });
      }
    })();
    return true;
  }

  // Legacy: single-shot (kept for compatibility)
  if (msg.action === "solve-waf-rotate") {
    (async () => {
      try {
        const formData = new URLSearchParams();
        formData.append("key", RUCAPTCHA_KEY);
        formData.append("method", "rotatecaptcha");
        formData.append("body", msg.b64);
        formData.append("json", "1");

        const r = await fetch(RUCAPTCHA_IN, { method: "POST", body: formData });
        const res = await r.json();
        if (res.status === 1) {
          console.log(`[BG] WAF rotate: task ${res.request}`);

          for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, i === 0 ? 2000 : 1500));
            try {
              const pr = await fetch(`${RUCAPTCHA_RES}?key=${RUCAPTCHA_KEY}&action=get&id=${res.request}&json=1`);
              const poll = await pr.json();
              if (poll.status === 1) {
                const angle = parseFloat(poll.request) || 0;
                console.log(`[BG] WAF rotate solved: angle=${angle}°`);
                sendResponse({ angle, taskId: res.request });
                return;
              }
              if (poll.request === "ERROR_CAPTCHA_UNSOLVABLE") {
                console.log("[BG] WAF rotate: unsolvable");
                sendResponse(null);
                return;
              }
              if (poll.request !== "CAPCHA_NOT_READY") {
                console.log("[BG] WAF rotate error:", poll.request);
                sendResponse(null);
                return;
              }
            } catch (e) { console.error("[BG] WAF rotate poll:", e.message); }
          }
          sendResponse(null);
        } else {
          console.log("[BG] WAF rotate submit failed:", res.request);
          sendResponse(null);
        }
      } catch (e) {
        console.error("[BG] WAF rotate:", e.message);
        sendResponse(null);
      }
    })();
    return true;
  }

  // ═══ CLICK CAPTCHA — CoordinatesTask ═══
  if (msg.action === "solve-click-captcha") {
    (async () => {
      try {
        const formData = new URLSearchParams();
        formData.append("key", RUCAPTCHA_KEY);
        formData.append("method", "base64");
        formData.append("body", msg.b64);
        formData.append("json", "1");
        formData.append("coordinatescaptcha", "1");
        formData.append("lang", "ru");
        formData.append("textinstructions",
          "На картинке сверху — фон с иконками. Внизу показано, в каком порядке нажимать (слева направо). " +
          "Кликните на каждую иконку В ПОРЯДКЕ, указанном снизу."
        );

        console.log("[BG] Click captcha: submitting to RuCaptcha...");
        const r = await fetch(RUCAPTCHA_IN, { method: "POST", body: formData });
        const res = await r.json();
        if (res.status === 1) {
          console.log(`[BG] Click captcha task: ${res.request}`);
          sendResponse({ taskId: res.request });
        } else {
          console.log("[BG] Click captcha submit failed:", res.request);
          sendResponse({ error: String(res.request) });
        }
      } catch (e) {
        console.error("[BG] Click captcha:", e.message);
        sendResponse({ error: "fetch: " + e.message });
      }
    })();
    return true;
  }

  // Poll click captcha result
  if (msg.action === "poll-click-captcha") {
    (async () => {
      try {
        const r = await fetch(`${RUCAPTCHA_RES}?key=${RUCAPTCHA_KEY}&action=get&id=${msg.taskId}&json=1`);
        const poll = await r.json();
        if (poll.status === 1) {
          const raw = String(poll.request).trim();
          console.log(`[BG] Click captcha solved raw:`, JSON.stringify(poll.request));
          console.log(`[BG] Click captcha solved string: ${raw}`);
          // Parse "x=347,y=192;x=195,y=180;..." format
          const coords = [];
          const pairs = raw.split(";").filter(Boolean);
          for (const pair of pairs) {
            const xm = pair.match(/x[=:](\d+)/i);
            const ym = pair.match(/y[=:](\d+)/i);
            if (xm && ym) coords.push({ x: parseInt(xm[1]), y: parseInt(ym[1]) });
          }
          if (coords.length > 0) {
            sendResponse({ status: "ready", coords });
          } else {
            // Try other formats: JSON array, or "click:x=N,y=N" etc
            try {
              // raw might already be parsed as object by json endpoint
              if (typeof poll.request === 'object' && Array.isArray(poll.request)) {
                sendResponse({ status: "ready", coords: poll.request });
                return;
              }
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) {
                sendResponse({ status: "ready", coords: parsed });
              } else {
                sendResponse({ status: "error", error: "Unknown format: " + raw.slice(0, 100) });
              }
            } catch (_) {
              // Try "click" format: "click:x=123,y=456\nclick:x=789,y=012"
              const clicks = raw.split(/[\n;|]/).filter(Boolean);
              const clickCoords = [];
              for (const c of clicks) {
                const xm = c.match(/(\d+)[,;:\s]+(\d+)/);
                if (xm) clickCoords.push({ x: parseInt(xm[1]), y: parseInt(xm[2]) });
              }
              if (clickCoords.length > 0) {
                sendResponse({ status: "ready", coords: clickCoords });
              } else {
                sendResponse({ status: "error", error: "Parse error: " + raw.slice(0, 100) });
              }
            }
          }
        } else if (poll.request === "CAPCHA_NOT_READY") {
          sendResponse({ status: "pending" });
        } else if (poll.request === "ERROR_CAPTCHA_UNSOLVABLE") {
          sendResponse({ status: "error", error: "UNSOLVABLE" });
        } else {
          sendResponse({ status: "error", error: String(poll.request) });
        }
      } catch (e) {
        sendResponse({ status: "error", error: e.message });
      }
    })();
    return true;
  }

  // Legacy handlers
  if (msg.action === "upload-epd-logs") {
    (async () => {
      try {
        const r = await fetch(msg.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${_latin1Header(msg.token, 500)}`,
            "X-EPD-Build": _latin1Header(msg.report?.build),
            "X-EPD-Tag": _latin1Header(msg.report?.tag),
          },
          body: JSON.stringify(msg.report),
        });
        const text = await r.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) {
          data = { raw: text.slice(0, 500) };
        }
        if (!r.ok) {
          sendResponse({
            ok: false,
            status: r.status,
            error: data?.error || data?.message || text.slice(0, 300),
          });
          return;
        }
        sendResponse({
          ok: true,
          status: r.status,
          id: data?.id,
          view_url: data?.view_url,
        });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.action === "solve-captcha-ru" || msg.action === "solve-yes-no" ||
      msg.action === "solve-one-yesno" || msg.action === "poll-one-yesno") {
    sendResponse(-1);
    return true;
  }
});
