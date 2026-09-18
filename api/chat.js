import { API_KEY, buildMessages, callProvider, clientIp, rateLimited } from "./_lib.js";

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
    const reply = await callProvider(buildMessages(body), body.model);
    return res.status(200).json({ reply });
  } catch (e) {
    return res.status(e.status || 502).json({ error: "AI_CONNECTION_ERROR", detail: String(e.message || e).slice(0, 200) });
  }
}
