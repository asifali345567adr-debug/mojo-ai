/* Mojo — private AI command center frontend.
   Vanilla JS. Same-origin API: GET /api/health, POST /api/chat.
   No external network dependencies. */
"use strict";

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

const LS_CONV = "mojo.conversations.v1";
const LS_ACTIVE = "mojo.active.v1";
const LS_SETTINGS = "mojo.settings.v1";
const LS_BRAIN_KEY = "mojo.brain.key.v1"; // personal API key, stored only in this browser
const LS_NOTES = "mojo.notes.v1"; // things the user asked Mojo to remember, stored only in this browser

/* Personal brain key: the user can paste their own OpenRouter API key in
   Settings → Connection. It never leaves the device except as the X-Brain-Key
   request header to our own backend, which uses it for the provider call
   instead of the server key. The key value is never written into the page. */
function getBrainKey() {
  try { return localStorage.getItem(LS_BRAIN_KEY) || ""; } catch (e) { return ""; }
}
/* Memory: free-text notes the user asked Mojo to remember. Stored only in
   this browser; sent with each chat request so every reply can use them. */
function getNotes() {
  try { return localStorage.getItem(LS_NOTES) || ""; } catch (e) { return ""; }
}
function saveNotes() {
  const v = ((($("#notesInput") || {}).value) || "").trim().slice(0, 1200);
  try { localStorage.setItem(LS_NOTES, v); }
  catch (e) { toast("Could not save in this browser's storage."); return; }
  toast(v ? "Memory saved, sir." : "Memory cleared.");
}
function brainKeyHeaders(extra) {
  const k = getBrainKey();
  const h = extra ? Object.assign({}, extra) : {};
  if (k) h["X-Brain-Key"] = k;
  return h;
}

let conversations = [];
let activeId = null;
let settings = { voiceInput: true, tts: true, voiceLang: "ur-PK" };
let attachedImage = null; // data URL
let health = null;
let sending = false;
let coreState = "idle";
let recognition = null;
let listening = false;
let voices = [];

/* ================= Storage ================= */
function saveConvs() {
  try {
    localStorage.setItem(LS_CONV, JSON.stringify(conversations));
    localStorage.setItem(LS_ACTIVE, activeId || "");
  } catch (e) {
    // Quota (large images): retry with images stripped.
    try {
      const slim = conversations.map(c => Object.assign({}, c, {
        messages: c.messages.map(m => Object.assign({}, m, { img: null }))
      }));
      localStorage.setItem(LS_CONV, JSON.stringify(slim));
    } catch (e2) { /* give up silently */ }
  }
}
function loadConvs() {
  try {
    const raw = localStorage.getItem(LS_CONV);
    if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) conversations = p; }
    // Resume the last open chat so new images/messages keep landing in it
    // instead of spawning a fresh conversation after every reload.
    const aid = localStorage.getItem(LS_ACTIVE) || "";
    activeId = (aid && conversations.some(c => c.id === aid)) ? aid : null;
  } catch (e) { conversations = []; }
}
function saveSettings() { try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch (e) {} }
function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    if (raw) settings = Object.assign({ voiceInput: true, tts: true, voiceLang: "ur-PK" }, JSON.parse(raw));
  } catch (e) {}
}

