import { API_KEY, userKeyFromReq } from "./_lib.js";

// Public health check. Deliberately exposes NO internal details:
// no provider names, no model names, no key prefixes.
export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const personalKey = !!userKeyFromReq(req);
  res.status(200).json({
    ok: true,
    keyConfigured: !!API_KEY || personalKey,
    personalKey,
    capabilities: ["stream", "vision", "warmup", "voice-input", "tts", "history", "personal-key", "image-gen"],
    time: new Date().toISOString(),
  });
}
