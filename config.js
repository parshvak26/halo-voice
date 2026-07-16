// ============================================================================
// CONFIG — the only file you normally edit on the frontend.
// ============================================================================

window.APP_CONFIG = {
  // 1) Paste your deployed Cloudflare Worker URL here (no trailing slash).
  //    Example: "https://support-voice-bot.yourname.workers.dev"
  WORKER_URL: "https://support-voice-bot.halo-voice-parshva.workers.dev",

  // 2) Display branding (cosmetic only — the bot's actual persona/knowledge
  //    lives server-side in the Worker so visitors can't tamper with it).
  BUSINESS_NAME: "Halo",
  ASSISTANT_NAME: "Ava",
  TAGLINE: "Your AI voice assistant — ask me anything",

  // 3) Optional: Cloudflare Turnstile site key to protect the handoff form
  //    from spam. Leave "" to disable. If set, also set TURNSTILE_SECRET
  //    on the Worker. See README section 7.
  TURNSTILE_SITE_KEY: "",

  // 4) Safety cap: max seconds of continuous listening per turn (protects
  //    your Deepgram credit if someone leaves the mic open).
  MAX_LISTEN_SECONDS: 30,
};