/* ================= Conversations ================= */
function getActive() { return conversations.find(c => c.id === activeId) || null; }
function makeTitle(text) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  return t.length > 44 ? t.slice(0, 44) + "…" : (t || "New conversation");
}
function createConversation() {
  const c = { id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
              title: "New conversation", createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  conversations.unshift(c);
  activeId = c.id;
  return c;
}
function touchActive() {
  const c = getActive();
  if (c) { c.updatedAt = Date.now(); saveConvs(); }
}
function fmtDate(ts) {
  try {
    const d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  } catch (e) { return ""; }
}

/* ================= Safe markdown-lite ================= */
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function renderMarkdown(src) {
  const blocks = [];
  let t = String(src || "");
  t = t.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    blocks.push('<pre class="code"><code>' + esc(code.replace(/\n$/, "")) + "</code></pre>");
    return "\uE000" + (blocks.length - 1) + "\uE000";
  });
  t = esc(t);
  t = t.replace(/`([^`\n]+)`/g, "<code class=\"inline\">$1</code>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[\s(>])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  // Markdown images ![alt](url) render inline (before the link rule below,
  // so the leading "!" isn't left dangling as link text).
  t = t.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, '<img src="$2" alt="$1" class="msg-md-img" loading="lazy">');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  t = t.replace(/^### (.*)$/gm, "<h4>$1</h4>")
       .replace(/^## (.*)$/gm, "<h3>$1</h3>")
       .replace(/^# (.*)$/gm, "<h3>$1</h3>");
  t = t.replace(/^(?:- |\* )(.*)$/gm, "<li>$1</li>");
  t = t.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>");
  t = t.replace(/\uE000(\d+)\uE000/g, (m, i) => blocks[+i] || "");
  t = t.split(/\n{2,}/).map(block => {
    return block
      .replace(/(<pre[\s\S]*?<\/pre>|<ul>[\s\S]*?<\/ul>|<h[34]>[\s\S]*?<\/h[34]>)/g, "\u0001$1\u0001")
      .split("\u0001").map(part => {
        if (!part.trim()) return "";
        if (/^\s*<(pre|ul|h3|h4)/.test(part)) return part;
        return "<p>" + part.replace(/^\n+|\n+$/g, "").replace(/\n/g, "<br>") + "</p>";
      }).join("");
  }).join("");
  return t;
}

/* ================= Ambient background ================= */
function initAmbient() {
  const cv = $("#ambient");
  const ctx = cv.getContext("2d");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let W = 0, H = 0;
  const dots = [];
  function size() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    W = innerWidth; H = innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  size(); addEventListener("resize", size);
  for (let i = 0; i < 70; i++) {
    dots.push({ x: Math.random(), y: Math.random(), s: 0.6 + Math.random() * 1.8,
      vx: (Math.random() - 0.5) * 0.00012, vy: (Math.random() - 0.5) * 0.00012,
      blue: Math.random() < 0.35, ph: Math.random() * 7 });
  }
  function draw(t) {
    ctx.clearRect(0, 0, W, H);
    for (const d of dots) {
      d.x = (d.x + d.vx + 1) % 1; d.y = (d.y + d.vy + 1) % 1;
      const tw = 0.4 + 0.6 * Math.abs(Math.sin(t * 0.0004 + d.ph));
      ctx.fillStyle = d.blue ? "rgba(120,155,200," + (0.10 * tw).toFixed(3) + ")"
                             : "rgba(105,120,145," + (0.13 * tw).toFixed(3) + ")";
      ctx.beginPath(); ctx.arc(d.x * W, d.y * H, d.s, 0, 7); ctx.fill();
    }
  }
  if (reduced) { draw(0); return; }
  (function loop(t) { draw(t); requestAnimationFrame(loop); })(0);
}

/* ================= Glint core : black lattice + starbursts on white ================= */
const CORE_STATES = {
  idle:      { drift: 1.0, glow: 0.80, twinkle: 1.6, spark: 22, pulse: 6,  label: "Idle" },
  listening: { drift: 1.7, glow: 1.00, twinkle: 2.6, spark: 30, pulse: 12, label: "Listening" },
  thinking:  { drift: 2.6, glow: 1.00, twinkle: 3.8, spark: 38, pulse: 8,  label: "Thinking" },
  speaking:  { drift: 1.4, glow: 0.95, twinkle: 2.2, spark: 26, pulse: 15, label: "Speaking" }
};
let coreCtx = null, coreW = 0, coreH = 0;
// Crystalline lattice: jittered grid points + precomputed triangle edges.
let meshPts = [], meshEdges = [], sparkles = [], dust = [];
function buildMesh() {
  meshPts = []; meshEdges = []; sparkles = []; dust = [];
  const cell = 36;
  const cols = Math.max(4, Math.ceil(coreW / cell));
  const rows = Math.max(3, Math.ceil(coreH / cell));
  const ox = (coreW - (cols - 1) * cell) / 2, oy = (coreH - (rows - 1) * cell) / 2;
  const idx = (c, r) => r * cols + c;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    meshPts.push({
      bx: ox + c * cell + (Math.random() - 0.5) * cell * 0.95,
      by: oy + r * cell + (Math.random() - 0.5) * cell * 0.95,
      phx: Math.random() * 6.283, phy: Math.random() * 6.283,
      ax: 3 + Math.random() * 5, ay: 3 + Math.random() * 5
    });
  }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (c < cols - 1) meshEdges.push([idx(c, r), idx(c + 1, r)]);
    if (r < rows - 1) meshEdges.push([idx(c, r), idx(c, r + 1)]);
    if (c < cols - 1 && r < rows - 1) {
      if ((c + r) % 2) meshEdges.push([idx(c, r), idx(c + 1, r + 1)]);
      else meshEdges.push([idx(c + 1, r), idx(c, r + 1)]);
    }
  }
  // Sparkle nodes: spread out with minimum spacing.
  const want = Math.round(meshPts.length * 0.30);
  const cand = meshPts.map((_, i) => i);
  for (let i = cand.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const tmp = cand[i]; cand[i] = cand[j]; cand[j] = tmp; }
  const taken = [];
  for (const i of cand) {
    if (taken.length >= want) break;
    const q = meshPts[i];
    let ok = true;
    for (const sp of taken) {
      const dx = meshPts[sp.i].bx - q.bx, dy = meshPts[sp.i].by - q.by;
      if (dx * dx + dy * dy < cell * cell * 2.2) { ok = false; break; }
    }
    if (ok) taken.push({ i, ph: Math.random() * 6.283, rate: 0.7 + Math.random() * 1.1, s: 0.9 + Math.random() * 1.0 });
  }
  sparkles = taken;
  for (let i = 0; i < 56; i++) {
    dust.push({ x: Math.random() * coreW, y: Math.random() * coreH,
      vx: (Math.random() - 0.5) * 7, vy: (Math.random() - 0.5) * 7,
      s: 0.5 + Math.random() * 1.1, ph: Math.random() * 6.283 });
  }
}
function sizeCore() {
  const cv = $("#core");
  const r = cv.parentElement.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  coreW = Math.max(1, r.width); coreH = Math.max(1, r.height);
  cv.width = coreW * dpr; cv.height = coreH * dpr;
  coreCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  buildMesh();
}
function setCoreState(s) {
  coreState = CORE_STATES[s] ? s : "idle";
  const el = $("#coreStateLabel");
  if (el) el.textContent = "MOJO";
}
// 4-pointed starburst glint: long thin rays with gradient falloff + bright core.
function drawGlintSpark(ctx, x, y, s, alpha) {
  const a = Math.min(1, Math.max(0, alpha)).toFixed(3);
  const rays = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 0.92], [0, -1, 0.92],
    [0.7071, 0.7071, 0.42], [-0.7071, 0.7071, 0.42],
    [0.7071, -0.7071, 0.42], [-0.7071, -0.7071, 0.42]
  ];
  ctx.save(); ctx.translate(x, y);
  for (const rd of rays) {
    const L = s * 14 * rd[2], dx = rd[0], dy = rd[1];
    const g = ctx.createLinearGradient(0, 0, dx * L, dy * L);
    g.addColorStop(0, "rgba(15,17,23," + a + ")");
    g.addColorStop(1, "rgba(15,17,23,0)");
    ctx.strokeStyle = g; ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(dx * -L * 0.22, dy * -L * 0.22); ctx.lineTo(dx * L, dy * L); ctx.stroke();
  }
  const cg = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 2.6);
  cg.addColorStop(0, "rgba(10,12,18," + Math.min(1, alpha * 1.5).toFixed(3) + ")");
  cg.addColorStop(1, "rgba(10,12,18,0)");
  ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(0, 0, s * 2.6, 0, 7); ctx.fill();
  ctx.restore();
}
function drawCore(t) {
  const ctx = coreCtx, p = CORE_STATES[coreState] || CORE_STATES.idle;
  const al = (v) => Math.min(1, Math.max(0, v)).toFixed(3);
  const cx = coreW / 2, cy = coreH / 2;
  const R = Math.min(coreW, coreH);
  const glow = p.glow, fadeR = R * 0.54;
  ctx.clearRect(0, 0, coreW, coreH);

  // 1. Barely-there gray halo for depth.
  const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.72);
  halo.addColorStop(0, "rgba(20,24,32," + al(0.055 * glow) + ")");
  halo.addColorStop(1, "rgba(20,24,32,0)");
  ctx.fillStyle = halo; ctx.fillRect(0, 0, coreW, coreH);

  // 2. Drifting micro dust.
  for (const d of dust) {
    const x = (((d.x + t * d.vx * p.drift) % coreW) + coreW) % coreW;
    const y = (((d.y + t * d.vy * p.drift) % coreH) + coreH) % coreH;
    const tw = 0.25 + 0.75 * Math.abs(Math.sin(t * 0.9 + d.ph));
    ctx.fillStyle = "rgba(25,30,40," + al(0.20 * tw * glow) + ")";
    ctx.beginPath(); ctx.arc(x, y, d.s, 0, 7); ctx.fill();
  }

  // 3. Crystalline lattice: drifting points joined into triangles.
  const n = meshPts.length;
  const px = new Float32Array(n), py = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const m = meshPts[i];
    px[i] = m.bx + Math.sin(t * 0.50 * p.drift + m.phx) * m.ax;
    py[i] = m.by + Math.cos(t * 0.42 * p.drift + m.phy) * m.ay;
  }
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = "rgba(10,12,18," + al(0.55 + 0.45 * glow) + ")";
  ctx.beginPath();
  for (const e of meshEdges) { ctx.moveTo(px[e[0]], py[e[0]]); ctx.lineTo(px[e[1]], py[e[1]]); }
  ctx.stroke();

  // 4. Fade the lattice into the white background at the edges.
  const fade = ctx.createRadialGradient(cx, cy, R * 0.30, cx, cy, R * 0.68);
  fade.addColorStop(0, "rgba(255,255,255,0)");
  fade.addColorStop(1, "rgba(255,255,255,1)");
  ctx.fillStyle = fade; ctx.fillRect(0, 0, coreW, coreH);

  // 5. Twinkling starburst glints on lattice nodes (staggered phases).
  const limit = Math.min(sparkles.length, p.spark);
  for (let k = 0; k < limit; k++) {
    const sp = sparkles[k];
    const x = px[sp.i], y = py[sp.i];
    const dx = x - cx, dy = y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const edge = 1 - Math.min(1, Math.max(0, (dist - fadeR * 0.45) / (fadeR * 0.60)));
    if (edge <= 0.01) continue;
    const tw = 0.5 + 0.5 * Math.sin(t * p.twinkle * sp.rate + sp.ph);
    const a = Math.pow(tw, 1.6) * glow * edge;
    if (a < 0.02) continue;
    drawGlintSpark(ctx, x, y, sp.s * (0.7 + 0.5 * tw), a);
  }

  // 6. Speaking ripple rings.
  if (coreState === "speaking") {
    for (let i = 0; i < 2; i++) {
      const ph = (t * 0.9 + i * 0.5) % 1;
      ctx.strokeStyle = "rgba(20,24,32," + al((1 - ph) * 0.45 * glow) + ")";
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(cx, cy, fadeR * 0.4 + ph * (R * 0.30 + p.pulse), 0, 7); ctx.stroke();
    }
  }
}
function initCore() {
  coreCtx = $("#core").getContext("2d");
  sizeCore();
  new ResizeObserver(sizeCore).observe($("#coreStage"));
  addEventListener("resize", sizeCore);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  setCoreState("idle");
  if (reduced) { drawCore(0.6); return; }
  let t = 0, last = performance.now();
  (function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now; t += dt;
    drawCore(t);
    requestAnimationFrame(frame);
  })(last);
}

/* ================= Toast ================= */
let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg; el.hidden = false;
  requestAnimationFrame(() => el.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove("show"); setTimeout(() => { el.hidden = true; }, 300); }, 4200);
}

/* ================= Health / status ================= */
async function refreshHealth() {
  const notice = $("#coldNotice");
  let slowFired = false;
  const slow = setTimeout(() => { slowFired = true; notice.hidden = false; }, 4000);
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 95000);
    const res = await fetch("/api/health", { signal: ctrl.signal, headers: brainKeyHeaders() });
    clearTimeout(to);
    health = await res.json();
  } catch (e) {
    health = { ok: false, offline: true };
  } finally {
    clearTimeout(slow);
    notice.hidden = true;
    renderStatus();
    // Silent warmup: keeps the chat function hot so the first message feels instant.
    if (health && health.keyConfigured) {
      fetch("/api/chat", {
        method: "POST",
        headers: brainKeyHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ warmup: true })
      }).catch(() => {});
    }
  }
}
function renderStatus() {
  const pill = $("#statusPill"), dot = $("#statusDot"), txt = $("#statusText");
  const banner = $("#keyBanner");
  pill.classList.remove("ok", "warn", "bad", "checking");
  if (!health || health.offline) {
    pill.classList.add("bad"); txt.textContent = "Server unreachable";
    banner.hidden = true;
  } else if (health.keyConfigured) {
    pill.classList.add("ok"); txt.textContent = "Brain online";
    banner.hidden = true;
  } else {
    pill.classList.add("warn"); txt.textContent = "Brain not connected";
    banner.hidden = false;
  }
  $("#setServer").textContent = (!health || health.offline) ? "Unreachable" : "Online";
  $("#setServer").className = "set-val " + ((!health || health.offline) ? "bad" : "good");
  $("#setModel").textContent = (health && health.model) || "—";
  const brain = $("#setBrain");
  const personal = !!getBrainKey();
  if (!health || health.offline) { brain.textContent = "Unknown"; brain.className = "set-val"; }
  else if (health.keyConfigured) { brain.textContent = personal ? "Connected (your key)" : "Connected"; brain.className = "set-val good"; }
  else { brain.textContent = "Not connected"; brain.className = "set-val bad"; }
}

/* ================= Personal brain key ================= */
function setBrainKeyNote(t) {
  const n = $("#brainKeyNote");
  if (n) n.textContent = t;
}
function syncBrainKeyUI() {
  const input = $("#brainKeyInput");
  if (!input) return;
  const has = !!getBrainKey();
  input.value = "";
  input.placeholder = has ? "•••••••• — a key is saved on this device" : "sk-or-… (OpenRouter key)";
  setBrainKeyNote(has
    ? "A personal key is saved on this device — Mojo's brain uses it here."
    : "Saved only in this phone or PC's browser. When set, your key is used for Mojo's brain on this device.");
}
async function saveBrainKey() {
  const input = $("#brainKeyInput");
  const key = ((input && input.value) || "").trim();
  if (!key) { setBrainKeyNote("Paste your OpenRouter API key first."); return; }
  setBrainKeyNote("Testing your key with the brain…");
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Brain-Key": key },
      body: JSON.stringify({ message: "Reply with exactly: key ok", history: [] })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setBrainKeyNote("Key test failed (" + (data.detail || data.error || ("HTTP " + res.status)) + ") — not saved. Check the key and try again.");
      return;
    }
    try { if (res.body && res.body.cancel) await res.body.cancel(); } catch (e) {}
    try { localStorage.setItem(LS_BRAIN_KEY, key); }
    catch (e) { setBrainKeyNote("Could not save in this browser's storage."); return; }
    syncBrainKeyUI();
    toast("Personal brain key saved on this device.");
    refreshHealth();
  } catch (e) {
    setBrainKeyNote("Could not reach the server. Key not saved.");
  }
}
function removeBrainKey() {
  try { localStorage.removeItem(LS_BRAIN_KEY); } catch (e) {}
  syncBrainKeyUI();
  toast("Personal key removed. Using the server key.");
  refreshHealth();
}

/* ================= Sidebar ================= */
function renderSidebar(filter) {
  const list = $("#convList");
  list.innerHTML = "";
  const q = (filter || "").trim().toLowerCase();
  const items = conversations.filter(c => {
    if (!q) return true;
    return c.title.toLowerCase().includes(q) ||
      c.messages.some(m => (m.text || "").toLowerCase().includes(q));
  });
  if (!items.length) {
    const d = document.createElement("div");
    d.className = "conv-empty";
    d.textContent = q ? "No conversations match your search." : "No conversations yet.\nStart a new chat below.";
    list.appendChild(d);
    return;
  }
  for (const c of items) {
    const item = document.createElement("div");
    item.className = "conv-item" + (c.id === activeId ? " active" : "");
    const title = document.createElement("div");
    title.className = "conv-title"; title.textContent = c.title; title.title = c.title;
    const date = document.createElement("div");
    date.className = "conv-date"; date.textContent = fmtDate(c.updatedAt);
    const acts = document.createElement("div");
    acts.className = "conv-act";
    const rn = document.createElement("button");
    rn.className = "mini-btn"; rn.type = "button"; rn.title = "Rename"; rn.setAttribute("aria-label", "Rename conversation");
    rn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>';
    rn.addEventListener("click", e => { e.stopPropagation(); renameConversation(c.id, title); });
    const del = document.createElement("button");
    del.className = "mini-btn danger"; del.type = "button"; del.title = "Delete"; del.setAttribute("aria-label", "Delete conversation");
    del.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';
    del.addEventListener("click", e => { e.stopPropagation(); deleteConversation(c.id); });
    acts.appendChild(rn); acts.appendChild(del);
    item.appendChild(title); item.appendChild(date); item.appendChild(acts);
    item.addEventListener("click", () => openConversation(c.id));
    list.appendChild(item);
  }
}
function openConversation(id) {
  abortInflight();
  activeId = id;
  renderSidebar($("#searchInput").value);
  renderMessages();
  closeMobileSidebar();
}
function renameConversation(id, titleEl) {
  const c = conversations.find(x => x.id === id);
  if (!c) return;
  const input = document.createElement("input");
  input.value = c.title; input.setAttribute("aria-label", "Conversation name");
  titleEl.innerHTML = ""; titleEl.appendChild(input);
  input.focus(); input.select();
  const commit = () => {
    const v = input.value.trim();
    if (v) c.title = v;
    saveConvs(); renderSidebar($("#searchInput").value);
  };
  input.addEventListener("keydown", e => { if (e.key === "Enter") commit(); if (e.key === "Escape") renderSidebar($("#searchInput").value); e.stopPropagation(); });
  input.addEventListener("blur", commit);
  input.addEventListener("click", e => e.stopPropagation());
}
function deleteConversation(id) {
  if (!confirm("Delete this conversation?")) return;
  conversations = conversations.filter(c => c.id !== id);
  if (activeId === id) activeId = null;
  saveConvs();
  renderSidebar($("#searchInput").value);
  renderMessages();
}
function startNewChat() {
  abortInflight();
  activeId = null;
  renderSidebar($("#searchInput").value);
  renderMessages();
  $("#input").focus();
  closeMobileSidebar();
}

/* ================= Messages ================= */
function nearBottom() {
  const sc = $("#chatScroll");
  return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 140;
}
/* force !== false: always jump (new message). force === false: only autoscroll
   when the user is already near the bottom, so reading history is never yanked. */
function scrollBottom(force) {
  if (force === false && !nearBottom()) return;
  const sc = $("#chatScroll");
  sc.scrollTop = sc.scrollHeight;
}
function renderMessages() {
  const wrap = $("#messages");
  const empty = $("#emptyState");
  const stage = $("#coreStage");
  wrap.innerHTML = "";
  const c = getActive();
  const has = c && c.messages.length > 0;
  empty.style.display = has ? "none" : "";
  stage.classList.toggle("docked", !!has);
  requestAnimationFrame(sizeCore);
  if (!has) return;
  for (let i = 0; i < c.messages.length; i++) {
    const m = c.messages[i];
    if (m.role === "error") appendErrorBubble(m.text, false);
    else if (m.kind === "genimg" && m.imgId && sessionImages.has(m.imgId)) {
      const e = sessionImages.get(m.imgId);
      appendGeneratedImage(m.imgId, e.url, e.type, false);
    }
    else appendMessageBubble(m.role, m.text, m.img, false, i);
  }
  scrollBottom();
}
function avatarFor(role) {
  return role === "user" ? "YOU" : "M";
}
function appendMessageBubble(role, text, img, animate, msgIndex) {
  const wrap = $("#messages");
  const div = document.createElement("div");
  div.className = "msg " + role;
  const av = document.createElement("div");
  av.className = "avatar"; av.textContent = avatarFor(role);
  const bub = document.createElement("div");
  bub.className = "bubble";
  if (img) {
    const im = document.createElement("img");
    im.className = "msg-img"; im.src = img; im.alt = "Uploaded image";
    bub.appendChild(im);
  }
  const body = document.createElement("div");
  bub.appendChild(body);
  div.appendChild(av); div.appendChild(bub);
  wrap.appendChild(div);
  if (animate && role === "assistant") {
    typewriter(body, text || "", () => { scrollBottom(); });
  } else {
    body.innerHTML = renderMarkdown(text || "");
  }
  // Premium message actions: Copy on every text bubble, Edit on your own.
  if (msgIndex != null) attachMessageActions(div, msgIndex, role, text);
  scrollBottom();
  return body;
}
/* ChatGPT-style message actions: icon-only. Assistant gets a small icon row
   under the reply (always visible); your bubble reveals icons floating to
   its left on hover (desktop) or tap (touch). */
const ICON_COPY = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 5.5v-2a1.6 1.6 0 0 0-1.6-1.6H3.6a1.6 1.6 0 0 0-1.6 1.6v5.3a1.6 1.6 0 0 0 1.6 1.6h2"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11.8 2.2a1.4 1.4 0 0 1 2 2L5.3 12.7 2 13.9l1.2-3.3z"/></svg>';
function attachMessageActions(msgDiv, idx, role, text) {
  if (idx == null || !text || !msgDiv) return;
  if (msgDiv.querySelector(".msg-actions")) return;
  const mk = (icon, label, fn) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "msg-act"; b.innerHTML = icon;
    b.setAttribute("aria-label", label); b.title = label;
    b.addEventListener("click", (ev) => { ev.stopPropagation(); fn(); });
    return b;
  };
  if (role === "assistant") {
    const bub = msgDiv.querySelector(".bubble");
    if (!bub) return;
    const row = document.createElement("div");
    row.className = "msg-actions";
    row.appendChild(mk(ICON_COPY, "Copy", () => copyText(text)));
    bub.appendChild(row);
  } else {
    const row = document.createElement("div");
    row.className = "msg-actions side";
    row.appendChild(mk(ICON_COPY, "Copy", () => copyText(text)));
    row.appendChild(mk(ICON_EDIT, "Edit", () => editUserMessage(idx)));
    msgDiv.appendChild(row);
    const bub = msgDiv.querySelector(".bubble");
    const place = () => {
      if (!bub) return;
      const r = bub.getBoundingClientRect(), m = msgDiv.getBoundingClientRect();
      row.style.top = (r.top - m.top + r.height / 2) + "px";
      row.style.right = (m.right - r.left + 10) + "px";
    };
    const show = () => { place(); msgDiv.classList.add("show-actions"); };
    const hide = () => msgDiv.classList.remove("show-actions");
    if (window.matchMedia && matchMedia("(hover: hover)").matches) {
      msgDiv.addEventListener("mouseenter", show);
      msgDiv.addEventListener("mouseleave", hide);
    } else if (bub) {
      bub.addEventListener("click", () => msgDiv.classList.contains("show-actions") ? hide() : show());
    }
  }
}
function copyText(t) {
  const done = () => toast("Copied, sir.");
  const fallback = () => {
    try {
      const ta = document.createElement("textarea");
      ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); ta.remove(); done();
    } catch (e) { toast("Couldn't copy that."); }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(done, fallback);
  } else fallback();
}
/* Edit your message: drop it and everything after, put the text back in the
   box for editing — the reply regenerates when you send again. */
function editUserMessage(idx) {
  const c = getActive();
  if (!c || !c.messages[idx] || c.messages[idx].role !== "user") return;
  if (sending || generatingImage) { toast("Wait for the reply to finish first."); return; }
  const m = c.messages[idx];
  c.messages = c.messages.slice(0, idx);
  c.updatedAt = Date.now(); saveConvs();
  renderMessages();
  renderSidebar($("#searchInput").value);
  $("#input").value = m.text || "";
  autoresize();
  $("#input").focus();
}
function appendErrorBubble(text, save) {
  const wrap = $("#messages");
  const div = document.createElement("div");
  div.className = "msg error";
  const bub = document.createElement("div");
  bub.className = "bubble"; bub.textContent = text;
  div.appendChild(bub); wrap.appendChild(div);
  scrollBottom();
}
function appendThinking() {
  const wrap = $("#messages");
  const div = document.createElement("div");
  div.className = "msg assistant"; div.id = "thinkingRow";
  const av = document.createElement("div");
  av.className = "avatar thinking-av"; av.textContent = "M";
  const pill = document.createElement("div");
  pill.className = "thinking-pill";
  pill.innerHTML = '<span class="thinking-text">Thinking</span><span class="thinking-ellipsis"><span>.</span><span>.</span><span>.</span></span>';
  div.appendChild(av); div.appendChild(pill);
  wrap.appendChild(div); scrollBottom();
}
function removeThinking() {
  const t = $("#thinkingRow");
  if (t) t.remove();
}
function typewriter(el, full, done) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || !full) { el.innerHTML = renderMarkdown(full); if (done) done(); return; }
  let i = 0;
  const step = Math.max(2, Math.round(full.length / 220));
  (function tick() {
    i += step;
    const partial = full.slice(0, i);
    el.innerHTML = renderMarkdown(partial);
    scrollBottom();
    if (i < full.length) requestAnimationFrame(tick);
    else { el.innerHTML = renderMarkdown(full); if (done) done(); }
  })();
}

/* ================= Chat send ================= */
function historyPayload(c) {
  return c.messages
    .filter(m => m.role === "user" || m.role === "assistant")
    .slice(-20)
    .map(m => ({ role: m.role, text: m.text || "" }));
}
/* Streams an SSE chat response into a live bubble.
   Returns { text, bodyEl }. Rendering is throttled so long replies stay smooth,
   and autoscroll never yanks the user away from history they are reading. */
async function streamAssistantReply(res, onChunk) {
  const sc = $("#chatScroll");
  sc.classList.add("streaming");
  sc.setAttribute("aria-busy", "true");
  // The bubble is created lazily on the first token, so the "Thinking"
  // indicator stays visible until real text arrives — no blank gap.
  let bodyEl = null;
  const ensureBubble = () => {
    if (bodyEl) return bodyEl;
    removeThinking();
    bodyEl = appendMessageBubble("assistant", "", null, false);
    return bodyEl;
  };
  let acc = "";
  let lastRender = 0;
  try {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.slice(0, 5) !== "data:") continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let delta = "";
        try {
          const j = JSON.parse(data);
          if (j && j.error) continue; // provider-side error chunk; ignore it
          delta = (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || "";
        } catch (e) { continue; }
        if (delta) {
          acc += delta;
          if (onChunk) { try { onChunk(acc); } catch (e) {} }
          const now = performance.now();
          if (now - lastRender > 120) {
            lastRender = now;
            ensureBubble().innerHTML = renderMarkdown(acc);
            scrollBottom(false);
          }
        }
      }
    }
    try { reader.releaseLock(); } catch (e) {}
  } catch (e) {
    // stream interrupted (user stopped, timed out, connection dropped); keep what arrived
  }
  bodyEl = ensureBubble();
  bodyEl.innerHTML = renderMarkdown(acc);
  scrollBottom(false);
  sc.classList.remove("streaming");
  sc.removeAttribute("aria-busy");
  return { text: acc, bodyEl };
}
/* In-flight request control: the send button becomes a stop button while streaming. */
let sendAbort = null;
let stopReason = null; // null | "stopped" | "timeout"
const CHAT_TIMEOUT_MS = 75000;

function stopCurrentSend() {
  stopReason = "stopped";
  stopSpeak();
  if (sendAbort) { try { sendAbort.abort(); } catch (e) {} }
}
function abortInflight() {
  if (sending) stopCurrentSend();
}
async function sendMessage(text) {
  text = (text || "").trim();
  if (sending) return;
  if (!text && !attachedImage) return;
  stopSpeak();
  let c = getActive();
  if (!c) { c = createConversation(); }
  const img = attachedImage;
  const userText = text;
  c.messages.push({ role: "user", text: userText, img: img || null, ts: Date.now() });
  if (c.messages.filter(m => m.role === "user").length === 1) c.title = makeTitle(userText || "Image");
  c.updatedAt = Date.now(); saveConvs();
  attachedImage = null; updateImgPreview();
  $("#input").value = ""; autoresize();
  renderSidebar($("#searchInput").value);
  renderMessages();
  sending = true;
  const sendBtn = $("#sendBtn");
  sendBtn.classList.add("stop");
  sendBtn.setAttribute("aria-label", "Stop generating");
  setCoreState("thinking");
  appendThinking();
  const payload = { message: userText, history: historyPayload(c), notes: getNotes() };
  if (img) payload.image = img;
  sendAbort = new AbortController();
  stopReason = null;
  const chatTimer = setTimeout(() => {
    stopReason = "timeout";
    try { sendAbort.abort(); } catch (e) {}
  }, CHAT_TIMEOUT_MS);
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: brainKeyHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
      signal: sendAbort.signal
    });
    const ct = res.headers.get("content-type") || "";
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      removeThinking();
      handleChatError(data.error, data.detail, res.status);
    } else if (ct.includes("text/event-stream") && res.body) {
      speakStreamStart(); // streaming TTS: first sentence speaks the moment it arrives
      const { text: streamed, bodyEl } = await streamAssistantReply(res, speakStreamChunk);
      const row = bodyEl.closest(".msg");
      if (stopReason === "stopped" && !streamed) {
        if (row) row.remove(); // stopped before anything arrived: leave no trace
        stopSpeak();
      } else if ((stopReason === "timeout" || res.status === 504) && !streamed) {
        if (row) row.remove();
        stopSpeak();
        handleChatError("AI_TIMEOUT", "", res.status);
      } else {
        const reply = streamed || "I didn't get a response. Please try again.";
        bodyEl.innerHTML = renderMarkdown(reply);
        scrollBottom(false);
        c.messages.push({ role: "assistant", text: reply, ts: Date.now() });
        attachMessageActions(row, c.messages.length - 1, "assistant", reply);
        c.updatedAt = Date.now(); saveConvs();
        renderSidebar($("#searchInput").value);
        speakStreamEnd(); // speak any trailing sentence fragment
      }
    } else {
      const data = await res.json().catch(() => ({}));
      removeThinking();
      if (data.error) {
        handleChatError(data.error, data.detail, res.status);
      } else {
        const reply = data.reply || "I didn't get a response. Please try again.";
        c.messages.push({ role: "assistant", text: reply, ts: Date.now() });
        c.updatedAt = Date.now(); saveConvs();
        appendMessageBubble("assistant", reply, null, true, c.messages.length - 1);
        speak(reply);
      }
    }
  } catch (e) {
    removeThinking();
    if (stopReason === "timeout") handleChatError("AI_TIMEOUT", "", 0);
    else if (!(e && e.name === "AbortError")) handleChatError("NETWORK", "", 0);
    /* user-pressed stop: stay silent, keep whatever already streamed */
  } finally {
    clearTimeout(chatTimer);
    sendAbort = null; stopReason = null;
    sending = false;
    sendBtn.classList.remove("stop");
    sendBtn.setAttribute("aria-label", "Send message");
    if (!listening) setCoreState("idle");
  }
}
function handleChatError(code, detail, status) {
  let msg;
  if (code === "AI_CONNECTION_NOT_CONFIGURED") {
    msg = "The AI brain is not connected. Add your API key in Settings → Connection → Personal brain key, or set AI_API_KEY on the server (Vercel dashboard → Project → Settings → Environment Variables), then refresh this page.";
    $("#keyBanner").hidden = false;
  } else if (code === "RATE_LIMITED") {
    msg = "Rate limited — too many requests. Please wait a moment and try again.";
  } else if (code === "AI_TIMEOUT" || status === 504) {
    msg = "The AI took too long to respond. Please try again.";
  } else if (code === "IMAGE_TOO_LARGE") {
    msg = "That image is too large. Please use a smaller image and try again.";
  } else if (code === "AI_CONNECTION_ERROR") {
    msg = "The AI provider returned an error" + (detail ? ": " + detail : ".");
    if (!/please try again\.?\s*$/i.test(String(detail || "").trim())) msg += " Please try again.";
  } else if (code === "NETWORK" || status === 0) {
    msg = "Couldn't reach the server. Check your connection and try again.";
  } else if (code === "empty_message") {
    msg = "Please type a message or attach an image first.";
  } else {
    msg = "Something went wrong" + (detail ? ": " + detail : ".");
    if (!/please try again\.?\s*$/i.test(String(detail || "").trim())) msg += " Please try again.";
  }
  const c = getActive();
  if (c) { c.messages.push({ role: "error", text: msg, ts: Date.now() }); saveConvs(); }
  appendErrorBubble(msg);
  setCoreState("idle");
}

/* ================= Voice input ================= */
function toggleListening() {
  if (!settings.voiceInput) { toast("Voice input is turned off in Settings."); return; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast("Voice input isn't supported in this browser. Try Chrome or Edge."); return; }
  if (listening) { try { recognition.stop(); } catch (e) {} return; }
  try {
    recognition = new SR();
    recognition.lang = settings.voiceLang || navigator.language || "en-US";
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onresult = e => {
      let t = "";
      for (const r of e.results) t += r[0].transcript;
      $("#input").value = t; autoresize();
    };
    recognition.onerror = e => {
      listening = false; $("#micBtn").classList.remove("live");
      if (!sending) setCoreState("idle");
      if (e.error === "not-allowed" || e.error === "service-not-allowed") toast("Microphone access was denied. Allow it in your browser settings.");
      else if (e.error !== "aborted" && e.error !== "no-speech") toast("Voice input had trouble starting. Please try again.");
    };
    recognition.onend = () => {
      listening = false; $("#micBtn").classList.remove("live");
      if (!sending) setCoreState("idle");
    };
    recognition.start();
    listening = true;
    $("#micBtn").classList.add("live");
    setCoreState("listening");
  } catch (e) {
    toast("Voice input couldn't start on this device.");
  }
}

/* ================= Text-to-speech ================= */
function loadVoices() {
  try { voices = speechSynthesis.getVoices() || []; } catch (e) { voices = []; }
}
/* Pick a voice for the user's chosen voice language (Urdu / Hindi / English),
   preferring a male-sounding system voice when one exists. */
function ttsVoiceFor() {
  const want = String(settings.voiceLang || "en").slice(0, 2).toLowerCase();
  const maleHints = /male|\b(david|daniel|james|mark|alex|fred|george|arthur|thomas|oliver|liam|noah|ryan|brian|christopher)\b/i;
  const inLang = voices.filter(v => String(v.lang || "").toLowerCase().startsWith(want));
  const enMale = voices.find(v => maleHints.test(v.name || "") && /^en/i.test(String(v.lang || "")));
  const enAny = voices.find(v => /^en/i.test(String(v.lang || "")));
  return inLang.find(v => maleHints.test(v.name || "")) || inLang[0] || enMale || enAny || voices[0] || null;
}
function ttsEnqueue(text) {
  if (!settings.tts || !("speechSynthesis" in window)) return;
  const clean = String(text || "").replace(/`+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
  if (clean.length < 2) return;
  try {
    const u = new SpeechSynthesisUtterance(clean);
    const v = ttsVoiceFor();
    if (v) { u.voice = v; u.lang = v.lang; }
    u.pitch = 0.85; u.rate = 1.0;
    u.onstart = () => setCoreState("speaking");
    u.onend = u.onerror = () => { if (!sending && !listening) setCoreState("idle"); };
    speechSynthesis.speak(u);
  } catch (e) { /* TTS unavailable */ }
}
/* Full-reply fallback for the non-streaming path. */
function speak(text) {
  if (!settings.tts) return;
  if (!("speechSynthesis" in window)) return;
  try {
    speechSynthesis.cancel();
    ttsSpokenUpTo = 0; ttsStreamText = "";
    const clean = String(text || "").replace(/```[\s\S]*?```/g, " (code block omitted) ").slice(0, 1500);
    if (clean.trim()) ttsEnqueue(clean);
  } catch (e) { /* TTS unavailable */ }
}
function stopSpeak() {
  ttsSpokenUpTo = 0; ttsStreamText = "";
  try { if ("speechSynthesis" in window) speechSynthesis.cancel(); } catch (e) {}
}
/* ---- Streaming TTS: speak each finished sentence the moment it arrives,
   so voice replies start instantly instead of waiting for the full answer.
   Understands English and Urdu/Hindi sentence endings (. ! ? and ۔).
   Every sentence is enqueued exactly once, in order — repeats are impossible
   because we remember how far into the stream we have already spoken. ---- */
