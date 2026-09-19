// POST /api/tool — run a command on one of the user's own attached AI tools.
//
// The user attaches any OpenAI-compatible tool (Grok, etc.) with THEIR OWN
// API key. The key arrives in the request body and is used only for this
// single proxied request: it is never logged, never stored server-side, and
// never echoed back in any response. All AI usage bills to the user's own
// provider account, so attached tools cost Mojo nothing to run.
import { clientIp, rateLimited, fetchWithTimeout, noStore } from "./_lib.js";

const MAX_KEY_CHARS = 500;
const MAX_URL_CHARS = 200;
const MAX_MODEL_CHARS = 120;
const MAX_MSG_CHARS = 3000;
const TOOL_TIMEOUT_MS = 50_000;

// Hosts we will never forward a user's key to (SSRF guard). The key must only
// ever travel to a real public provider the user chose.
function hostBlocked(hostname) {
  const h = String(hostname || "").toLowerCase().trim();
  if (!h) return true;
  if (h === "localhost" || h === "metadata.google.internal") return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = +v4[1], b = +v4[2];
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (h === "::1" || h === "[::1]") return true;
  return false;
}

// Normalize to scheme + host only; rejects non-https, credentials in the URL,
// private hosts, and over-long values.
function cleanBaseUrl(raw) {
  const s = String(raw || "").trim().replace(/\/+$/, "");
  if (!s || s.length > MAX_URL_CHARS) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (hostBlocked(u.hostname)) return null;
  return u.origin;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    noStore(res);
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
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

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const baseUrl = cleanBaseUrl(body.baseUrl);
  const apiKey = String(body.apiKey || "").trim();
  const model = String(body.model || "").trim();
  const message = String(body.message || "").trim();

  if (!baseUrl) {
    noStore(res);
    return res.status(400).json({ error: "bad_base_url", detail: "That tool address doesn't look valid. Use an https:// address." });
  }
  if (apiKey.length < 8 || apiKey.length > MAX_KEY_CHARS) {
    noStore(res);
    return res.status(400).json({ error: "bad_api_key", detail: "An API key is required to run your tool." });
  }
  if (!model || model.length > MAX_MODEL_CHARS) {
    noStore(res);
    return res.status(400).json({ error: "bad_model", detail: "A model name is required for your tool." });
  }
  if (!message || message.length > MAX_MSG_CHARS) {
    noStore(res);
    return res.status(400).json({ error: "empty_message", detail: "Type a command for your tool first." });
  }

  const url = baseUrl + "/chat/completions";
  const payload = JSON.stringify({
    model,
    messages: [{ role: "user", content: message }],
    stream: false,
    max_tokens: 2000,
  });

  let lastStatus = 0;
  let lastDetail = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
          body: payload,
        },
        TOOL_TIMEOUT_MS
      );
      const text = await resp.text().catch(() => "");
      let data = null;
      try { data = JSON.parse(text); } catch { /* non-JSON upstream */ }
      if (resp.ok && data) {
        const ch = data.choices && data.choices[0] && data.choices[0].message;
        const reply = ch ? String(ch.content || "") : "";
        noStore(res);
        return res.status(200).json({ ok: true, reply: reply.slice(0, 12000), model });
      }
      lastStatus = resp.status;
      lastDetail = data && data.error && data.error.message ? String(data.error.message) : "";
      try { if (resp.body && resp.body.cancel) await resp.body.cancel(); } catch {}
      if (!(resp.status >= 500 || resp.status === 429)) break; // client error: final
    } catch (e) {
      lastDetail = e && e.name === "AbortError" ? "The tool took too long to respond." : "Couldn't reach the tool.";
      break;
    }
    await new Promise((r) => setTimeout(r, 900));
  }

  // Never echo the key. Translate common provider failures into plain words.
  noStore(res);
  let detail = String(lastDetail || "").slice(0, 200);
  if (lastStatus === 401 || lastStatus === 403) {
    detail = "The tool rejected the API key. Check the key and try again.";
  } else if (lastStatus === 404) {
    detail = "The tool address or model wasn't found. Check the base URL and model name.";
  } else if (lastStatus === 429) {
    detail = "The tool is rate-limiting requests right now. Try again shortly.";
  } else if (!detail) {
    detail = "The tool returned an error.";
  }
  return res.status(502).json({ error: "TOOL_ERROR", detail });
}
