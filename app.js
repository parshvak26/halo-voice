/* ===========================================================================
   Halo Voice Support — frontend application logic (v2)
   Flow per turn:  mic → Deepgram STT (stream) → Groq (Llama) → Deepgram TTS
   Handoff:        transcript → Worker → summary (Groq) → email (Brevo)
   All secrets live in the Cloudflare Worker; this file only talks to it,
   plus a short-lived token to stream audio straight to Deepgram.
   =========================================================================== */
(() => {
  "use strict";

  const CFG = window.APP_CONFIG || {};
  const WORKER = (CFG.WORKER_URL || "").replace(/\/+$/, "");
  const MAX_LISTEN_MS = (CFG.MAX_LISTEN_SECONDS || 30) * 1000;

  // ---- DOM ----------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const talkBtn = $("talkBtn"), talkLabel = $("talkLabel");
  const statusPill = $("statusPill"), statusText = $("statusText");
  const transcriptEl = $("transcript"), interimEl = $("interim");
  const overlay = $("overlay"), modalClose = $("modalClose");
  const handoffView = $("handoffView"), resultView = $("resultView");
  const nameInput = $("nameInput"), emailInput = $("emailInput"), phoneInput = $("phoneInput");
  const formError = $("formError"), sendHandoff = $("sendHandoff");
  const resultTitle = $("resultTitle"), resultBody = $("resultBody"), resultOk = $("resultOk");
  const orb = $("orb"), ttsAudio = $("ttsAudio");
  const chipsWrap = $("chips"), toastEl = $("toast");

  $("brandName").textContent = CFG.BUSINESS_NAME || "Support";
  $("assistantName").textContent = CFG.ASSISTANT_NAME || "the assistant";
  if (CFG.TAGLINE) $("tagline").textContent = CFG.TAGLINE;

  // ---- state --------------------------------------------------------------
  let state = "idle"; // idle | listening | thinking | speaking
  let audioCtx = null, micStream = null, workletNode = null, micSource = null;
  let ws = null, streaming = false, finalText = "", maxTimer = null, sawSpeech = false;
  let messages = [];           // [{role:'user'|'assistant', content}]
  let ttsAnalyser = null, ttsSource = null;
  let micLevel = 0;            // smoothed 0..1 from mic RMS
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Hands-free conversation control. After the first tap, Ava greets, then the
  // mic re-opens itself after every reply — the user never taps again mid-call.
  let sessionActive = false;   // true while the hands-free loop is running
  let hasGreeted = false;      // Ava has delivered the opening greeting
  let ttsStoppedManually = false; // guard: a manual stop also fires TTS "onended"
  const GREETING =
    "Hi, I'm " + (CFG.ASSISTANT_NAME || "Ava") + ", " + (CFG.BUSINESS_NAME || "Halo") +
    "'s voice support assistant. Tell me what's going on with your device and I'll help you sort it out.";

  // ---- status helpers -----------------------------------------------------
  function setState(next, label) {
    state = next;
    statusPill.className = "status-pill" + (next === "idle" ? "" : " " + next);
    const map = { idle: "Ready", listening: "Listening…", thinking: "Thinking…", speaking: "Speaking…", error: "Error" };
    statusText.textContent = label || map[next] || "Ready";
    talkBtn.setAttribute("aria-pressed", next === "listening" ? "true" : "false");
    talkLabel.textContent =
      next === "listening" ? "Tap to send" :
      next === "speaking" ? "Tap to stop" : "Tap to talk";
    // Disable example chips while a turn is in flight.
    const busy = next === "listening" || next === "thinking" || next === "speaking";
    if (chipsWrap) chipsWrap.querySelectorAll(".chip").forEach((c) => (c.disabled = busy));
  }

  function fail(msg) {
    setState("error", msg);
    showToast(msg, true);
    setTimeout(() => { if (state === "error") setState("idle"); }, 3500);
  }

  // ---- toast --------------------------------------------------------------
  let toastTimer = null;
  function showToast(msg, isError) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.className = "toast" + (isError ? " error" : "");
    toastEl.hidden = false;
    void toastEl.offsetWidth; // force reflow so the transition replays
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove("show");
      setTimeout(() => { toastEl.hidden = true; }, 300);
    }, 3200);
  }

  // ---- transcript UI ------------------------------------------------------
  function addMessage(role, text) {
    const es = $("emptyState");
    if (es) es.remove();
    const wrap = document.createElement("div");
    wrap.className = "msg " + (role === "user" ? "user" : "bot");
    const who = document.createElement("div");
    who.className = "who";
    who.textContent = role === "user" ? "You" : (CFG.ASSISTANT_NAME || "Assistant");
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text;
    wrap.append(who, bubble);
    transcriptEl.appendChild(wrap);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
    return wrap;
  }
  function showTyping() {
    const es = $("emptyState");
    if (es) es.remove();
    const wrap = document.createElement("div");
    wrap.className = "msg bot typing";
    wrap.id = "typingIndicator";
    const who = document.createElement("div");
    who.className = "who";
    who.textContent = CFG.ASSISTANT_NAME || "Assistant";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    wrap.append(who, bubble);
    transcriptEl.appendChild(wrap);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }
  function hideTyping() {
    const t = $("typingIndicator");
    if (t) t.remove();
  }
  function setInterim(text) {
    interimEl.textContent = text ? "“" + text + "”" : "";
  }

  // ---- audio init ---------------------------------------------------------
  // Playback-only context (works even if the mic was never used, e.g. chips).
  async function ensurePlaybackCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") await audioCtx.resume();
    return audioCtx;
  }

  async function initAudio() {
    await ensurePlaybackCtx();
    if (micStream && workletNode) return;
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    await audioCtx.audioWorklet.addModule("pcm-worklet.js");
    micSource = audioCtx.createMediaStreamSource(micStream);
    workletNode = new AudioWorkletNode(audioCtx, "pcm-worklet");
    workletNode.port.onmessage = (e) => {
      const pcm = new Int16Array(e.data);
      // level for the orb
      let sum = 0;
      for (let i = 0; i < pcm.length; i++) { const v = pcm[i] / 32768; sum += v * v; }
      const rms = Math.sqrt(sum / pcm.length);
      micLevel = Math.min(1, rms * 4);
      if (rms > 0.02) sawSpeech = true;
      if (streaming && ws && ws.readyState === WebSocket.OPEN) ws.send(e.data);
    };
    // The worklet writes NO output samples, so connecting it to the destination
    // keeps the audio graph "pulling" (so process() runs) while staying silent —
    // no microphone feedback.
    micSource.connect(workletNode);
    workletNode.connect(audioCtx.destination);
  }

  // ---- Deepgram streaming turn -------------------------------------------
  async function startTurn() {
    try {
      await initAudio();
    } catch (err) {
      return fail("Microphone blocked. Allow mic access and retry.");
    }
    let token;
    try {
      const r = await fetch(WORKER + "/token", { method: "POST" });
      if (!r.ok) throw new Error("token " + r.status);
      token = (await r.json()).access_token;
      if (!token) throw new Error("no token");
    } catch (err) {
      return fail("Couldn't reach the server. Check the Worker URL.");
    }

    finalText = ""; sawSpeech = false; setInterim("");
    const sr = audioCtx.sampleRate;
    const qs = new URLSearchParams({
      model: "nova-3", language: "en", smart_format: "true", punctuate: "true",
      interim_results: "true", endpointing: "400",
      encoding: "linear16", sample_rate: String(sr), channels: "1",
    });
    // Authenticate the browser WebSocket with the short-lived JWT via the
    // "bearer" Sec-WebSocket-Protocol scheme. Browsers can't set an
    // Authorization header on a WebSocket, and Deepgram requires JWTs to use
    // the Bearer scheme (the older ?access_token= query param no longer authenticates).
    ws = new WebSocket("wss://api.deepgram.com/v1/listen?" + qs.toString(), ["bearer", token]);

    ws.onopen = () => {
      streaming = true;
      setState("listening");
      clearTimeout(maxTimer);
      maxTimer = setTimeout(() => { if (state === "listening") endTurn(); }, MAX_LISTEN_MS);
    };
    ws.onmessage = (ev) => {
      let data; try { data = JSON.parse(ev.data); } catch { return; }
      if (data.type !== "Results") return;
      const alt = data.channel && data.channel.alternatives && data.channel.alternatives[0];
      const text = alt ? alt.transcript : "";
      if (!text) return;
      if (data.is_final) {
        finalText = (finalText + " " + text).trim();
        setInterim("");
        if (data.speech_final) endTurn(); // Deepgram detected end of speech
      } else {
        setInterim((finalText + " " + text).trim());
      }
    };
    ws.onerror = () => { if (state === "listening") endTurn(); };
    ws.onclose = () => { streaming = false; };
  }

  function endTurn() {
    clearTimeout(maxTimer);
    streaming = false;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: "CloseStream" })); } catch {}
      setTimeout(() => { try { ws.close(); } catch {} }, 150);
    }
    setInterim("");
    const text = finalText.trim();
    if (!text) {
      // Nothing said. In a hands-free call, pause the loop cleanly instead of
      // re-opening the mic forever (protects credits and mirrors "I'll pause here").
      if (sessionActive) {
        sessionActive = false;
        setState("idle", "Paused — tap to continue");
      } else if (!sawSpeech) {
        fail("I didn't catch that — try again.");
      } else {
        setState("idle");
      }
      return;
    }
    handleUserUtterance(text);
  }

  // ---- brain + voice ------------------------------------------------------
  async function handleUserUtterance(text) {
    addMessage("user", text);
    messages.push({ role: "user", content: text });
    setState("thinking");
    showTyping();
    let reply;
    try {
      const r = await fetch(WORKER + "/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages }),
      });
      if (!r.ok) throw new Error("chat " + r.status);
      reply = (await r.json()).reply;
    } catch (err) {
      reply = "Sorry — I'm having trouble right now. You can tap “Talk to a human” and we'll follow up by email.";
    }
    if (!reply) reply = "Could you say that another way?";
    hideTyping();
    addMessage("bot", reply);
    messages.push({ role: "assistant", content: reply });
    await speak(reply);
  }

  async function speak(text) {
    setState("speaking");
    try {
      await ensurePlaybackCtx();
      const r = await fetch(WORKER + "/tts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) throw new Error("tts " + r.status);
      const buf = await r.arrayBuffer();
      const audioBuf = await audioCtx.decodeAudioData(buf);
      ttsSource = audioCtx.createBufferSource();
      ttsSource.buffer = audioBuf;
      ttsAnalyser = audioCtx.createAnalyser();
      ttsAnalyser.fftSize = 256;
      ttsSource.connect(ttsAnalyser);
      ttsAnalyser.connect(audioCtx.destination);
      ttsSource.onended = () => { ttsSource = null; ttsAnalyser = null; onBotDoneSpeaking(); };
      ttsSource.start();
    } catch (err) {
      // Fallback: browser speech synthesis so the demo never goes mute.
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.onend = () => onBotDoneSpeaking();
        speechSynthesis.speak(u);
      } catch { onBotDoneSpeaking(); }
    }
  }

  // Called when a spoken reply finishes. In a hands-free call this re-opens the
  // mic for the next turn automatically; otherwise it just returns to idle.
  function onBotDoneSpeaking() {
    if (ttsStoppedManually) { ttsStoppedManually = false; return; } // manual stop already handled
    if (state !== "speaking") return;
    if (sessionActive && overlay.hidden) {
      startTurn();               // hands-free: listen again, no tap needed
    } else {
      setState("idle");
    }
  }

  function stopSpeaking() {
    ttsStoppedManually = true;   // suppress the auto-relisten from onended
    sessionActive = false;       // tapping to stop ends the hands-free loop
    if (ttsSource) { try { ttsSource.stop(); } catch {} ttsSource = null; }
    try { speechSynthesis.cancel(); } catch {}
    ttsAnalyser = null;
    setState("idle");
  }

  // Start (or resume) a hands-free conversation. On the very first tap Ava
  // greets first, then the mic opens on its own; on resume it just listens.
  async function beginSession() {
    sessionActive = true;
    // Request mic permission up front so the turn right after the greeting is seamless.
    try { await initAudio(); } catch (err) { /* mic denied — greeting still plays */ }
    if (!hasGreeted) {
      hasGreeted = true;
      addMessage("bot", GREETING);
      messages.push({ role: "assistant", content: GREETING });
      await speak(GREETING);     // onBotDoneSpeaking() then opens the mic
    } else {
      startTurn();
    }
  }

  // ---- primary button + keyboard ------------------------------------------
  function primaryAction() {
    if (state === "idle" || state === "error") beginSession(); // greet on first tap, else resume listening
    else if (state === "listening") endTurn();
    else if (state === "speaking") stopSpeaking();
    // ignore taps while "thinking"
  }
  talkBtn.addEventListener("click", primaryAction);

  // Space toggles talk (unless typing in a field / modal open).
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space") return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (t && t.classList && t.classList.contains("chip")) return; // let Space click a focused chip
    if (!overlay.hidden) return;
    e.preventDefault();
    primaryAction();
  });

  // Example prompt chips → send as if spoken (handy without a mic).
  if (chipsWrap) {
    chipsWrap.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip || chip.disabled) return;
      if (state !== "idle" && state !== "error") return;
      handleUserUtterance(chip.textContent.trim());
    });
  }

  $("clearBtn").addEventListener("click", () => {
    messages = [];
    sessionActive = false; hasGreeted = false; // next tap starts a fresh, greeted call
    transcriptEl.innerHTML = "";
    const e = document.createElement("div");
    e.className = "empty";
    e.id = "emptyState";
    e.innerHTML = '<div class="empty-orb" aria-hidden="true"></div>' +
      '<p>Your conversation will appear here.</p>' +
      '<p class="hint">Try: “My thermostat won’t connect to Wi-Fi.”</p>';
    transcriptEl.appendChild(e);
    setInterim("");
  });

  // ---- orb animation ------------------------------------------------------
  const octx = orb.getContext("2d");
  const DPR = Math.min(2, window.devicePixelRatio || 1);
  function sizeOrb() {
    const cssSize = orb.clientWidth || 360;
    orb.width = cssSize * DPR; orb.height = cssSize * DPR;
  }
  sizeOrb();
  window.addEventListener("resize", sizeOrb);

  let smooth = 0, phase = 0;
  const freqBins = new Uint8Array(128);

  function targetLevel() {
    if (state === "listening") return micLevel;
    if (state === "speaking" && ttsAnalyser) {
      const arr = new Uint8Array(ttsAnalyser.frequencyBinCount);
      ttsAnalyser.getByteFrequencyData(arr);
      let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i];
      return Math.min(1, (s / arr.length) / 90);
    }
    if (state === "thinking") return 0.35 + Math.sin(phase * 3) * 0.12;
    return 0.12; // idle breathing
  }

  // Read a smoothed frequency spectrum for the reactive ring of bars.
  function readSpectrum() {
    if (state === "speaking" && ttsAnalyser) {
      const arr = new Uint8Array(ttsAnalyser.frequencyBinCount);
      ttsAnalyser.getByteFrequencyData(arr);
      for (let i = 0; i < freqBins.length; i++) {
        const v = arr[Math.min(arr.length - 1, i)] || 0;
        freqBins[i] += (v - freqBins[i]) * 0.4;
      }
      return true;
    }
    if (state === "listening") {
      // Synthesize a lively spectrum from the mic level so the ring dances too.
      for (let i = 0; i < freqBins.length; i++) {
        const target = micLevel * 255 * (0.5 + 0.5 * Math.abs(Math.sin(i * 0.6 + phase * 4)));
        freqBins[i] += (target - freqBins[i]) * 0.35;
      }
      return true;
    }
    // decay to rest
    for (let i = 0; i < freqBins.length; i++) freqBins[i] *= 0.9;
    return false;
  }

  function drawOrb() {
    const w = orb.width, h = orb.height, cx = w / 2, cy = h / 2;
    phase += reduceMotion ? 0.004 : 0.012;
    const tgt = targetLevel();
    smooth += (tgt - smooth) * 0.12;
    const active = readSpectrum();
    const base = Math.min(w, h) * 0.24;
    const r = base * (1 + smooth * 0.5) * (1 + (reduceMotion ? 0 : Math.sin(phase) * 0.03));

    octx.clearRect(0, 0, w, h);

    // reactive ring of bars around the orb (listening / speaking)
    if (active && !reduceMotion) {
      const bars = 72;
      const ringBase = r * 1.28;
      octx.save();
      octx.translate(cx, cy);
      for (let i = 0; i < bars; i++) {
        const idx = Math.floor((i / bars) * freqBins.length);
        const mag = (freqBins[idx] || 0) / 255;
        const len = r * (0.06 + mag * 0.55);
        const ang = (i / bars) * Math.PI * 2 + phase * 0.2;
        const x1 = Math.cos(ang) * ringBase;
        const y1 = Math.sin(ang) * ringBase;
        const x2 = Math.cos(ang) * (ringBase + len);
        const y2 = Math.sin(ang) * (ringBase + len);
        const mix = i / bars;
        octx.strokeStyle = `rgba(${Math.round(52 + mix * 72)}, ${Math.round(180 + mix * 20)}, ${Math.round(208 + mix * 40)}, ${0.35 + mag * 0.5})`;
        octx.lineWidth = Math.max(1.5, r * 0.02);
        octx.lineCap = "round";
        octx.beginPath();
        octx.moveTo(x1, y1);
        octx.lineTo(x2, y2);
        octx.stroke();
      }
      octx.restore();
    }

    // outer glow
    const glow = octx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 2.2);
    glow.addColorStop(0, "rgba(124,107,245,0.30)");
    glow.addColorStop(1, "rgba(124,107,245,0)");
    octx.fillStyle = glow;
    octx.beginPath(); octx.arc(cx, cy, r * 2.2, 0, Math.PI * 2); octx.fill();

    // core blob with shifting aurora gradient
    const ang = phase * 0.6;
    const gx = cx + Math.cos(ang) * r * 0.4, gy = cy + Math.sin(ang) * r * 0.4;
    const g = octx.createRadialGradient(gx, gy, r * 0.1, cx, cy, r);
    g.addColorStop(0, "#34e0d0");
    g.addColorStop(0.5, "#5aa9ec");
    g.addColorStop(1, "#7c6bf5");
    octx.fillStyle = g;
    octx.beginPath(); octx.arc(cx, cy, r, 0, Math.PI * 2); octx.fill();

    // thin bright rim
    octx.strokeStyle = "rgba(255,255,255,0.22)";
    octx.lineWidth = Math.max(1, r * 0.012);
    octx.beginPath(); octx.arc(cx, cy, r, 0, Math.PI * 2); octx.stroke();

    // inner highlight
    const hl = octx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, 0, cx - r * 0.3, cy - r * 0.35, r);
    hl.addColorStop(0, "rgba(255,255,255,0.38)");
    hl.addColorStop(0.4, "rgba(255,255,255,0)");
    octx.fillStyle = hl;
    octx.beginPath(); octx.arc(cx, cy, r, 0, Math.PI * 2); octx.fill();

    requestAnimationFrame(drawOrb);
  }
  requestAnimationFrame(drawOrb);

  // ---- handoff modal ------------------------------------------------------
  let turnstileToken = "", turnstileRendered = false;

  function openModal() {
    overlay.hidden = false;
    handoffView.hidden = false;
    resultView.hidden = true;
    formError.hidden = true;
    if (CFG.TURNSTILE_SITE_KEY) loadTurnstile();
    setTimeout(() => nameInput && nameInput.focus(), 60);
  }
  function closeModal() { overlay.hidden = true; }

  $("humanBtn").addEventListener("click", openModal);
  modalClose.addEventListener("click", closeModal);
  resultOk.addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) closeModal(); });

  function loadTurnstile() {
    if (turnstileRendered) return;
    const render = () => {
      if (!window.turnstile) return;
      window.turnstile.render("#turnstileSlot", {
        sitekey: CFG.TURNSTILE_SITE_KEY,
        callback: (t) => { turnstileToken = t; },
      });
      turnstileRendered = true;
    };
    if (window.turnstile) return render();
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    s.async = true; s.defer = true; s.onload = render;
    document.head.appendChild(s);
  }

  function validEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

  sendHandoff.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    const email = emailInput.value.trim();
    const phone = phoneInput.value.trim();
    formError.hidden = true;
    if (!name) return showFormError("Please enter your name.");
    if (!validEmail(email)) return showFormError("Please enter a valid email.");
    if (CFG.TURNSTILE_SITE_KEY && !turnstileToken) return showFormError("Please complete the verification.");

    sendHandoff.disabled = true; sendHandoff.textContent = "Sending…";
    try {
      const r = await fetch(WORKER + "/handoff", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, phone, messages, turnstileToken }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || ("handoff " + r.status));
      showResult("Sent to support",
        `<p>Thanks, ${escapeHtml(name)}. Your question is on its way to our team, and a copy is in your inbox.</p>` +
        (out.summary ? `<h4>What we captured</h4><p>${escapeHtml(out.summary)}</p>` : ""), true);
    } catch (err) {
      showFormError("Couldn't send just now. Please try again.");
    } finally {
      sendHandoff.disabled = false; sendHandoff.textContent = "Send to support";
    }
  });

  function showFormError(msg) { formError.textContent = msg; formError.hidden = false; }
  function showResult(title, html, showCheck) {
    handoffView.hidden = true; resultView.hidden = false;
    const check = resultView.querySelector(".result-check");
    if (check) check.style.display = showCheck ? "" : "none";
    resultTitle.textContent = title; resultBody.innerHTML = html;
  }

  // ---- end & summarize ----------------------------------------------------
  $("summaryBtn").addEventListener("click", async () => {
    if (!messages.length) { openModalResult("Nothing to summarize yet", "<p>Have a quick chat first, then tap “End &amp; summarize”.</p>"); return; }
    openModalResult("Summarizing…", "<p>One moment…</p>");
    try {
      const r = await fetch(WORKER + "/summary", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages }),
      });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || "summary");
      let html = `<p>${escapeHtml(out.summary || "")}</p>`;
      if (Array.isArray(out.actionItems) && out.actionItems.length) {
        html += "<h4>Suggested next steps</h4><ul>" +
          out.actionItems.map((a) => `<li>${escapeHtml(a)}</li>`).join("") + "</ul>";
      }
      resultBody.innerHTML = html;
      resultTitle.textContent = "Conversation summary";
    } catch {
      resultBody.innerHTML = "<p>Couldn't build a summary just now.</p>";
      resultTitle.textContent = "Summary";
    }
  });

  // Neutral/info dialog — no success checkmark.
  function openModalResult(title, html) {
    overlay.hidden = false; handoffView.hidden = true; resultView.hidden = false;
    const check = resultView.querySelector(".result-check");
    if (check) check.style.display = "none";
    resultTitle.textContent = title; resultBody.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---- config sanity note (visible in console for the developer) ----------
  if (!WORKER || WORKER.includes("REPLACE-WITH-YOUR-WORKER-URL")) {
    console.warn("[config] Set APP_CONFIG.WORKER_URL in config.js to your deployed Worker URL.");
    setState("error", "Set Worker URL in config.js");
  }
})();