let ttsSpokenUpTo = 0;
let ttsStreamText = "";
/* Words that end with a dot but never end a sentence (so "Mr. Smith" and
   "3.5" are spoken as one unbroken line, not chopped in two). */
const TTS_ABBR = /^(mr|mrs|ms|dr|st|sr|jr|prof|vs|etc|eg|ie)$/i;
/* Pull complete sentences off the front of freshly streamed text.
   Returns the sentences plus how many chars of the input were consumed. */
function splitSpokenSentences(text) {
  const sentences = [];
  let start = 0, i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "." || ch === "!" || ch === "?" || ch === "۔") {
      let j = i + 1;
      while (j < text.length && (text[j] === "." || text[j] === "!" || text[j] === "?" || text[j] === "۔")) j++;
      const before = text[i - 1] || "";
      const afterCh = text[j] || "";
      const isDecimal = /\d/.test(before) && /\d/.test(afterCh);
      let isAbbr = false;
      if (ch === "." && !isDecimal) {
        const m = text.slice(0, i).match(/([A-Za-z]{1,4})$/);
        if (m && TTS_ABBR.test(m[1])) isAbbr = true;
      }
      if (!isDecimal && !isAbbr && (afterCh === "" || /\s/.test(afterCh))) {
        const s = text.slice(start, j).trim();
        if (s) sentences.push(s);
        start = j;
        i = j;
        continue;
      }
    }
    i++;
  }
  return { sentences, consumed: start };
}
function speakStreamStart() { ttsSpokenUpTo = 0; ttsStreamText = ""; }
function speakStreamChunk(fullText) {
  if (!settings.tts || !("speechSynthesis" in window)) return;
  ttsStreamText = String(fullText || "");
  // Only examine the part of the stream we have not spoken yet.
  const fresh = ttsStreamText.slice(ttsSpokenUpTo);
  const { sentences, consumed } = splitSpokenSentences(fresh);
  for (const s of sentences) ttsEnqueue(s);
  ttsSpokenUpTo += consumed;
}
function speakStreamEnd() {
  const rest = ttsStreamText.slice(ttsSpokenUpTo).trim();
  ttsSpokenUpTo = ttsStreamText.length;
  if (rest.length > 1) ttsEnqueue(rest);
}

