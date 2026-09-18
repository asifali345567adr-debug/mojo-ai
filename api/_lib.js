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

const PER_MINUTE = Number(process.env.RATE_PER_MINUTE) || 30;
const PER_DAY = Number(process.env.RATE_PER_DAY) || 300;

// Tiny in-memory per-IP rate limiter (best-effort on serverless: resets per instance).
const buckets = new Map();
export function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
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
  return b.minute.count > PER_MINUTE || b.day.count > PER_DAY;
}

export function buildMessages(body) {
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  const history = Array.isArray(body.history) ? body.history.slice(-20) : [];
  for (const m of history) {
    const role = String(m.role || "").toLowerCase();
    if (role !== "user" && role !== "assistant" && role !== "mojo" && role !== "jarvis") continue;
    messages.push({
      role: role === "user" ? "user" : "assistant",
      content: String(m.text || m.content || "").slice(0, 4000),
    });
  }
  const userText = String(body.message || "").slice(0, 4000);
  if (body.image && typeof body.image === "string" && body.image.startsWith("data:image")) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: userText || "Describe this image." },
        { type: "image_url", image_url: { url: body.image.slice(0, 300_000) } },
      ],
    });
  } else {
    messages.push({ role: "user", content: userText });
  }
  return messages;
}

export async function callProvider(messages, modelOverride) {
  const r = await fetch(`${API_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      "HTTP-Referer": "https://muse.ai",
      "X-Title": "Mojo AI",
    },
    body: JSON.stringify({ model: modelOverride || MODEL, messages }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error((data && data.error && data.error.message) || `provider HTTP ${r.status}`);
    err.status = 502;
    throw err;
  }
  return (data && data.choices && data.choices[0] && data.choices[0].message.content) || "";
}
