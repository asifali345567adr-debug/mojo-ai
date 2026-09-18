import {
  API_KEY,
  API_URL,
  MODEL,
  VISION_MODEL,
  VISION_FALLBACK_MODEL,
  MAX_MESSAGE_CHARS,
  MAX_IMAGE_CHARS,
  PROVIDER_TIMEOUT_MS,
  buildMessages,
  clientIp,
  rateLimited,
  providerPost,
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
  // Vision requests get an automatic backup model: free vision providers go
  // down often, so if the primary vision model errors we retry the same
  // request on the fallback before the user ever sees an error.
  const models = hasImage ? [VISION_MODEL, VISION_FALLBACK_MODEL] : [MODEL];

  // The provider call gets one overall deadline (PROVIDER_TIMEOUT_MS) that
  // covers the request plus any automatic retries of transient failures.
  // Once the stream's headers arrive, the timer is cleared and the stream
  // phase runs untimed, exactly as before.
  let upstream;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    let out;
    try {
      for (let i = 0; i < models.length; i++) {
        out = await providerPost(
          `${API_URL}/chat/completions`,
          { model: models[i], messages: buildMessages(body), stream: true },
          controller.signal,
          i === 0 ? 3 : 2
        );
        if (out.ok) break;
        if (controller.signal.aborted) break; // overall deadline hit: stop
        const s = out.status || 0;
        if (s !== 0 && s < 500 && s !== 429) break; // client error: final
      }
    } finally {
      clearTimeout(timer);
    }
    if (!out.ok) {
      noStore(res);
      if (hasImage) {
        return res.status(502).json({
          error: "AI_CONNECTION_ERROR",
          detail:
            "The image reader is temporarily down on the provider's side. Please try again in a little while.",
        });
      }
      const detail = out.detail || "The AI provider returned an error.";
      return res
        .status(502)
        .json({ error: "AI_CONNECTION_ERROR", detail });
    }
    upstream = out.resp;
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
