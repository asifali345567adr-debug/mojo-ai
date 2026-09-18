import { API_KEY, MODEL, VISION_MODEL, VISION_FALLBACK_MODEL, userKeyFromReq } from "./_lib.js";

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const personalKey = !!userKeyFromReq(req);
  res.status(200).json({
    ok: true,
    model: MODEL,
    visionModel: VISION_MODEL,
    visionFallbackModel: VISION_FALLBACK_MODEL,
    keyConfigured: !!API_KEY || personalKey,
    personalKey,
    capabilities: ["stream", "vision", "warmup", "voice-input", "tts", "history", "personal-key"],
    time: new Date().toISOString(),
  });
}
