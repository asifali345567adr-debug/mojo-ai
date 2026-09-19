// POST /api/research — web research using the user's OWN Tavily API key.
//
// The key arrives in the request body and is used only for this single
// proxied search: never logged, never stored server-side, never echoed back.
// Tavily's free tier gives 1,000 free searches/month per key (no card), so
// research bills to the user's own Tavily account — not to Mojo.
import { clientIp, rateLimited, fetchWithTimeout, noStore } from "./_lib.js";

const MAX_KEY_CHARS = 200;
const MAX_QUERY_CHARS = 500;
const RESEARCH_TIMEOUT_MS = 20_000;
const RESULT_COUNT = 8;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    noStore(res);
    return res.status(405).json({ error: "method_not_allowed" });
  }
  const ip = clientIp(req);
  const rl = rateLimited(ip);
  if (rl.limited) {
    noStore(res);
    return res.status(429).json({ error: "rate_limited", detail: "Too many requests. Try again shortly." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const apiKey = String(body.apiKey || "").trim();
  const query = String(body.query || "").trim();

  if (!apiKey || apiKey.length > MAX_KEY_CHARS) {
    noStore(res);
    return res.status(400).json({ error: "bad_api_key", detail: "A Tavily API key is required for Research." });
  }
  if (!query || query.length > MAX_QUERY_CHARS) {
    noStore(res);
    return res.status(400).json({ error: "empty_query", detail: "Type what you want researched first." });
  }


  let resp;
  try {
    resp = await fetchWithTimeout(
      "https://api.tavily.com/search",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          search_depth: "basic",
          max_results: RESULT_COUNT,
        }),
      },
      RESEARCH_TIMEOUT_MS
    );
  } catch (e) {
    noStore(res);
    return res.status(502).json({ error: "search_unreachable", detail: "Couldn't reach the search service. Check your connection." });
  }

  if (resp.status === 401 || resp.status === 403) {
    noStore(res);
    return res.status(400).json({ error: "bad_search_key", detail: "That Tavily key was rejected. Check it and try again." });
  }
  if (resp.status === 429) {
    noStore(res);
    return res.status(429).json({ error: "search_quota", detail: "Search quota exceeded on that key. Try again later." });
  }
  if (!resp.ok) {
    noStore(res);
    return res.status(502).json({ error: "search_failed", detail: "The search service returned an error (HTTP " + resp.status + ")." });
  }

  const data = await resp.json().catch(() => null);
  const hits = (data && Array.isArray(data.results)) ? data.results : [];
  const results = hits.slice(0, RESULT_COUNT).map(r => ({
    title: String(r.title || "Untitled").slice(0, 160),
    url: String(r.url || "").slice(0, 300),
    snippet: String(r.content || "").slice(0, 400),
  })).filter(r => r.url);

  noStore(res);
  return res.status(200).json({ results });
}
