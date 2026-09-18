// Shared helpers for the Mojo AI Vercel serverless functions.
// The API key stays server-side: it is read from env vars, never sent to the browser.

export const API_KEY =
  process.env.AI_API_KEY || process.env.OPENAI_API_KEY || "";
export const API_URL = (process.env.AI_API_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
export const MODEL = process.env.AI_MODEL || "deepseek/deepseek-v4-flash-0731:free";
// Used automatically when a message includes an image (MODEL can't read images).
export const VISION_MODEL = process.env.AI_VISION_MODEL || "qwen/qwen3.8-27b:free";
export const SYSTEM_PROMPT =
  process.env.AI_SYSTEM_PROMPT ||
  "You are Mojo, a precise and efficient AI assistant with dry wit. Address the user as sir. Keep answers concise unless detail is requested.";

// Safety caps.
export const MAX_MESSAGE_CHARS = 4000;
export const MAX_HISTORY_ITEMS = 20;
export const MAX_IMAGE_CHARS = 1_500_000; // data-URL chars (~1.1 MB of image bytes, base64-inflated)
export const PROVIDER_TIMEOUT_MS = 50_000;

const PER_MINUTE = Number(process.env.RATE_PER_MINUTE) || 30;
const PER_DAY = Number(process.env.RATE_PER_DAY) || 300;

// In-memory per-IP rate limiter (best-effort on serverless: each instance keeps its own counters).
const buckets = new Map();
export function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real) return real.trim();
  return "unknown";
}
export function rateLimited(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) {
    b = { minute: { start: now, count: 0 }, day: { start: now, count: 0 } };
    buckets.set(ip, b);
  }
  if (now - b.minute.start > 60_000) b.minute = { start: now, count: 0 };
  if (now - b.day.start > 86_400_000) b.day = { start: now, count: 0 };
  b.minute.count += 1;
  b.day.count += 1;
  const limited = b.minute.count > PER_MINUTE || b.day.count > PER_DAY;
  const retryAfter = limited
    ? Math.max(1, Math.ceil((60_000 - (now - b.minute.start)) / 1000))
    : 0;
  return { limited, retryAfter };
}
// Sweep stale buckets on warm instances so the map can't grow without bound.
if (!globalThis.__mojoBucketSweeper) {
  const t = setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of buckets) {
      if (now - b.day.start > 86_400_000 && now - b.minute.start > 3_600_000) buckets.delete(ip);
    }
  }, 600_000);
  if (typeof t.unref === "function") t.unref();
  globalThis.__mojoBucketSweeper = t;
}

export function buildMessages(body) {
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  const history = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY_ITEMS) : [];
  for (const m of history) {
    const role = String(m.role || "").toLowerCase();
    if (role !== "user" && role !== "assistant" && role !== "mojo" && role !== "jarvis") continue;
    const text = String(m.text || m.content || "").slice(0, MAX_MESSAGE_CHARS);
    if (!text) continue;
    messages.push({ role: role === "user" ? "user" : "assistant", content: text });
  }
  const userText = String(body.message || "").slice(0, MAX_MESSAGE_CHARS);
  if (body.image && typeof body.image === "string" && body.image.startsWith("data:image")) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: userText || "Describe this image." },
        { type: "image_url", image_url: { url: body.image.slice(0, MAX_IMAGE_CHARS) } },
      ],
    });
  } else {
    messages.push({ role: "user", content: userText });
  }
  return messages;
}

export function providerHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_KEY}`,
    "HTTP-Referer": "https://mojo-ai.vercel.app",
    "X-Title": "Mojo AI",
  };
}

// fetch() with a hard timeout so a hung provider can never hang the function.
export function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, Object.assign({}, opts, { signal: ctrl.signal })).finally(() =>
    clearTimeout(to)
  );
}

// POST to the provider, automatically retrying transient failures.
// A brief upstream hiccup (HTTP 5xx or a network error — e.g. OpenRouter's
// "Provider returned error") is retried up to `attempts` times with backoff
// before we ever bother the user about it. Client errors (4xx) are final and
// are never retried. `signal` should carry an overall deadline; retries share
// whatever budget is left.
export async function providerPost(url, bodyObj, signal, attempts = 3) {
  const payload = JSON.stringify(bodyObj);
  let lastStatus = 0;
  let lastErrText = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal && signal.aborted) {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: providerHeaders(),
        body: payload,
        signal: signal || undefined,
      });
      if (resp.ok) return { ok: true, resp };
      lastStatus = resp.status;
      lastErrText = await resp.text().catch(() => "");
      try {
        if (resp.body && resp.body.cancel) await resp.body.cancel();
      } catch (e) {}
      if (resp.status < 500 || attempt === attempts) break;
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      lastStatus = 0;
      if (attempt === attempts) break;
    }
    await new Promise((r) => setTimeout(r, attempt * 1200));
  }
  let detail = lastErrText;
  try {
    const data = JSON.parse(lastErrText);
    if (data && data.error && data.error.message) detail = String(data.error.message);
  } catch (e) {}
  detail = String(detail || "").slice(0, 200);
  return { ok: false, status: lastStatus, detail: detail || `provider HTTP ${lastStatus}` };
}

// API responses are never cacheable.
export function noStore(res) {
  res.setHeader("Cache-Control", "no-store");
}
