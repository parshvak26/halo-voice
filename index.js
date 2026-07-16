/* ===========================================================================
   Halo Voice Support — Cloudflare Worker (backend)
   Routes:
     POST /token    -> mint a 60s Deepgram token for the browser (STT stream)
     POST /chat     -> proxy to Groq (Llama) with a locked-down system persona
     POST /tts      -> proxy to Deepgram Aura (text -> speech audio)
     POST /handoff  -> summarize the chat (Groq) + email it via Brevo (you + CC visitor)
     POST /summary  -> summarize the chat (Groq) for the on-screen recap
   Secrets (wrangler secret put ...):
     DEEPGRAM_API_KEY, GROQ_API_KEY, BREVO_API_KEY, [TURNSTILE_SECRET]
   Vars (wrangler.toml [vars]):
     ALLOWED_ORIGIN, OWNER_EMAIL, SENDER_EMAIL, [GROQ_MODEL], [TTS_MODEL], [BUSINESS_NAME]
   =========================================================================== */

// -------- Persona + knowledge (edit this to rebrand the demo) --------------
const DEFAULT_PERSONA = `You are Ava, a warm, capable AI voice assistant. You can help with anything the person brings you — questions, explanations, ideas, advice, how-to steps, writing, math, tech problems, everyday tasks, or just conversation. You are a general assistant, not tied to any single company or product; never refuse a request just because it isn't about a specific brand or device.

You speak out loud, so every reply must sound natural spoken: keep it short and conversational, usually 1–3 sentences, no lists, no markdown, no emoji, no headings. Get to the point, sound relaxed and friendly, and end most replies with a light question or a clear next step so the person knows it's their turn. If something genuinely needs several steps, give the first step, then offer to walk through the rest one at a time.

Your name: You are Ava. People may say or spell your name in different ways — Ava, Eva, Avah, and so on — and speech-to-text may mishear it. Always assume they mean you, just respond naturally, and never correct them about your name or make it a topic. Only mention that you're an AI assistant if they ask.

Talking to a human: If the person asks to speak with a human, wants a callback, or asks you to pass something to a real person, warmly agree right away — never refuse or downplay it. Briefly tell them a short form is on screen where they can leave their email, and let them know their request and a summary of the conversation will be sent to the team, with a copy emailed to them for reference. Don't quiz them about why; just help them hand off. Never promise a specific callback time.

Corrections and confirmations: if the person corrects you, accept it gracefully and move on — don't over-apologize or re-confirm. Only confirm things that are genuinely costly to get wrong, and keep the conversation flowing otherwise.

Be honest: if you don't know something or can't be sure, say so plainly rather than making things up.`;

// -------- small helpers ----------------------------------------------------
function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
function json(env, obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

// best-effort per-IP limiter (defense-in-depth; not perfectly consistent across
// Worker isolates — for hard guarantees add Cloudflare KV or Turnstile).
const HITS = new Map();
function rateLimited(ip, limit, windowMs) {
  const now = Date.now();
  const rec = HITS.get(ip) || [];
  const recent = rec.filter((t) => now - t < windowMs);
  recent.push(now);
  HITS.set(ip, recent);
  if (HITS.size > 5000) HITS.clear(); // keep memory bounded
  return recent.length > limit;
}

function sanitizeMessages(raw, maxTurns = 20, maxLen = 2000) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-maxTurns)
    .map((m) => ({ role: m.role, content: m.content.slice(0, maxLen) }));
}

async function callGroq(env, messages, { temperature = 0.4, maxTokens = 320, json: wantJson = false } = {}) {
  const body = {
    model: env.GROQ_MODEL || "llama-3.3-70b-versatile",
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (wantJson) body.response_format = { type: "json_object" };
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.GROQ_API_KEY },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("groq " + r.status + " " + (await r.text()).slice(0, 200));
  const data = await r.json();
  return data.choices?.[0]?.message?.content || "";
}

