import { API_KEY, VISION_MODEL, buildMessages, callProvider, clientIp, rateLimited } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const ip = clientIp(req);
  if (rateLimited(ip)) {
    return res.status(429).json({ error: "RATE_LIMITED", detail: "Too many requests. Please wait a moment." });
  }
  if (!API_KEY) {
    return res.status(500).json({ error: "AI_CONNECTION_NOT_CONFIGURED" });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const userText = String(body.message || "").slice(0, 4000);
  if (!userText && !body.image) {
    return res.status(400).json({ error: "empty_message" });
  }

  try {
    // Image messages need a vision-capable model; route them automatically.
    const hasImage = !!(body.image && typeof body.image === "string" && body.image.startsWith("data:image"));
    const reply = await callProvider(buildMessages(body), hasImage ? VISION_MODEL : body.model);
    return res.status(200).json({ reply });
  } catch (e) {
    const detail = String(e.message || e);
    if (/image/i.test(detail) && /no endpoints|not support/i.test(detail)) {
      return res.status(502).json({
        error: "AI_CONNECTION_ERROR",
        detail: "This model can't read images right now. Please try again — the request was already routed to the vision model.",
      });
    }
    return res.status(e.status || 502).json({ error: "AI_CONNECTION_ERROR", detail: detail.slice(0, 200) });
  }
}
