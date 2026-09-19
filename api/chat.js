import {
  API_KEY,
  API_URL,
  MODEL,
  VISION_MODEL,
  VISION_FALLBACK_MODEL,
  VISION_FALLBACK2_MODEL,
  VISION_FALLBACK3_MODEL,
  MAX_MESSAGE_CHARS,
  MAX_IMAGE_CHARS,
  PROVIDER_TIMEOUT_MS,
  buildMessages,
  clientIp,
  rateLimited,
  providerPost,
  userKeyFromReq,
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
  // A personal key from the user's own device (X-Brain-Key header) takes
  // precedence over the server key for this request only.
  const activeKey = userKeyFromReq(req) || API_KEY;
  if (!activeKey) {
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
  // Vision requests get an automatic backup chain: free vision providers go
  // down or hang often, so the backend walks primary + three fallbacks from
  // different providers before the user ever sees an error.
  const models = hasImage
    ? [VISION_MODEL, VISION_FALLBACK_MODEL, VISION_FALLBACK2_MODEL, VISION_FALLBACK3_MODEL]
    : [MODEL];

  // Each model in the chain gets its own deadline (PER_MODEL_TIMEOUT_MS), so a
  // hung primary can never starve the fallbacks of their chance — previously a
  // single shared deadline let one slow model burn the whole budget and the
  // user got "took too long" without the fallback ever being tried. An overall
  // cap (PROVIDER_TIMEOUT_MS) still bounds the whole attempt.
  const PER_MODEL_TIMEOUT_MS = 18000;
  let upstream;
  try {
    const overall = new AbortController();
    const overallTimer = setTimeout(() => overall.abort(), PROVIDER_TIMEOUT_MS);
    let out;
    try {
      for (let i = 0; i < models.length; i++) {
        if (overall.signal.aborted) break; // overall deadline hit: stop
        const mc = new AbortController();
        const mt = setTimeout(() => mc.abort(), PER_MODEL_TIMEOUT_MS);
        const forwardAbort = () => mc.abort();
        overall.signal.addEventListener("abort", forwardAbort);
        try {
          // Speed: for plain text chat, ask the provider to skip its invisible
          // "thinking" (reasoning) phase so the first answer token arrives as
          // soon as possible. Vision requests keep the provider default.
          const plainBody = () => ({
            model: models[i],
            messages: buildMessages(body),
            stream: true,
          });
          const skipThinking = !hasImage;
          const reqBody = plainBody();
          if (skipThinking) reqBody.reasoning = { effort: "none" };
          out = await providerPost(
            `${API_URL}/chat/completions`,
            reqBody,
            mc.signal,
            models.length === 1 ? 3 : 2,
            activeKey
          );
          const rs = out.status || 0;
          if (!out.ok && skipThinking && rs >= 400 && rs < 500 && rs !== 429) {
            // This provider rejected the reasoning toggle: retry once with a
            // plain request instead of failing the chat.
            out = await providerPost(
              `${API_URL}/chat/completions`,
              plainBody(),
              mc.signal,
              1,
              activeKey
            );
          }
        } catch (e) {
          // Per-model deadline hit (AbortError) or a sync failure: record it
          // and move on to the next model in the chain.
          out = {
            ok: false,
            status: 0,
            detail: e && e.name === "AbortError" ? "model timed out" : String((e && e.message) || e),
          };
        } finally {
          clearTimeout(mt);
          overall.signal.removeEventListener("abort", forwardAbort);
        }
        if (out.ok) break;
        const s = out.status || 0;
        if (s !== 0 && s < 500 && s !== 429) break; // client error: final
      }
    } finally {
      clearTimeout(overallTimer);
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
