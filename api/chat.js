import {
  API_KEY,
  API_URL,
  MODEL,
  CHAT_MODEL,
  CHAT_FALLBACK_API_URL,
  CHAT_FALLBACK_MODEL,
  chatBrainPost,
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
  friendlyDetail,
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
  const userText = String(body.message || "").slice(0, MAX_MESSAGE_CHARS);
  const hasImage =
    typeof body.image === "string" && body.image.startsWith("data:image");

  // Brain routing: vision always rides OpenRouter (its free vision models read
  // photos best), so the 50/day free quota is spent only on photo analysis.
  // Plain text chat uses the user's personal OpenRouter key when attached,
  // otherwise the shared chat brain on the owner's OpenRouter credit (same
  // model family as before, so answers feel identical). A personal key from
  // the user's own device (X-Brain-Key header) takes precedence over the
  // server key for that request only.
  const personalKey = userKeyFromReq(req);
  const useFreeBrain = !hasImage && !personalKey;
  const activeKey = personalKey || API_KEY;
  if (!useFreeBrain && !activeKey) {
    noStore(res);
    return res.status(500).json({ error: "AI_CONNECTION_NOT_CONFIGURED" });
  }
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
    : [useFreeBrain ? CHAT_MODEL : MODEL];

  // Each model in the chain gets its own deadline (PER_MODEL_TIMEOUT_MS), so a
  // hung primary can never starve the fallbacks of their chance — previously a
  // single shared deadline let one slow model burn the whole budget and the
  // user got "took too long" without the fallback ever being tried. An overall
  // cap (PROVIDER_TIMEOUT_MS) still bounds the whole attempt.
  const PER_MODEL_TIMEOUT_MS = 12000;
  let upstream;
  let syntheticContent = "";
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
            temperature: 0.7,
          });
          const skipThinking = !hasImage && !useFreeBrain;
          const reqBody = plainBody();
          if (skipThinking) reqBody.reasoning = { effort: "none" };
          out = useFreeBrain
            ? await chatBrainPost(reqBody, mc.signal, 3)
            : await providerPost(
                `${API_URL}/chat/completions`,
                reqBody,
                mc.signal,
                models.length === 1 ? 3 : 2,
                activeKey
              );
          const rs = out.status || 0;
          if (!out.ok && !useFreeBrain && skipThinking && rs >= 400 && rs < 500 && rs !== 429) {
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
            detail: e && e.name === "AbortError" ? "request timed out" : String((e && e.message) || e),
          };
        } finally {
          clearTimeout(mt);
          overall.signal.removeEventListener("abort", forwardAbort);
        }
        if (out.ok) break;
        const s = out.status || 0;
        // A 404 means this model id no longer exists on the provider (common
        // on the free tier) — try the next model, don't give up. Same for rate
        // limits (429), server errors (5xx), and network failures (0). Other
        // 4xx errors (bad key, bad payload) are final.
        if (s === 404 || s === 429 || s === 0 || s >= 500) continue;
        break;
      }
    } finally {
      clearTimeout(overallTimer);
    }
    // Emergency fallback for the shared brain: if the credit-backed OpenRouter
    // brain fails or hangs, answer once from the free keyless Pollinations
    // endpoint and synthesize the sanitized SSE from the full reply — the
    // user still gets their answer instead of an error, and no credit is
    // spent on this path.
    if (!out.ok && useFreeBrain && userText) {
      const fbCtrl = new AbortController();
      const fbTimer = setTimeout(() => fbCtrl.abort(), 20000);
      try {
        const fbResp = await fetch(CHAT_FALLBACK_API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "HTTP-Referer": "https://mojo-ai.vercel.app",
          },
          body: JSON.stringify({
            model: CHAT_FALLBACK_MODEL,
            messages: buildMessages(body),
            stream: false,
            temperature: 0.7,
          }),
          signal: fbCtrl.signal,
        });
        if (fbResp.ok) {
          const fbJson = await fbResp.json().catch(() => null);
          const fbChoice = fbJson && Array.isArray(fbJson.choices) && fbJson.choices[0];
          const fbText = fbChoice && fbChoice.message && fbChoice.message.content;
          if (typeof fbText === "string" && fbText.trim()) syntheticContent = fbText;
        }
      } catch {
        /* fall through to the normal error path */
      } finally {
        clearTimeout(fbTimer);
      }
    }
    if (!out.ok && !syntheticContent) {
      noStore(res);
      if (hasImage) {
        return res.status(502).json({
          error: "AI_CONNECTION_ERROR",
          detail: friendlyDetail(
            out.detail,
            "The image reader is temporarily down on the provider's side. Please try again in a little while."
          ),
        });
      }
      const detail = friendlyDetail(out.detail, "Mojo's chat brain is busy right now. Please try again in a moment.");
      return res
        .status(502)
        .json({ error: "AI_CONNECTION_ERROR", detail });
    }
    upstream = out.ok ? out.resp : null;
  } catch (e) {
    noStore(res);
    const timedOut = e && e.name === "AbortError";
    return res.status(timedOut ? 504 : 502).json({
            error: timedOut ? "AI_TIMEOUT" : "AI_CONNECTION_ERROR",
      detail: timedOut
        ? "Mojo took too long to respond. Please try again."
        : "Couldn't reach Mojo's brain. Please check your connection and try again.",
    });
  }

  // Privacy: do NOT stream the provider's raw SSE through. Providers embed
  // model names, request ids, timestamps, usage stats, and invisible
  // "reasoning" tokens in their stream. Instead, re-emit a sanitized Mojo
  // stream carrying only the visible assistant text plus the [DONE] marker —
  // nothing a curious user could use to identify the provider.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const write = (line) => {
    res.write(line + "\n\n");
    if (typeof res.flush === "function") res.flush();
  };
  // Non-stream fallback: emit the rescued answer as one sanitized SSE chunk
  // so the frontend renders it exactly like a normal streamed reply.
  if (syntheticContent && !upstream) {
    write("data: " + JSON.stringify({ choices: [{ delta: { content: syntheticContent }, finish_reason: null }] }));
    write("data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }));
    write("data: [DONE]");
    res.end();
    return;
  }
  let broken = false;
  let buf = "";
  const decoder = new TextDecoder();
  const handleLine = (line) => {
    if (!line.startsWith("data:")) return; // drop comments / keep-alives
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") {
      write("data: [DONE]");
      return;
    }
    let j;
    try {
      j = JSON.parse(payload);
    } catch {
      return; // malformed fragment: never leak it raw
    }
    if (j && j.error) {
      write('data: {"error":"STREAM_ERROR"}'); // neutral, no provider detail
      return;
    }
    const choice = j && Array.isArray(j.choices) && j.choices[0];
    if (!choice) return;
    const delta = choice.delta || {};
    const content = typeof delta.content === "string" ? delta.content : "";
    // reasoning tokens are never forwarded: they are invisible thinking,
    // not part of the visible answer.
    if (content || choice.finish_reason) {
      const clean = {
        choices: [
          {
            delta: content ? { content } : {},
            finish_reason: choice.finish_reason || null,
          },
        ],
      };
      write("data: " + JSON.stringify(clean));
    }
  };
  try {
    for await (const chunk of upstream.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) handleLine(line);
      }
    }
    buf += decoder.decode();
    const tail = buf.trim();
    if (tail) handleLine(tail);
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
