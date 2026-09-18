import {
  API_KEY,
  API_URL,
  MODEL,
  VISION_MODEL,
  MAX_MESSAGE_CHARS,
  MAX_IMAGE_CHARS,
  PROVIDER_TIMEOUT_MS,
  buildMessages,
  clientIp,
  rateLimited,
  providerHeaders,
  fetchWithTimeout,
  noStore,
} from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    noStore(res);
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};

  // Silent warmup ping from the web app: keeps the function hot, no model call, no cost.
  if (body.warmup) {
    noStore(res);
    return res.status(200).json({ ok: true, warm: true });
  }

  const ip = clientIp(req);
  const rl = rateLimited(ip);
  if (rl.limited) {
    noStore(res);
    if (rl.retryAfter > 0) res.setHeader("Retry-After", String(Math.min(rl.retryAfter, 60)));
    return res
      .status(429)
      .json({ error: "RATE_LIMITED", detail: "Too many requests. Please wait a moment and try again." });
  }
  if (!API_KEY) {
    noStore(res);
    return res.status(500).json({ error: "AI_CONNECTION_NOT_CONFIGURED" });
  }

  const userText = String(body.message || "").slice(0, MAX_MESSAGE_CHARS);
  const hasImage =
    typeof body.image === "string" && body.image.startsWith("data:image");
  if (!userText && !hasImage) {
    noStore(res);
    return res.status(400).json({ error: "empty_message" });
  }
  if (hasImage && body.image.length > MAX_IMAGE_CHARS) {
    noStore(res);
    return res
      .status(413)
      .json({ error: "IMAGE_TOO_LARGE", detail: "That image is too large. Please use a smaller one." });
  }

  // The model is chosen server-side only. Clients can never override it,
  // so nobody can point your key at a different (expensive) model.
  const model = hasImage ? VISION_MODEL : MODEL;

  let upstream;
  try {
    upstream = await fetchWithTimeout(
      `${API_URL}/chat/completions`,
      {
        method: "POST",
        headers: providerHeaders(),
        body: JSON.stringify({ model, messages: buildMessages(body), stream: true }),
      },
      PROVIDER_TIMEOUT_MS
    );
  } catch (e) {
    noStore(res);
    const timedOut = e && e.name === "AbortError";
    return res.status(timedOut ? 504 : 502).json({
      error: timedOut ? "AI_TIMEOUT" : "AI_CONNECTION_ERROR",
      detail: timedOut
        ? "The AI provider took too long to respond. Please try again."
        : "Couldn't reach the AI provider. Please try again.",
    });
  }

  if (!upstream.ok || !upstream.body) {
    const data = await upstream.json().catch(() => ({}));
    const detail = String(
      (data && data.error && data.error.message) || `provider HTTP ${upstream.status}`
    );
    noStore(res);
    if (/image/i.test(detail) && /no endpoints|not support/i.test(detail)) {
      return res.status(502).json({
        error: "AI_CONNECTION_ERROR",
        detail: "This model can't read images right now. Please try again.",
      });
    }
    return res
      .status(502)
      .json({ error: "AI_CONNECTION_ERROR", detail: detail.slice(0, 200) });
  }

  // Stream the provider's SSE straight through so words appear instantly.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  let broken = false;
  try {
    for await (const chunk of upstream.body) {
      res.write(chunk);
      if (typeof res.flush === "function") res.flush();
    }
  } catch {
    broken = true; // client went away or the provider broke mid-stream
  }
  if (broken) {
    // Tell the app the stream was cut short instead of ending silently.
    try {
      res.write('data: {"error":"STREAM_INTERRUPTED"}\n\n');
    } catch {
      /* response already gone */
    }
  }
  res.end();
}
