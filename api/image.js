// Free image generation for Mojo AI.
//
// Two providers, picked automatically:
//   1. Hugging Face Inference Providers (FLUX.1-schnell via nscale) when the
//      HF_TOKEN env var is set — no watermark, better quality. The token is
//      free; the user adds it in Vercel. (The classic serverless route no
//      longer serves FLUX.1-schnell, so we go through the provider router.)
//   2. Pollinations anonymous endpoint otherwise — free with no key, but every
//      image carries the Pollinations watermark (their rule: nologo needs an
//      account, and our nologo=true is still sent on the off chance it helps).
//
// Images stream back through this function and are never stored on the server.

import { clientIp, rateLimited, noStore } from "./_lib.js";

const MAX_PROMPT_CHARS = 2000;
const IMAGE_TIMEOUT_MS = 55_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB
const MAX_ATTEMPTS = 3;

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
async function generateViaPollinations(prompt, signal) {
  const url =
    `${POLLINATIONS_BASE}/${encodeURIComponent(prompt)}` +
    "?width=1024&height=1024&model=flux&nologo=true&private=true&enhance=true";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) throw abortError();
    try {
      const upstream = await fetch(url, { signal });
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
async function pipeImage(res, upstream) {
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
    // Prefer Hugging Face (no watermark) when a token is configured.
    if (hfToken) {
      const hf = await generateViaHF(prompt, hfToken, ctrl.signal);
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
          "Content-Type": "image/jpeg",
          "Content-Length": String(buf.length),
          "Cache-Control": "no-store",
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
    const out = await generateViaPollinations(prompt, ctrl.signal);
    clearTimeout(timer);
    if (!out.ok) {
      return fail(
        res,
        502,
        "IMAGE_ERROR",
        "The image service is temporarily down. Please try again in a little while."
      );
    }
    return pipeImage(res, out.upstream);
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
