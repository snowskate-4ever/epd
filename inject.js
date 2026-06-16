// inject.js — runs in PAGE context (not content-script isolated world).
// Intercepts both window.fetch AND XMLHttpRequest (Angular uses XHR by default).
// Forwards slot data + creation-flow params to content.js via postMessage.
(function () {
  "use strict";
  if (window.__epd_hooked) return;
  window.__epd_hooked = true;

  // ── Shared helper ──────────────────────────────────────────────────────────

  function handleUrl(url, status, responseText, requestBody) {
    try {
      // AvailableSlots — free slot data for both create and reschedule modes
      if (url.includes("/timeslot/AvailableSlots")) {
        let data = null;
        try { data = JSON.parse(responseText); } catch (_) {}
        const msg = { __epd_slots: true, status, data, ts: Date.now() };
        if (status >= 400 && status !== 400) {
          msg.rawText = (responseText || "").slice(0, 2000);
        }
        window.postMessage(msg, "*");
      }

      // AvailableDates — extract facilityId / vehicleId / transportType
      // Called by Angular when user selects a checkpoint in step 4
      if (url.includes("/timeslot/AvailableDates")) {
        try {
          const u = new URL(url, location.origin);
          const p = u.searchParams;
          const dates = JSON.parse(responseText);
          window.postMessage({
            __epd_create_params: true,
            facilityId:    p.get("facilityId"),
            vehicleId:     p.get("vehicleId"),
            transportType: parseInt(p.get("transportType")) || 1,
            dates: Array.isArray(dates) ? dates : [],
            ts: Date.now(),
          }, "*");
        } catch (_) {}
      }

      // captcha-validate — capture successful manual captcha solutions for cache
      if (url.includes("/captcha-validate") && status === 200) {
        try {
          const respData = JSON.parse(responseText);
          if (respData?.isValid === true && requestBody) {
            const reqData = JSON.parse(requestBody);
            if (reqData?.answer && Array.isArray(reqData.answer)) {
              console.log("[EPD inject] MANUAL CAPTCHA SOLVED! Saving tiles...");
              window.postMessage({
                __epd_captcha_solved: true,
                answer: reqData.answer, // correct tile order
                captchaToken: reqData.captchaToken,
                ts: Date.now(),
              }, "*");
            }
          }
        } catch (_) {}
      }

      // captcha response — save puzzle data for cache matching
      if (url.includes("/captcha") && !url.includes("validate") && status === 200) {
        try {
          const data = JSON.parse(responseText);
          if (data?.puzzle?.tiles) {
            window.postMessage({
              __epd_captcha_data: true,
              tiles: data.puzzle.tiles.map(t => {
                const d = t.imageData, len = d.length;
                const p1 = Math.floor(len * 0.3), p2 = Math.floor(len * 0.5), p3 = Math.floor(len * 0.7);
                return { tileId: t.tileId, fp: d.slice(p1, p1+50) + d.slice(p2, p2+50) + d.slice(p3, p3+50) };
              }),
              ts: Date.now(),
            }, "*");
          }
        } catch (_) {}
      }

      // CreateDraftStepOne — extract reservationId for the new draft
      if (url.includes("/ReservationStepOne/CreateDraftStepOne")) {
        try {
          const data = JSON.parse(responseText);
          if (data?.isSuccess && data?.payload?.reservationRequestId) {
            window.postMessage({
              __epd_draft_created: true,
              reservationId: data.payload.reservationRequestId,
              ts: Date.now(),
            }, "*");
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  // ── fetch interceptor ──────────────────────────────────────────────────────
  const _origFetch = window.fetch;
  window.fetch = async function (...args) {
    const req  = args[0];
    const init = args[1] || {};
    const url  = typeof req === "string" ? req
               : req instanceof Request  ? req.url : String(req);

    const response = await _origFetch.apply(this, args);
    try {
      const clone = response.clone();
      const text  = await clone.text();
      handleUrl(url, response.status, text, init.body || null);
    } catch (_) {}
    return response;
  };

  // ── XHR interceptor (Angular HttpClient) ──────────────────────────────────
  const _XHROpen = XMLHttpRequest.prototype.open;
  const _XHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__epdUrl    = url;
    this.__epdMethod = method;
    return _XHROpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const url  = this.__epdUrl || "";
    const self = this;

    this.addEventListener("load", function () {
      handleUrl(url, self.status, self.responseText, body);
    });

    return _XHRSend.apply(this, arguments);
  };

  // ── SignalR WebSocket interceptor ────────────────────────────────────────
  // Capture all incoming SignalR hub messages for slot detection.
  // SignalR JSON protocol: messages separated by 0x1E, each is JSON with
  // { type, target, arguments }.
  const _origWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    const ws = protocols ? new _origWS(url, protocols) : new _origWS(url);

    ws.addEventListener("message", function (e) {
      if (typeof e.data !== "string") return;
      // SignalR separates messages with 0x1E
      const parts = e.data.split("\x1e").filter(Boolean);
      for (const part of parts) {
        try {
          const msg = JSON.parse(part);
          if (msg.type === 1 && msg.target) {
            // Invocation message — forward to content.js
            console.log("[EPD SignalR]", msg.target, msg.arguments);
            window.postMessage({
              __epd_signalr: true,
              target: msg.target,
              arguments: msg.arguments || [],
              ts: Date.now(),
            }, "*");
          }
        } catch (_) {}
      }
    });

    return ws;
  };
  window.WebSocket.prototype = _origWS.prototype;
  window.WebSocket.CONNECTING = _origWS.CONNECTING;
  window.WebSocket.OPEN = _origWS.OPEN;
  window.WebSocket.CLOSING = _origWS.CLOSING;
  window.WebSocket.CLOSED = _origWS.CLOSED;

  // ── MAIN-world API bridge ────────────────────────────────────────────────
  // Content script sends {__epd_api_request} messages here.
  // We execute fetch() in PAGE context → Sec-Fetch-Site: same-origin (!)
  // This makes requests indistinguishable from Angular's own XHR calls.
  window.addEventListener("message", function (ev) {
    if (!ev.data || ev.data.source !== "__epd_api_request") return;
    const { id, method, url, body, headers } = ev.data;

    const opts = {
      method: method || "GET",
      credentials: "include",
      headers: {},
    };
    if (headers) {
      for (const [k, v] of Object.entries(headers)) opts.headers[k] = v;
    }
    if (body && method !== "GET") opts.body = JSON.stringify(body);

    fetch(url, opts)
      .then(async (resp) => {
        let data = null;
        const text = await resp.text();
        try { data = JSON.parse(text); } catch (_) {}
        const respHeaders = {};
        try { resp.headers.forEach((v, k) => { respHeaders[k] = v; }); } catch (_) {}
        window.postMessage({
          source: "__epd_api_response",
          id,
          status: resp.status,
          data,
          rawText: (resp.status >= 400 && !data) ? text.slice(0, 2000) : undefined,
          respHeaders: resp.status >= 400 ? respHeaders : undefined,
          retryAfterMs: resp.status === 429
            ? (parseInt(resp.headers.get("Retry-After") || "0") || 0) * 1000
            : 0,
        }, "*");
      })
      .catch((err) => {
        window.postMessage({
          source: "__epd_api_response",
          id,
          status: 0,
          data: null,
          error: err.message,
        }, "*");
      });
  });

  // ── WAF CAPTCHA solver bridge ─────────────────────────────────────────────
  // content.js sends the angle, we apply it directly to the Captcha object
  // because only MAIN world can access window.myCaptcha and dispatch trusted-like
  // interactions that the captcha widget accepts.
  function _wafSetRangeSlider(angle) {
    const holder = document.querySelector("#captcha-holder, .captcha, [class*='captcha']");
    const ranges = holder
      ? [...holder.querySelectorAll("input[type='range']")]
      : [...document.querySelectorAll("input[type='range']")];
    let moved = false;
    for (const range of ranges) {
      const min = parseFloat(range.min);
      const max = parseFloat(range.max);
      const lo = Number.isFinite(min) ? min : 0;
      const hi = Number.isFinite(max) ? max : 360;
      let val = angle;
      if (hi - lo <= 180 && angle > hi) val = angle % (hi - lo + 1);
      if (angle > hi && hi > lo) val = lo + ((angle % 360) / 360) * (hi - lo);
      val = Math.round(Math.max(lo, Math.min(hi, val)) * 10) / 10;
      range.value = String(val);
      range.dispatchEvent(new Event("input", { bubbles: true }));
      range.dispatchEvent(new Event("change", { bubbles: true }));
      console.log("[EPD inject] slider", lo, "-", hi, "→", val);
      moved = true;
    }
    return moved;
  }

  function _wafDragSlider(angle) {
    const track = document.querySelector(
      "#captcha-holder [class*='slider'], .captcha [class*='slider'], [class*='rotate'] [class*='slider'], .slider, .range"
    );
    if (!track) return false;
    const rect = track.getBoundingClientRect();
    if (rect.width < 10) return false;
    const pct = ((angle % 360) / 360);
    const x = rect.left + rect.width * pct;
    const y = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
    track.dispatchEvent(new MouseEvent("mousedown", opts));
    track.dispatchEvent(new MouseEvent("mousemove", opts));
    track.dispatchEvent(new MouseEvent("mouseup", opts));
    console.log("[EPD inject] slider drag at", pct.toFixed(2));
    return true;
  }

  function _wafClickSubmit() {
    const holder = document.querySelector("#captcha-holder, .captcha, [class*='captcha']");
    const scope = holder || document;
    const buttons = scope.querySelectorAll("button, a, [role='button'], input[type='submit']");
    for (const btn of buttons) {
      const t = ((btn.textContent || btn.value || "") + " " + (btn.className || "")).toLowerCase();
      if (/подтверд|отправ|провер|submit|verify|continue|продолж|готово|войти|enter/i.test(t)) {
        console.log("[EPD inject] click submit:", t.slice(0, 40));
        btn.click();
        return true;
      }
    }
    const form = scope.querySelector("form") || document.querySelector("form");
    if (form) {
      try { form.requestSubmit ? form.requestSubmit() : form.submit(); return true; } catch (_) {}
    }
    return false;
  }

  window.addEventListener("message", function (ev) {
    if (!ev.data || !ev.data.__epd_waf_solve) return;
    const angle = ev.data.angle;
    console.log("[EPD inject] WAF solve request, angle:", angle, "attempt:", ev.data.attempt);

    function trySolve() {
      // `let myCaptcha` is NOT on window — access via inline script in global scope
      let captcha = window.myCaptcha || window.captcha || window.Captcha?.instance;
      if (!captcha) {
        try {
          const s = document.createElement("script");
          s.textContent = "window.__epd_captcha_ref = typeof myCaptcha !== 'undefined' ? myCaptcha : null;";
          document.documentElement.appendChild(s);
          s.remove();
          captcha = window.__epd_captcha_ref;
          if (captcha) console.log("[EPD inject] Got myCaptcha via inline script bridge");
        } catch (e) {
          console.error("[EPD inject] Inline script bridge failed:", e.message);
        }
      }
      if (!captcha) {
        console.log("[EPD inject] myCaptcha not found, scanning window...");
        for (const key of Object.keys(window)) {
          if (/captcha/i.test(key) && typeof window[key] === "object" && window[key] !== null) {
            console.log("[EPD inject] Found window." + key + ":", typeof window[key], Object.keys(window[key]).slice(0, 20));
          }
        }
      }

      if (captcha) {
        console.log("[EPD inject] Captcha object found:", Object.keys(captcha).slice(0, 30));
        const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(captcha) || {});
        console.log("[EPD inject] Captcha methods:", methods);

        // Try known rotation methods
        const tryMethods = ["setAngle", "rotate", "setValue", "set", "setRotation", "setDegree", "update"];
        for (const m of tryMethods) {
          if (typeof captcha[m] === "function") {
            console.log("[EPD inject] Calling captcha." + m + "(" + angle + ")");
            try { captcha[m](angle); } catch (e) { console.error("[EPD inject]", m, "failed:", e.message); }
            window.postMessage({ __epd_waf_solve_result: true, method: m, success: true }, "*");
            return;
          }
        }

        // Try setting properties directly
        const tryProps = ["angle", "rotation", "value", "degree", "currentAngle", "rotateAngle"];
        for (const p of tryProps) {
          if (p in captcha) {
            console.log("[EPD inject] Setting captcha." + p + " =", angle);
            captcha[p] = angle;
          }
        }

        // Try to find a slider/control sub-object
        for (const key of Object.keys(captcha)) {
          const v = captcha[key];
          if (v && typeof v === "object" && !Array.isArray(v)) {
            const subKeys = Object.keys(v);
            if (subKeys.some(k => /angle|rotat|slider|value|degree/i.test(k))) {
              console.log("[EPD inject] Sub-object captcha." + key + ":", subKeys);
              for (const sk of subKeys) {
                if (/angle|rotat|value|degree/i.test(sk) && typeof v[sk] !== "function") {
                  console.log("[EPD inject] Setting captcha." + key + "." + sk + " =", angle);
                  v[sk] = angle;
                }
              }
            }
          }
        }

        // Try calling check/verify/submit after setting angle
        setTimeout(() => {
          const verifyMethods = ["check", "verify", "submit", "validate", "confirm", "send"];
          for (const m of verifyMethods) {
            if (typeof captcha[m] === "function") {
              console.log("[EPD inject] Calling captcha." + m + "()");
              try { captcha[m](); } catch (e) { console.error("[EPD inject]", m, "error:", e.message); }
              window.postMessage({ __epd_waf_solve_result: true, method: m, success: true }, "*");
              return;
            }
          }
          _wafFinishDomApply(angle);
        }, 500);
        return;
      }

      _wafFinishDomApply(angle);
    }

    function _wafFinishDomApply(deg) {
      const sliderOk = _wafSetRangeSlider(deg) || _wafDragSlider(deg);
      setTimeout(() => {
        const submitted = _wafClickSubmit();
        window.postMessage({
          __epd_waf_solve_result: true,
          method: sliderOk ? (submitted ? "slider+submit" : "slider") : (submitted ? "submit-only" : "dom-fail"),
          success: sliderOk || submitted,
        }, "*");
      }, 400);
    }

    // Captcha might not be initialized yet, retry
    if (window.myCaptcha) {
      trySolve();
    } else {
      console.log("[EPD inject] Waiting for myCaptcha to initialize...");
      setTimeout(trySolve, 1000);
    }
  });

  console.log("[EPD inject] fetch + XHR + SignalR + API bridge installed");
})();