/* ================= Image attach ================= */
function handleFile(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) { toast("Please choose an image file."); return; }
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    const max = 1024;
    const s = Math.min(1, max / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * s));
    const h = Math.max(1, Math.round(img.height * s));
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    cv.getContext("2d").drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);
    let dataUrl = cv.toDataURL(file.type === "image/png" ? "image/png" : "image/jpeg", 0.85);
    if (dataUrl.length > 1400000) {
      // Still too heavy for the API: shrink once more as JPEG.
      const w2 = Math.max(1, Math.round(w * 0.7));
      const h2 = Math.max(1, Math.round(h * 0.7));
      const cv2 = document.createElement("canvas");
      cv2.width = w2; cv2.height = h2;
      cv2.getContext("2d").drawImage(cv, 0, 0, w2, h2);
      dataUrl = cv2.toDataURL("image/jpeg", 0.8);
    }
    attachedImage = dataUrl;
    updateImgPreview();
    $("#input").focus();
  };
  img.onerror = () => { URL.revokeObjectURL(url); toast("That image couldn't be read."); };
  img.src = url;
}
function updateImgPreview() {
  const box = $("#imgPreview");
  if (attachedImage) { $("#imgPrevImg").src = attachedImage; box.hidden = false; }
  else { box.hidden = true; $("#imgPrevImg").removeAttribute("src"); }
}

