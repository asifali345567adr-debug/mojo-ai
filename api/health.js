import { API_KEY, MODEL, VISION_MODEL } from "./_lib.js";

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: true,
    model: MODEL,
    visionModel: VISION_MODEL,
    keyConfigured: !!API_KEY,
    capabilities: ["stream", "vision", "warmup", "voice-input", "tts", "history"],
    time: new Date().toISOString(),
  });
}