function transcriptToText(messages, persona) {
  const nameFor = (m) => (m.role === "user" ? "Customer" : "Assistant");
  return messages.map((m) => nameFor(m) + ": " + m.content).join("\n");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// -------- route handlers ----------------------------------------------------
async function handleToken(env) {
  const r = await fetch("https://api.deepgram.com/v1/auth/grant", {
    method: "POST",
    headers: { Authorization: "Token " + env.DEEPGRAM_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl_seconds: 60 }),
  });
  if (!r.ok) {
    // Surface Deepgram's real reason so setup issues are diagnosable.
    // A 401/403 here almost always means the API key lacks "Member" permission.
    const detail = (await r.text()).slice(0, 300);
    return json(env, { error: "token_failed", deepgram_status: r.status, detail }, 502);
  }
  const data = await r.json();
  return json(env, { access_token: data.access_token, expires_in: data.expires_in });
}

async function handleChat(env, req, ip) {
  if (rateLimited(ip, 40, 60_000)) return json(env, { error: "rate_limited" }, 429);
  const { messages } = await req.json().catch(() => ({}));
  const clean = sanitizeMessages(messages);
  if (!clean.length) return json(env, { error: "no_messages" }, 400);
  const persona = env.PERSONA || DEFAULT_PERSONA;
  const reply = await callGroq(env, [{ role: "system", content: persona }, ...clean], { maxTokens: 220 });
  return json(env, { reply: reply.trim() });
}