/* ================= Free image generation ================= */
const IMAGE_TIMEOUT_MS = 75000;
let generatingImage = false;
/* Generated images live as blob URLs for this page session only: the bytes are
   never written to localStorage (too big, and the URL dies with the page), so
   messages carry only a tiny imgId and this map resolves it while the session
   lasts. The Download button below each image uses the same blob URL. */
const sessionImages = new Map(); // imgId -> { url, type }
let imgSeq = 0;
async function generateImage() {
  const prompt = ($("#input").value || "").trim();
  if (generatingImage || sending) return;
  if (!prompt) { toast("Describe the image first, then tap the image button."); return; }
  stopSpeak();
  let c = getActive();
  if (!c) { c = createConversation(); }
  c.messages.push({ role: "user", text: prompt, ts: Date.now() });
  if (c.messages.filter(m => m.role === "user").length === 1) c.title = makeTitle(prompt);
  c.updatedAt = Date.now(); saveConvs();
  $("#input").value = ""; autoresize();
  renderSidebar($("#searchInput").value);
  renderMessages();
  generatingImage = true;
  setCoreState("thinking");
  appendImagePlaceholder();
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, IMAGE_TIMEOUT_MS);
  try {
    const res = await fetch("/api/image", {
      method: "POST",
      headers: brainKeyHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ prompt }),
      signal: ctrl.signal
    });
    const ct = res.headers.get("content-type") || "";
    if (!res.ok || !ct.startsWith("image/")) {
      // Keep the shimmer up until we know the outcome; the blob download
      // below can take a few seconds after headers arrive.
      removeImagePlaceholder();
      const data = await res.json().catch(() => ({}));
      handleImageError(data.error, data.detail, res.status);
    } else {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const imgId = "img-" + Date.now().toString(36) + "-" + (++imgSeq);
      const type = (blob.type || ct.split(";")[0] || "image/png").toLowerCase();
      sessionImages.set(imgId, { url, type });
      // Persist only the tiny imgId — never the blob URL (dies with the page)
      // and never the bytes (localStorage quota). After a reload the caption
      // remains but the picture is gone, same as before.
      removeImagePlaceholder();
      c.messages.push({ role: "assistant", kind: "genimg", imgId, text: "Here's your image, sir.", ts: Date.now() });
      c.updatedAt = Date.now(); saveConvs();
      appendGeneratedImage(imgId, url, type, true);
      renderSidebar($("#searchInput").value);
    }
  } catch (e) {
    removeImagePlaceholder();
    if (e && e.name === "AbortError") handleImageError("IMAGE_TIMEOUT", "", 0);
    else handleImageError("NETWORK", "", 0);
  } finally {
    clearTimeout(timer);
    generatingImage = false;
    if (!listening) setCoreState("idle");
  }
}
/* ChatGPT-style "painting" placeholder shown while the image generates. */
function appendImagePlaceholder() {
  const wrap = $("#messages");
  const div = document.createElement("div");
  div.className = "msg assistant"; div.id = "imgGenRow";
  const av = document.createElement("div");
  av.className = "avatar"; av.textContent = "M";
  const bub = document.createElement("div");
  bub.className = "bubble";
  const art = document.createElement("div");
  art.className = "imggen-art";
  art.setAttribute("aria-busy", "true");
  art.innerHTML = '<div class="imggen-shimmer"></div><div class="imggen-label">Generating your image, sir&hellip;</div>';
  bub.appendChild(art);
  div.appendChild(av); div.appendChild(bub);
  wrap.appendChild(div); scrollBottom();
}
function removeImagePlaceholder() {
  const t = $("#imgGenRow");
  if (t) t.remove();
}
function imgExtFor(type) {
  if (type === "image/png") return ".png";
  if (type === "image/webp") return ".webp";
  if (type === "image/gif") return ".gif";
  return ".jpg";
}
/* Generated image bubble: the picture only — tap it to open the viewer
   with Download / Delete. No download pill inside the chat itself. */
