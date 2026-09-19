// Free image generation for Mojo AI.
//
// Two providers, picked automatically:
//   1. Hugging Face Inference Providers (FLUX.1-schnell via nscale) when the
//      HF_TOKEN env var is set — no watermark, better quality. The token is
//      free; the user adds it in Vercel. (The classic serverless route no
//      longer serves FLUX.1-schnell, so we go through the provider router.)
//   2. Pollinations (free) — same FLUX quality. Anonymous calls carry their
//      watermark, but with a free Pollinations account token (POLLINATIONS_KEY
//      env var, "Seed" tier) the nologo=true flag actually removes it, so the
//      fallback is watermark-free too. No key? Falls back to anonymous.
//
// Images stream back through this function and are never stored on the server.

import { clientIp, rateLimited, noStore, API_URL, API_KEY, MODEL, userKeyFromReq } from "./_lib.js";

const MAX_PROMPT_CHARS = 2000;
const IMAGE_TIMEOUT_MS = 55_000;
const ENHANCE_TIMEOUT_MS = 12_000; // budget for AI prompt enhancement
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB
const MAX_ATTEMPTS = 3;

// Optional: free Pollinations account token ("Seed" tier) from
// https://auth.pollinations.ai — enables watermark-free nologo fallback.
const POLLINATIONS_KEY = process.env.POLLINATIONS_KEY || "";

const HF_PROVIDER_URL =
  "https://router.huggingface.co/nscale/v1/images/generations";
const HF_MODEL = "black-forest-labs/FLUX.1-schnell";
const POLLINATIONS_BASE = "https://image.pollinations.ai/prompt";

