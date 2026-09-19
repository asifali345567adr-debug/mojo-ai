// Free image generation for Mojo AI, powered by Pollinations (no API key needed).
// The prompt is sent to Pollinations; the image streams back through this
// function and is never stored on the server.

import { clientIp, rateLimited, noStore } from "./_lib.js";

const POLLINATIONS_BASE = "https://image.pollinations.ai/prompt";
const MAX_PROMPT_CHARS = 600;
const IMAGE_TIMEOUT_MS = 55_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB

function fail(res, status, error, detail) {
  noStore(res);
  return res.status(status).json({ error, detail });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    noStore(res);
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  // Image generation shares the per-IP rate limiter with chat, so one bad
  // actor can't burn the pipe on images alone.
  const rl = rateLimited(clientIp(req));
  if (rl.limited) {
    if (rl.retryAfter > 0) res.setHeader("Retry-After", String(Math.min(rl.retryAfter, 60)));
    return fail(res, 429, "RATE_LIMITED", "Too many requests. Please wait a moment and try again.");
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const prompt = String(body.prompt || "").trim();
  if (!prompt) {
    return fail(res, 400, "EMPTY_PROMPT", "Please describe the image you want first.");
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return fail(
      res,
      400,
      "PROMPT_TOO_LONG",
      `Please keep the description under ${MAX_PROMPT_CHARS} characters.`
    );
  }

  const url =
    `${POLLINATIONS_BASE}/${encodeURIComponent(prompt)}` +
    "?width=1024&height=1024&nologo=true&private=true";

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IMAGE_TIMEOUT_MS);
  try {
    const upstream = await fetch(url, { signal: ctrl.signal });
    if (!upstream.ok) {
      try {
        if (upstream.body && upstream.body.cancel) await upstream.body.cancel();
      } catch (e) {}
      return fail(
        res,
        502,
        "IMAGE_ERROR",
        "The image service is temporarily down. Please try again in a little while."
      );
    }
    const contentType = upstream.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) {
      try {
        if (upstream.body && upstream.body.cancel) await upstream.body.cancel();
      } catch (e) {}
      return fail(
        res,
        502,
        "IMAGE_ERROR",
        "The image service returned an unexpected response. Please try again."
      );
    }
    // Read with a hard byte cap so a runaway response can never blow memory.
    const reader = upstream.body.getReader();
    const chunks = [];
    let total = 0;
    let tooBig = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_IMAGE_BYTES) {
          tooBig = true;
          break;
        }
        chunks.push(value);
      }
    } finally {
      try {
        await reader.cancel();
      } catch (e) {}
    }
    clearTimeout(timer);
    if (tooBig) {
      return fail(
        res,
        502,
        "IMAGE_ERROR",
        "The generated image was too large. Please try a simpler description."
      );
    }
    if (total === 0) {
      return fail(res, 502, "IMAGE_ERROR", "The image service returned nothing. Please try again.");
    }
    res.writeHead(200, {
      "Content-Type": contentType.split(";")[0],
      "Content-Length": String(total),
      "Cache-Control": "no-store",
    });
    return res.end(Buffer.concat(chunks));
  } catch (e) {
    clearTimeout(timer);
    const timedOut = e && e.name === "AbortError";
    return fail(
      res,
      timedOut ? 504 : 502,
      timedOut ? "IMAGE_TIMEOUT" : "IMAGE_ERROR",
      timedOut
        ? "Image generation took too long. Please try again."
        : "Couldn't reach the image service. Please try again."
    );
  }
}