function appendGeneratedImage(imgId, url, type, animate) {
  const wrap = $("#messages");
  const div = document.createElement("div");
  div.className = "msg assistant";
  div.dataset.imgId = imgId;
  const av = document.createElement("div");
  av.className = "avatar"; av.textContent = "M";
  const bub = document.createElement("div");
  bub.className = "bubble";
  const im = document.createElement("img");
  im.className = "msg-img genimg-click"; im.src = url; im.alt = "Generated image";
  im.addEventListener("click", () => openImageViewer(imgId));
  bub.appendChild(im);
  const body = document.createElement("div");
  bub.appendChild(body);
  div.appendChild(av); div.appendChild(bub);
  wrap.appendChild(div);
  const caption = "Here's your image, sir — tap it to view full size.";
  if (animate) typewriter(body, caption, () => { scrollBottom(); });
  else body.innerHTML = renderMarkdown(caption);
  scrollBottom();
}
/* Full-screen image viewer: Download and Delete live here, not in chat. */
function openImageViewer(imgId) {
  const e = sessionImages.get(imgId);
  if (!e) return;
  closeImageViewer();
  const ov = document.createElement("div");
  ov.id = "imgViewer";
  ov.className = "img-viewer";
  const card = document.createElement("div");
  card.className = "img-viewer-card";
  const close = document.createElement("button");
  close.className = "img-viewer-close";
  close.setAttribute("aria-label", "Close");
  close.textContent = "×";
  const im = document.createElement("img");
  im.className = "img-viewer-img";
  im.src = e.url; im.alt = "Generated image";
  const actions = document.createElement("div");
  actions.className = "img-viewer-actions";
  const dl = document.createElement("a");
  dl.className = "img-viewer-btn";
  dl.href = e.url;
  dl.download = "mojo-image" + imgExtFor(e.type);
  dl.textContent = "Download";
  const del = document.createElement("button");
  del.className = "img-viewer-btn danger";
  del.textContent = "Delete";
  del.addEventListener("click", () => deleteGeneratedImage(imgId));
  actions.appendChild(dl); actions.appendChild(del);
  card.appendChild(close); card.appendChild(im); card.appendChild(actions);
  const back = document.createElement("div");
  back.className = "img-viewer-backdrop";
  ov.appendChild(back); ov.appendChild(card);
  document.body.appendChild(ov);
  document.body.style.overflow = "hidden";
  back.addEventListener("click", closeImageViewer);
  close.addEventListener("click", closeImageViewer);
}
function closeImageViewer() {
  const ov = document.getElementById("imgViewer");
  if (ov) ov.remove();
  document.body.style.overflow = "";
}
function deleteGeneratedImage(imgId) {
  const e = sessionImages.get(imgId);
  if (e) { try { URL.revokeObjectURL(e.url); } catch (_) {} sessionImages.delete(imgId); }
  const c = getActive();
  if (c) {
    c.messages = c.messages.filter(m => !(m.kind === "genimg" && m.imgId === imgId));
    c.updatedAt = Date.now(); saveConvs();
  }
  closeImageViewer();
  renderMessages();
  renderSidebar($("#searchInput").value);
}
function handleImageError(code, detail, status) {
  let msg;
  if (code === "RATE_LIMITED") {
    msg = "Too many image requests — please wait a moment and try again.";
  } else if (code === "EMPTY_PROMPT") {
    msg = "Describe the image first, then tap the image button.";
  } else if (code === "PROMPT_TOO_LONG") {
    msg = detail || "That description is too long. Please shorten it and try again.";
  } else if (code === "IMAGE_TIMEOUT" || status === 504) {
    msg = "Image generation took too long. Please try again.";
  } else if (code === "NETWORK" || status === 0) {
    msg = "Couldn't reach the image service. Check your connection and try again.";
  } else {
    msg = detail || "The image service is temporarily down. Please try again in a little while.";
  }
  const c = getActive();
  if (c) { c.messages.push({ role: "error", text: msg, ts: Date.now() }); saveConvs(); }
  appendErrorBubble(msg);
}
/* ================= Composer ================= */
function autoresize() {
  const ta = $("#input");
  ta.style.height = "auto";
  ta.style.height = Math.min(160, ta.scrollHeight) + "px";
}
function submitFromComposer() {
  if (sending) { stopCurrentSend(); return; } // send button doubles as stop while streaming
  sendMessage($("#input").value);
}

