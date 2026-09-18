// Mojo AI backend — secure AI proxy for the Mojo AI web app.
// Keeps your API key server-side. The web app never sees it.
//
// Env vars:
//   AI_API_KEY       (required) your provider API key (OpenRouter / OpenAI)
//   AI_API_URL       (optional) default https://openrouter.ai/api/v1
//   AI_MODEL         (optional) default deepseek/deepseek-v4-flash-0731:free
//   AI_SYSTEM_PROMPT (optional) override the assistant persona
//   RATE_PER_MINUTE  (optional) max chat requests per IP per minute, default 30
//   RATE_PER_DAY     (optional) max chat requests per IP per day, default 300
//
// Run:  node server.mjs   (serves API on PORT, default 8787)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = path.dirname(fileURLToPath(import.meta.url)) + "/public";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  // block traversal and api paths (api handled elsewhere)
  const safe = path.normalize(p).replace(/^(\.\.[\/\\])+/, "");
  let file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) return false;
  try {
    const st = fs.statSync(file);
    if (st.isDirectory()) file = path.join(file, "index.html");
  } catch {
    // SPA fallback: extensionless routes serve the app shell
    if (!path.extname(file)) file = path.join(PUBLIC_DIR, "index.html");
    else return false;
  }
  try {
    const data = fs.readFileSync(file);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

const PORT = Number(process.env.PORT) || 8787;
const API_KEY = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || "";
const API_URL = (process.env.AI_API_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
const MODEL = process.env.AI_MODEL || "deepseek/deepseek-v4-flash-0731:free";
const SYSTEM_PROMPT =
  process.env.AI_SYSTEM_PROMPT ||
  "You are Mojo, a precise and efficient AI assistant with dry wit. Address the user as sir. Keep answers concise unless detail is requested.";

const PER_MINUTE = Number(process.env.RATE_PER_MINUTE) || 30;
const PER_DAY = Number(process.env.RATE_PER_DAY) || 300;

// --- tiny in-memory per-IP rate limiter (resets on restart) ---
const buckets = new Map(); // ip -> { minute: {start, count}, day: {start, count} }
function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}
function rateLimited(ip) {
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
// prune idle buckets every 10 minutes so memory stays flat
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) {
    if (now - b.day.start > 86_400_000 && now - b.minute.start > 600_000) buckets.delete(ip);
  }
}, 600_000).unref();

function send(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});

  if (req.method === "GET" && req.url === "/api/health") {
    return send(res, 200, { ok: true, model: MODEL, keyConfigured: !!API_KEY });
  }

  if (req.method === "POST" && req.url === "/api/chat") {
    const ip = clientIp(req);
    if (rateLimited(ip)) {
      return send(res, 429, { error: "RATE_LIMITED", detail: "Too many requests. Please wait a moment." });
    }
    if (!API_KEY) return send(res, 500, { error: "AI_CONNECTION_NOT_CONFIGURED" });

    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 200_000) break; // guard against giant bodies
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: "bad_request" });
    }

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
    if (!userText && !body.image) return send(res, 400, { error: "empty_message" });
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

    try {
      const r = await fetch(`${API_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
          "HTTP-Referer": "https://muse.ai",
          "X-Title": "Mojo AI",
        },
        body: JSON.stringify({ model: body.model || MODEL, messages }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        return send(res, 502, {
          error: "AI_CONNECTION_ERROR",
          detail: (data && data.error && data.error.message) || `provider HTTP ${r.status}`,
        });
      }
      const reply =
        (data && data.choices && data.choices[0] && data.choices[0].message.content) || "";
      return send(res, 200, { reply });
    } catch (e) {
      return send(res, 502, { error: "AI_CONNECTION_ERROR", detail: String(e).slice(0, 200) });
    }
  }

  // Static frontend (public/): the Mojo web app itself, served same-origin.
  if (req.method === "GET" && !req.url.startsWith("/api")) {
    if (serveStatic(req, res)) return;
  }

  return send(res, 404, { error: "not_found" });
});

server.listen(PORT, () =>
  console.log(`Mojo backend listening on :${PORT}  model=${MODEL}  key=${API_KEY ? "set" : "MISSING"}`)
);
