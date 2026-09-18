import { API_KEY, API_URL, MODEL, VISION_MODEL, buildMessages, clientIp, rateLimited } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};

  // Silent warmup ping from the web app: keeps the function hot, no model call.
  if (body.warmup) return res.status(200).json({ ok: true, warm: true });

  const ip = clientIp(req);
  if (rateLimited(ip)) {
    return res.status(429).json({ error: "RATE_LIMITED", detail: "Too many requests. Please wait a moment." });
  }
  if (!API_KEY) {
    return res.status(500).json({ error: "AI_CONNECTION_NOT_CONFIGURED" });
  }

  const userText = String(body.message || "").slice(0, 4000);
  if (!userText && !body.image) {
    return res.status(400).json({ error: "empty_message" });
  }

  // Image messages need a vision-capable model; route them automatically.
  const hasImage = !!(body.image && typeof body.image === "string" && body.image.startsWith("data:image"));
  const model = hasImage ? VISION_MODEL : body.model || MODEL;

  try {
    const r = await fetch(`${API_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
        "HTTP-Referer": "https://muse.ai",
        "X-Title": "Mojo AI",
      },
      body: JSON.stringify({ model, messages: buildMessages(body), stream: true }),
    });

    if (!r.ok || !r.body) {
      const data = await r.json().catch(() => ({}));
      const detail = String((data && data.error && data.error.message) || `provider HTTP ${r.status}`);
      if (/image/i.test(detail) && /no endpoints|not support/i.test(detail)) {
        return res.status(502).json({
          error: "AI_CONNECTION_ERROR",
          detail: "This model can't read images right now. Please try again.",
        });
      }
      return res.status(502).json({ error: "AI_CONNECTION_ERROR", detail: detail.slice(0, 200) });
    }

    // Stream the provider's SSE straight through so words appear instantly.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    try {
      for await (const chunk of r.body) {
        res.write(chunk);
        if (typeof res.flush === "function") res.flush();
      }
    } catch {
      // client went away; stop forwarding
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) {
      return res.status(502).json({ error: "AI_CONNECTION_ERROR", detail: String(e.message || e).slice(0, 200) });
    }
    try { res.end(); } catch { /* already streaming; just close */ }
  }
}