/* ================= Sidebar / drawer (mobile) ================= */
function closeMobileSidebar() {
  $("#sidebar").classList.remove("open");
  $("#scrim").classList.remove("open");
}
function openMobileSidebar() {
  $("#sidebar").classList.add("open");
  $("#scrim").classList.add("open");
}
function openDrawer() {
  $("#settingsDrawer").classList.add("open");
  $("#drawerScrim").classList.add("open");
}
function closeDrawer() {
  $("#settingsDrawer").classList.remove("open");
  $("#drawerScrim").classList.remove("open");
}

/* ================= Settings UI ================= */
function applySettingsUI() {
  $("#tglVoice").checked = !!settings.voiceInput;
  $("#tglTTS").checked = !!settings.tts;
  const sel = $("#selVoiceLang");
  if (sel) sel.value = settings.voiceLang || "ur-PK";
}

/* ================= Init ================= */
function init() {
  loadSettings();
  loadConvs();
  initAmbient();
  initCore();
  loadVoices();
  if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = loadVoices;

  applySettingsUI();
  renderSidebar("");
  renderMessages();
  refreshHealth();

  // Composer
  $("#sendBtn").addEventListener("click", submitFromComposer);
  // Scrolling the chat dismisses any open per-message action popups.
  $("#chatScroll").addEventListener("scroll", () => {
    document.querySelectorAll(".msg.show-actions").forEach(d => d.classList.remove("show-actions"));
  }, { passive: true });
  $("#input").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitFromComposer(); }
  });
  $("#input").addEventListener("input", autoresize);
  autoresize();

  // Image attach
  $("#attachBtn").addEventListener("click", () => $("#fileInput").click());
  $("#fileInput").addEventListener("change", e => { handleFile(e.target.files[0]); e.target.value = ""; });
  $("#imgRemove").addEventListener("click", () => { attachedImage = null; updateImgPreview(); });
  // Free image generation
  $("#imageBtn").addEventListener("click", generateImage);

  // Voice
  $("#micBtn").addEventListener("click", toggleListening);

  // Quick chips
  $$(".chip").forEach(ch => ch.addEventListener("click", () => {
    const ta = $("#input");
    const prefix = ch.getAttribute("data-prefix") || "";
    if (!ta.value.startsWith(prefix)) ta.value = prefix + ta.value;
    autoresize(); ta.focus();
  }));

  // Suggestion cards
  $$(".sugg").forEach(s => s.addEventListener("click", () => sendMessage(s.getAttribute("data-send") || "")));

  // Sidebar
  $("#newChatBtn").addEventListener("click", startNewChat);
  $("#searchInput").addEventListener("input", e => renderSidebar(e.target.value));
  $("#menuBtn").addEventListener("click", openMobileSidebar);
  $("#scrim").addEventListener("click", closeMobileSidebar);

  // Settings drawer
  $("#settingsBtn").addEventListener("click", () => { renderStatus(); syncBrainKeyUI(); openDrawer(); });
  $("#drawerClose").addEventListener("click", closeDrawer);
  $("#drawerScrim").addEventListener("click", closeDrawer);
  $("#refreshHealth").addEventListener("click", () => { refreshHealth(); toast("Checking server status…"); });
  $("#saveBrainKey").addEventListener("click", saveBrainKey);
  const notesInput = $("#notesInput");
  if (notesInput) notesInput.value = getNotes();
  $("#saveNotes").addEventListener("click", saveNotes);
  $("#removeBrainKey").addEventListener("click", removeBrainKey);
  $("#brainKeyInput").addEventListener("keydown", e => { if (e.key === "Enter") saveBrainKey(); });
  $("#tglVoice").addEventListener("change", e => { settings.voiceInput = e.target.checked; saveSettings(); });
  $("#tglTTS").addEventListener("change", e => {
    settings.tts = e.target.checked; saveSettings();
    if (!settings.tts) stopSpeak();
  });
  $("#selVoiceLang").addEventListener("change", e => {
    settings.voiceLang = e.target.value || "ur-PK"; saveSettings();
    stopSpeak();
    toast("Voice language set. It applies to the next voice input and reply.");
  });
  $("#clearAll").addEventListener("click", () => {
    if (!conversations.length) { toast("There are no conversations to delete."); return; }
    if (!confirm("Delete ALL conversations? This cannot be undone.")) return;
    conversations = []; activeId = null; saveConvs();
    renderSidebar($("#searchInput").value); renderMessages();
    toast("All conversations deleted.");
  });

  // Escape closes drawer / mobile sidebar
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") { closeDrawer(); closeMobileSidebar(); }
  });
}

document.addEventListener("DOMContentLoaded", init);