async function speakOnce(env, model, text) {
  return fetch("https://api.deepgram.com/v1/speak?model=" + encodeURIComponent(model), {
    method: "POST",
    headers: { Authorization: "Token " + env.DEEPGRAM_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

async function handleTts(env, req, ip) {
  if (rateLimited(ip, 60, 60_000)) return json(env, { error: "rate_limited" }, 429);
  const { text } = await req.json().catch(() => ({}));
  if (!text || typeof text !== "string") return json(env, { error: "no_text" }, 400);
  const clipped = text.slice(0, 800);

  // Try the configured voice first, then transparently fall back to a known-good
  // voice if the primary model errors (e.g. deprecated model or a transient 5xx).
  // Only if BOTH fail do we return an error — the browser then uses speechSynthesis.
  const primary = env.TTS_MODEL || "aura-2-thalia-en";
  const fallback = "aura-asteria-en";
  const models = primary === fallback ? [primary] : [primary, fallback];

  let lastDetail = "";
  for (const model of models) {
    let r;
    try {
      r = await speakOnce(env, model, clipped);
    } catch (err) {
      lastDetail = String(err).slice(0, 200);
      continue;
    }
    if (r.ok) {
      return new Response(r.body, {
        status: 200,
        headers: {
          "Content-Type": r.headers.get("Content-Type") || "audio/mpeg",
          "Cache-Control": "no-store",
          ...corsHeaders(env),
        },
      });
    }
    lastDetail = (await r.text()).slice(0, 200);
  }
  return json(env, { error: "tts_failed", detail: lastDetail }, 502);
}

async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true; // disabled
  if (!token) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const out = await r.json().catch(() => ({}));
  return !!out.success;
}

async function summarizeChat(env, messages) {
  const persona = env.PERSONA || DEFAULT_PERSONA;
  const convo = transcriptToText(messages, persona);
  const prompt = `A customer used our voice support assistant. Summarize the conversation for the human support team.
Return ONLY valid JSON with these keys:
  "subject": a short email subject line (max 8 words),
  "summary": 2-3 sentence plain summary of the customer's issue and what was tried,
  "category": one of "billing","technical","returns","account","other",
  "urgency": one of "low","medium","high",
  "actionItems": array of up to 3 short next steps for the human agent.

Conversation:
${convo}`;
  const raw = await callGroq(env, [{ role: "user", content: prompt }], { temperature: 0.2, maxTokens: 400, json: true });
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    return { subject: "Support request", summary: raw.slice(0, 400), category: "other", urgency: "medium", actionItems: [] };
  }
}

async function handleSummary(env, req, ip) {
  if (rateLimited(ip, 20, 60_000)) return json(env, { error: "rate_limited" }, 429);
  const { messages } = await req.json().catch(() => ({}));
  const clean = sanitizeMessages(messages);
  if (!clean.length) return json(env, { error: "no_messages" }, 400);
  const s = await summarizeChat(env, clean);
  return json(env, { summary: s.summary || "", actionItems: s.actionItems || [] });
}

async function handleHandoff(env, req, ip) {
  if (rateLimited(ip, 6, 60_000)) return json(env, { error: "rate_limited" }, 429);
  const { name, email, phone, messages, turnstileToken } = await req.json().catch(() => ({}));

  if (!name || typeof name !== "string") return json(env, { error: "missing_name" }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || "")) return json(env, { error: "invalid_email" }, 400);
  if (!(await verifyTurnstile(env, turnstileToken, ip))) return json(env, { error: "verification_failed" }, 403);

  const clean = sanitizeMessages(messages);
  const s = await summarizeChat(env, clean.length ? clean : [{ role: "user", content: "(no conversation captured)" }]);

  const convoHtml = clean
    .map((m) => `<p style="margin:4px 0"><strong>${m.role === "user" ? "Customer" : "Assistant"}:</strong> ${escapeHtml(m.content)}</p>`)
    .join("");

  const business = env.BUSINESS_NAME || "Support";
  const subject = `[${business}] ${s.subject || "New support request"} — ${name}`;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;line-height:1.5">
      <h2 style="margin:0 0 4px">New voice-support request</h2>
      <p style="color:#666;margin:0 0 16px">Captured by the ${business} voice assistant.</p>
      <table style="border-collapse:collapse;margin-bottom:16px">
        <tr><td style="padding:2px 12px 2px 0;color:#666">Name</td><td>${escapeHtml(name)}</td></tr>
        <tr><td style="padding:2px 12px 2px 0;color:#666">Email</td><td>${escapeHtml(email)}</td></tr>
        ${phone ? `<tr><td style="padding:2px 12px 2px 0;color:#666">Phone</td><td>${escapeHtml(phone)}</td></tr>` : ""}
        <tr><td style="padding:2px 12px 2px 0;color:#666">Category</td><td>${escapeHtml(s.category || "other")}</td></tr>
        <tr><td style="padding:2px 12px 2px 0;color:#666">Urgency</td><td>${escapeHtml(s.urgency || "medium")}</td></tr>
      </table>
      <h3 style="margin:0 0 6px">Summary</h3>
      <p style="margin:0 0 16px">${escapeHtml(s.summary || "")}</p>
      ${Array.isArray(s.actionItems) && s.actionItems.length ? `<h3 style="margin:0 0 6px">Suggested next steps</h3><ul>${s.actionItems.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>` : ""}
      <h3 style="margin:16px 0 6px">Full transcript</h3>
      <div style="background:#f5f6f8;border-radius:8px;padding:12px">${convoHtml || "<p>(none)</p>"}</div>
    </div>`;

  const brevoBody = {
    sender: { email: env.SENDER_EMAIL, name: business + " Voice Assistant" },
    to: [{ email: env.OWNER_EMAIL, name: business + " Support" }],
    cc: [{ email, name }],
    replyTo: { email, name },
    subject,
    htmlContent: html,
  };
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify(brevoBody),
  });
  if (!r.ok) return json(env, { error: "email_failed", detail: (await r.text()).slice(0, 200) }, 502);

  return json(env, { ok: true, summary: s.summary || "" });
}

// -------- entry -------------------------------------------------------------
export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(env) });
    const url = new URL(req.url);
    const ip = req.headers.get("CF-Connecting-IP") || "anon";

    if (req.method !== "POST") return json(env, { error: "method_not_allowed" }, 405);

    try {
      switch (url.pathname) {
        case "/token":   return await handleToken(env);
        case "/chat":    return await handleChat(env, req, ip);
        case "/tts":     return await handleTts(env, req, ip);
        case "/summary": return await handleSummary(env, req, ip);
        case "/handoff": return await handleHandoff(env, req, ip);
        default:         return json(env, { error: "not_found" }, 404);
      }
    } catch (err) {
      return json(env, { error: "server_error", detail: String(err).slice(0, 200) }, 500);
    }
  },
};