function fail(res, status, error, detail) {
  noStore(res);
  return res.status(status).json({ error, detail });
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError() {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

async function cancelBody(resp) {
  try {
    if (resp.body && resp.body.cancel) await resp.body.cancel();
  } catch (e) {}
}

// Detect the real image type from magic bytes. The HF provider returns PNG
// bytes even though older code labelled them image/jpeg; a wrong MIME breaks
// downloads (a PNG saved as .jpg). Sniff instead of trusting labels.
function sniffMime(buf) {
  if (!buf || buf.length < 12) return "image/png";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  )
    return "image/webp";
  return "image/png";
}

// AI prompt enhancement: rewrite the user's (often short, sometimes Roman
// Urdu) idea into a detailed English image prompt via the chat model. This is
// the main lever for "photo accurate nahi ban raha" — FLUX follows a rich,
// precise prompt far better than a 5-word one. Uses the caller's personal
// brain key when present, else the server key. Never throws: on any failure
// the caller falls back to the raw prompt.
async function enhancePrompt(prompt, req, signal) {
  const key = userKeyFromReq(req) || API_KEY;
  if (!key) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    try { ctrl.abort(); } catch (e) {}
  }, ENHANCE_TIMEOUT_MS);
  const onAbort = () => { try { ctrl.abort(); } catch (e) {} };
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    const resp = await fetch(`${API_URL}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 220,
        temperature: 0.7,
        messages: [
          {
            role: "system",
            content:
              "You are an expert prompt engineer for text-to-image AI models (FLUX). " +
              "Rewrite the user's idea as ONE detailed, vivid English image prompt, 40-90 words. " +
              "Cover: main subject, setting/background, lighting, composition, art style, and quality " +
              "words (sharp focus, high detail, professional). If the idea is vague, make sensible " +
              "concrete choices. Output ONLY the prompt text — no quotes, no preamble, no explanation.",
          },
          { role: "user", content: prompt.slice(0, 1000) },
        ],
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    const text =
      data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : "";
    const out = String(text || "")
      .trim()
      .replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, "");
    if (out.length < 10) return null;
    return out.slice(0, 900);
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

// Hugging Face path: FLUX.1-schnell through the Inference Providers router
// (nscale). Same shape as the official @huggingface/inference client:
// POST {prompt, model, response_format: "b64_json"} and decode data[0].b64_json.
// Needs the token's "Make calls to Inference Providers" permission.
async function generateViaHF(prompt, token, signal) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) throw abortError();
    let resp;
    try {
      resp = await fetch(HF_PROVIDER_URL, {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt,
          model: HF_MODEL,
          size: "1024x1024",
          response_format: "b64_json",
        }),
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      if (attempt === MAX_ATTEMPTS) return { ok: false };
      await sleep(attempt * 1000, signal);
      continue;
    }
    if (resp.ok) {
      let data = null;
      try {
        data = await resp.json();
      } catch (e) {
        await cancelBody(resp);
      }
      const b64 =
        data && data.data && data.data[0] && data.data[0].b64_json;
      if (typeof b64 === "string" && b64.length > 0) {
        return { ok: true, buffer: Buffer.from(b64, "base64") };
      }
      if (attempt === MAX_ATTEMPTS) return { ok: false };
      await sleep(attempt * 1000, signal);
      continue;
    }
    const status = resp.status;
    await cancelBody(resp);
    const retryable = status >= 500 || status === 429;
    if (!retryable || attempt === MAX_ATTEMPTS) return { ok: false, status };
    await sleep(attempt * 1000, signal);
  }
  return { ok: false };
}

// Pollinations path: plain GET; retries transient 5xx/429 with backoff.
// When POLLINATIONS_KEY is set (free account token), it is sent as a Bearer
// token so nologo=true is honored and the image comes back watermark-free.
async function generateViaPollinations(prompt, signal) {
  const url =
    `${POLLINATIONS_BASE}/${encodeURIComponent(prompt)}` +
    "?width=1024&height=1024&model=flux&nologo=true&private=true&enhance=true";
  const headers = POLLINATIONS_KEY
    ? { Authorization: `Bearer ${POLLINATIONS_KEY}` }
    : {};
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) throw abortError();
    try {
      const upstream = await fetch(url, { signal, headers });
      if (upstream.ok) return { ok: true, upstream };
      const status = upstream.status;
      await cancelBody(upstream);
      const retryable = status >= 500 || status === 429;
      if (!retryable || attempt === MAX_ATTEMPTS) return { ok: false, status };
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      if (attempt === MAX_ATTEMPTS) return { ok: false };
    }
    await sleep(attempt * 1000, signal);
  }
  return { ok: false };
}

// Validate and stream the image bytes to the client with a hard byte cap.
async function pipeImage(res, upstream, provider) {
  const contentType = upstream.headers.get("content-type") || "";
  if (!contentType.startsWith("image/")) {
    await cancelBody(upstream);
    return fail(
      res,
      502,
      "IMAGE_ERROR",
      "The image service returned an unexpected response. Please try again."
    );
  }
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
    "X-Image-Provider": provider || "pollinations",
  });
  return res.end(Buffer.concat(chunks));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    noStore(res);
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

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

  const hfToken = process.env.HF_TOKEN;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IMAGE_TIMEOUT_MS);
  try {
    // Expand the raw idea into a detailed image prompt first — the single
    // biggest accuracy lever. Falls back to the raw prompt on any failure.
    const enhanced = await enhancePrompt(prompt, req, ctrl.signal);
    const finalPrompt = enhanced || prompt;
    // Prefer Hugging Face (no watermark) when a token is configured.
    if (hfToken) {
      const hf = await generateViaHF(finalPrompt, hfToken, ctrl.signal);
      if (hf.ok) {
        clearTimeout(timer);
        const buf = hf.buffer;
        if (!buf || buf.length === 0 || buf.length > MAX_IMAGE_BYTES) {
          return fail(
            res,
            502,
            "IMAGE_ERROR",
            "The image service returned an unexpected response. Please try again."
          );
        }
        res.writeHead(200, {
          "Content-Type": sniffMime(buf),
          "Content-Length": String(buf.length),
          "Cache-Control": "no-store",
          "X-Image-Provider": "huggingface",
        });
        return res.end(buf);
      }
      // A bad/revoked token is a config problem the user must fix — say so.
      if (hf.status === 401 || hf.status === 403) {
        clearTimeout(timer);
        return fail(
          res,
          502,
          "IMAGE_KEY_ERROR",
          "The image service key isn't working. Please check it and try again."
        );
      }
      // Any other HF failure: fall through to Pollinations rather than erroring.
      // Log the upstream status (code only, never the token) for diagnostics.
      console.log("[image] hf upstream not ok, status:", hf.status ?? "network-error");
    }
    const out = await generateViaPollinations(finalPrompt, ctrl.signal);
    clearTimeout(timer);
    if (!out.ok) {
      return fail(
        res,
        502,
        "IMAGE_ERROR",
        "The image service is temporarily down. Please try again in a little while."
      );
    }
    return pipeImage(res, out.upstream, "pollinations");
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
