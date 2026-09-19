// Free web search for Mojo AI — no key, no signup, no cost.
//
// Two keyless sources, merged server-side:
//   1. Wikipedia API (action=query&list=search) — reliable results with links.
//   2. DuckDuckGo instant answers — a direct answer/abstract when one exists.
//
// Nothing is stored server-side; results stream back through this function.

import { clientIp, rateLimited, noStore, fetchWithTimeout } from "./_lib.js";

const MAX_Q_CHARS = 300;
const SEARCH_TIMEOUT_MS = 12_000;
const MAX_RESULTS = 8;

function fail(res, status, error, detail) {
  noStore(res);
  return res.status(status).json({ error, detail });
}

function clean(s) {
  return String(s || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function wikiSearch(q) {
  const url =
    "https://en.wikipedia.org/w/api.php?action=query&list=search" +
    "&srsearch=" + encodeURIComponent(q) +
    "&format=json&srlimit=8&srprop=snippet&utf8=1&origin=*";
  const resp = await fetchWithTimeout(url, { headers: { "User-Agent": "MojoAI/1.0" } }, SEARCH_TIMEOUT_MS);
  if (!resp.ok) throw new Error("wiki HTTP " + resp.status);
  const data = await resp.json();
  const hits = (data && data.query && data.query.search) || [];
  return hits.map(h => ({
    title: clean(h.title),
    snippet: clean(h.snippet).slice(0, 220),
    url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(String(h.title).replace(/ /g, "_")),
    source: "Wikipedia",
  })).filter(r => r.title && r.url);
}

async function ddgInstant(q) {
  const url =
    "https://api.duckduckgo.com/?q=" + encodeURIComponent(q) +
    "&format=json&no_html=1&skip_disambig=1&t=mojo-ai";
  const resp = await fetchWithTimeout(url, { headers: { "User-Agent": "MojoAI/1.0" } }, SEARCH_TIMEOUT_MS);
  if (!resp.ok) throw new Error("ddg HTTP " + resp.status);
  const data = await resp.json();
  const out = [];
  const answer = clean(data && data.Answer);
  if (answer) {
    out.push({
      title: "Instant answer",
      snippet: answer.slice(0, 280),
      url: "https://duckduckgo.com/?q=" + encodeURIComponent(q),
      source: "DuckDuckGo",
    });
  } else {
    const abs = clean(data && data.Abstract);
    const absUrl = typeof data.AbstractURL === "string" ? data.AbstractURL : "";
    if (abs && absUrl) {
      out.push({
        title: clean(data.Heading) || "Overview",
        snippet: abs.slice(0, 280),
        url: absUrl,
        source: "DuckDuckGo",
      });
    }
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return fail(res, 405, "method_not_allowed", "Use POST.");
  const ip = clientIp(req);
  const { limited, retryAfter } = rateLimited(ip);
  if (limited) {
    noStore(res);
    res.setHeader("Retry-After", String(retryAfter));
    return res.status(429).json({ error: "rate_limited", detail: "Too many searches — try again shortly." });
  }
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const q = String(body.q || "").trim().slice(0, MAX_Q_CHARS);
  if (!q) return fail(res, 400, "empty_query", "Type something to search.");

  const settled = await Promise.allSettled([ddgInstant(q), wikiSearch(q)]);
  const results = [];
  for (const s of settled) {
    if (s.status === "fulfilled" && Array.isArray(s.value)) {
      for (const r of s.value) {
        if (results.length >= MAX_RESULTS) break;
        if (!results.some(x => x.url === r.url)) results.push(r);
      }
    }
  }
  if (!results.length) {
    return fail(res, 502, "no_results", "The search came back empty — try different words.");
  }
  noStore(res);
  return res.status(200).json({ ok: true, q, results });
}
