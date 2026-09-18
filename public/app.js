/* Mojo — private AI command center frontend.
   Vanilla JS. Same-origin API: GET /api/health, POST /api/chat.
   No external network dependencies. */
"use strict";

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

const LS_CONV = "mojo.conversations.v1";
const LS_SETTINGS = "mojo.settings.v1";
const LS_BRAIN_KEY = "mojo.brain.key.v1"; // personal API key, stored only in this browser

/* Personal brain key: the user can paste their own OpenRouter API key in
   Settings → Connection. It never leaves the device except as the X-Brain-Key
   request header to our own backend, which uses it for the provider call
   instead of the server key. The key value is never written into the page. */
function getBrainKey() {
  try { return localStorage.getItem(LS_BRAIN_KEY) || ""; } catch (e) { return ""; }
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
      ctx.fillStyle = d.blue ? "rgba(147,217,255," + (0.10 * tw).toFixed(3) + ")"
                             : "rgba(255,150,60," + (0.13 * tw).toFixed(3) + ")";
      ctx.beginPath(); ctx.arc(d.x * W, d.y * H, d.s, 0, 7); ctx.fill();
    }
  }
  if (reduced) { draw(0); return; }
  (function loop(t) { draw(t); requestAnimationFrame(loop); })(0);
}

/* ================= Holographic core : dotted globe ================= */
const CORE_STATES = {
  idle:      { spin: 0.15, glow: 0.70, pulse: 6,  blueMix: 0.35, label: "Idle" },
  listening: { spin: 0.55, glow: 1.00, pulse: 12, blueMix: 0.85, label: "Listening" },
  thinking:  { spin: 1.15, glow: 1.00, pulse: 8,  blueMix: 0.55, label: "Thinking" },
  speaking:  { spin: 0.35, glow: 1.15, pulse: 15, blueMix: 0.40, label: "Speaking" }
};
// Rough continent boxes [lonMin, lonMax, latMin, latMax], rasterized into globe dots.
const LAND_BOXES = [
  [-168,-140,60,71],[-140,-95,49,70],[-95,-55,46,62],[-125,-100,30,49],[-100,-67,25,47],
  [-117,-87,16,32],[-92,-79,8,18],[-58,-20,60,84],
  [-77,-50,-5,10],[-50,-35,-25,5],[-72,-60,-40,-5],[-73,-65,-55,-40],
  [5,31,58,71],[-10,40,44,58],[-9,3,36,44],[-5,2,50,59],
  [-10,35,18,35],[-18,-8,8,20],[-5,42,-5,18],[12,36,-35,-5],[43,51,-26,-12],
  [40,180,52,75],[45,90,38,52],[35,60,15,38],[68,90,8,32],[90,122,22,45],
  [95,108,8,22],[124,130,34,40],[129,146,31,46],[95,125,-10,6],[120,123,8,18],
  [113,154,-39,-12],[166,179,-47,-34]
];
const globeDots = [];
(function buildGlobeDots() {
  const COLS = 72, ROWS = 36;
  const landAt = (lon, lat) => {
    for (const b of LAND_BOXES)
      if (lon >= b[0] && lon <= b[1] && lat >= b[2] && lat <= b[3]) return true;
    return false;
  };
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const lon = -180 + (c + 0.5) * (360 / COLS);
      const lat = 90 - (r + 0.5) * (180 / ROWS);
      const land = landAt(lon, lat);
      if (!land && Math.random() > 0.055) continue; // oceans: sparse dim dots
      globeDots.push({
        lon: lon + (Math.random() - 0.5) * 4.4,
        lat: Math.max(-88, Math.min(88, lat + (Math.random() - 0.5) * 4.4)),
        land: land,
        hub: land && Math.random() < 0.05, // bright "city light" hubs
        blue: Math.random() < 0.30,
        ph: Math.random() * 6.283,
        s: land ? 0.8 + Math.random() * 1.4 : 0.5 + Math.random() * 0.7
      });
    }
  }
})();
// Faint drifting binary-digit backdrop, rendered once to an offscreen strip.
let binStrip = null, binStripH = 220;
function buildBinStrip() {
  const w = Math.max(2, Math.floor(coreW)), h = binStripH;
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const c = cv.getContext("2d");
  c.font = "9px ui-monospace, Menlo, monospace";
  c.textBaseline = "top";
  const cols = Math.max(6, Math.floor(w / 26));
  for (let i = 0; i < cols; i++) {
    const x = (i + 0.5) * (w / cols) + (Math.random() - 0.5) * 8;
    const blue = Math.random() < 0.4;
    for (let y = 6; y < h; y += 13) {
      if (Math.random() < 0.28) continue;
      c.fillStyle = blue ? "rgba(120,180,230,0.10)" : "rgba(230,150,70,0.10)";
      c.fillText(Math.random() < 0.5 ? "0" : "1", x, y);
    }
  }
  binStrip = cv;
}
let coreCtx = null, coreW = 0, coreH = 0;
function sizeCore() {
  const cv = $("#core");
  const r = cv.parentElement.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  coreW = Math.max(1, r.width); coreH = Math.max(1, r.height);
  cv.width = coreW * dpr; cv.height = coreH * dpr;
  coreCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  buildBinStrip();
}
function setCoreState(s) {
  coreState = CORE_STATES[s] ? s : "idle";
  const el = $("#coreStateLabel");
  if (el) el.textContent = "MOJO";
}
function drawCore(t) {
  const ctx = coreCtx, p = CORE_STATES[coreState];
  const al = (v) => Math.min(1, Math.max(0, v)).toFixed(3); // clamp alpha
  const cx = coreW / 2, cy = coreH / 2;
  const R = Math.min(coreW, coreH);
  ctx.clearRect(0, 0, coreW, coreH);
  const sR = Math.max(24, R * 0.30); // globe radius
  const breathe = 0.92 + 0.08 * Math.sin(t * 1.15);
  const glow = p.glow * breathe;

  // 1. Drifting binary-digit backdrop
  if (binStrip) {
    const off = (t * 10) % binStripH;
    ctx.globalAlpha = 0.9;
    for (let y = -off; y < coreH; y += binStripH) ctx.drawImage(binStrip, 0, y);
    ctx.globalAlpha = 1;
  }

  // 2. Ambient aura
  let g = ctx.createRadialGradient(cx, cy, 0, cx, cy, sR * 3.1);
  g.addColorStop(0, "rgba(255,150,50," + al(0.34 * glow) + ")");
  g.addColorStop(0.4, "rgba(255,120,30," + al(0.16 * glow) + ")");
  g.addColorStop(0.7, "rgba(130,190,255," + al(0.14 * glow * (0.4 + p.blueMix)) + ")");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, coreW, coreH);
  // Hot inner halo — the "lit from within" premium glow.
  const g2 = ctx.createRadialGradient(cx, cy, 0, cx, cy, sR * 1.9);
  g2.addColorStop(0, "rgba(255,170,80," + al(0.20 * glow) + ")");
  g2.addColorStop(1, "rgba(255,150,60,0)");
  ctx.fillStyle = g2; ctx.fillRect(0, 0, coreW, coreH);

  // 3. Tilted orbit ring (back half first, front half after the globe)
  const ringR = sR * 1.22;
  const strokeRing = (a0, a1, style, width, blur) => {
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(-0.30); ctx.scale(1, 0.30);
    ctx.strokeStyle = style; ctx.lineWidth = width;
    ctx.shadowColor = style; ctx.shadowBlur = blur;
    ctx.beginPath(); ctx.arc(0, 0, ringR, a0, a1); ctx.stroke();
    ctx.restore();
  };
  strokeRing(Math.PI, Math.PI * 2, "rgba(147,217,255," + al(0.45 * glow) + ")", 1.6, 8);

  // Thin dashed orbit ring, slow counter-rotation.
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(0.5); ctx.scale(1, 0.55);
  ctx.strokeStyle = "rgba(255,170,90," + al(0.30 * glow) + ")";
  ctx.lineWidth = 1; ctx.setLineDash([3, 7]); ctx.lineDashOffset = -t * 14;
  ctx.beginPath(); ctx.arc(0, 0, sR * 1.38, 0, 7); ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  // Orbiting satellites (back half dimmed behind the globe; front half drawn later).
  const satAngle = (k) => t * p.spin * (0.35 + k * 0.12) * 4 + k * 2.1;
  const satPos = (sa) => {
    const rx = Math.cos(sa) * ringR, ry = Math.sin(sa) * ringR;
    const ca = Math.cos(-0.30), sn = Math.sin(-0.30);
    const sx = rx, sy = ry * 0.30;
    return [cx + sx * ca - sy * sn, cy + sx * sn + sy * ca];
  };
  const drawSat = (sa, front) => {
    const [x, y] = satPos(sa);
    ctx.fillStyle = "rgba(190,228,255," + al((front ? 0.95 : 0.28) * glow) + ")";
    ctx.shadowColor = "rgba(140,200,255,0.9)"; ctx.shadowBlur = front ? 9 : 0;
    ctx.beginPath(); ctx.arc(x, y, front ? 2.4 : 1.6, 0, 7); ctx.fill();
    ctx.shadowBlur = 0;
  };
  for (let k = 0; k < 3; k++) {
    const sa = satAngle(k);
    if (Math.sin(sa) < 0) drawSat(sa, false);
  }

  // 4. Outer HUD dial with tick marks + triangular markers (static frame)
  const dialR = R * 0.47;
  ctx.save(); ctx.translate(cx, cy);
  ctx.strokeStyle = "rgba(160,190,220," + al(0.16 * glow + 0.06) + ")";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(0, 0, dialR, 0, 7); ctx.stroke();
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    const big = i % 6 === 0;
    const r1 = dialR - (big ? 9 : 5);
    ctx.strokeStyle = "rgba(170,200,230," + al((big ? 0.34 : 0.18) * glow + 0.05) + ")";
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
    ctx.lineTo(Math.cos(a) * dialR, Math.sin(a) * dialR);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(255,150,60," + al(0.55 * glow) + ")";
  ctx.shadowColor = "rgba(255,150,60,0.8)"; ctx.shadowBlur = 6;
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + k * Math.PI / 2;
    ctx.save();
    ctx.translate(Math.cos(a) * dialR, Math.sin(a) * dialR);
    ctx.rotate(a + Math.PI / 2);
    ctx.beginPath(); ctx.moveTo(0, -5); ctx.lineTo(4, 4); ctx.lineTo(-4, 4);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  ctx.shadowBlur = 0;
  ctx.restore();

  // 5. Faint middle circle
  ctx.strokeStyle = "rgba(150,190,230," + al(0.10 * glow + 0.04) + ")";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, sR * 1.55, 0, 7); ctx.stroke();

  // 6. Glass globe body
  const sg = ctx.createRadialGradient(cx - sR * 0.35, cy - sR * 0.35, sR * 0.1, cx, cy, sR);
  sg.addColorStop(0, "rgba(30,38,54,0.95)");
  sg.addColorStop(0.55, "rgba(13,17,26,0.96)");
  sg.addColorStop(1, "rgba(6,8,13,0.98)");
  ctx.fillStyle = sg;
  ctx.beginPath(); ctx.arc(cx, cy, sR, 0, 7); ctx.fill();

  // 7. Rotating dotted continents
  const spin = t * p.spin, D2R = 0.0174533;
  for (const d of globeDots) {
    const lon = d.lon * D2R + spin, lat = d.lat * D2R;
    const cl = Math.cos(lat);
    const x3 = cl * Math.sin(lon), y3 = Math.sin(lat), z3 = cl * Math.cos(lon);
    if (z3 <= 0.03) continue; // back hemisphere hidden
    const tw = 0.62 + 0.38 * Math.sin(t * 2.6 + d.ph);
    const depth = 0.25 + 0.75 * z3;
    const a = d.land ? (0.68 + 0.32 * tw) * depth * glow : 0.16 * tw * depth * glow;
    ctx.fillStyle = d.land
      ? (d.blue ? "rgba(150,215,255," + al(a) + ")" : "rgba(255,178,90," + al(a) + ")")
      : "rgba(120,150,190," + al(a) + ")";
    const sz = d.s * (0.45 + 0.55 * z3);
    ctx.beginPath();
    ctx.arc(cx + x3 * sR * 0.94, cy - y3 * sR * 0.94, sz, 0, 7);
    ctx.fill();
  }

  // Bright "city light" hubs on the continents — the premium sparkle.
  for (const d of globeDots) {
    if (!d.hub) continue;
    const lon = d.lon * D2R + spin, lat = d.lat * D2R;
    const cl = Math.cos(lat);
    const x3 = cl * Math.sin(lon), y3 = Math.sin(lat), z3 = cl * Math.cos(lon);
    if (z3 <= 0.15) continue;
    const tw = 0.6 + 0.4 * Math.sin(t * 3.2 + d.ph * 2);
    ctx.fillStyle = d.blue
      ? "rgba(170,222,255," + al(0.9 * tw * glow) + ")"
      : "rgba(255,205,130," + al(0.9 * tw * glow) + ")";
    ctx.shadowColor = d.blue ? "rgba(140,200,255,0.9)" : "rgba(255,170,80,0.9)";
    ctx.shadowBlur = 7;
    ctx.beginPath(); ctx.arc(cx + x3 * sR * 0.94, cy - y3 * sR * 0.94, 2.1, 0, 7); ctx.fill();
  }
  ctx.shadowBlur = 0;

  // 8. Fresnel rim light, brightest on the left limb
  if (ctx.createConicGradient) {
    const cg = ctx.createConicGradient(Math.PI, cx, cy);
    cg.addColorStop(0, "rgba(255,170,80," + al(0.95 * glow) + ")");
    cg.addColorStop(0.25, "rgba(255,140,50," + al(0.30 * glow) + ")");
    cg.addColorStop(0.5, "rgba(140,200,255," + al(0.45 * glow) + ")");
    cg.addColorStop(0.75, "rgba(120,170,230," + al(0.12 * glow) + ")");
    cg.addColorStop(1, "rgba(255,170,80," + al(0.95 * glow) + ")");
    ctx.strokeStyle = cg; ctx.lineWidth = 2.8;
    ctx.shadowColor = "rgba(255,150,60,0.85)"; ctx.shadowBlur = 12 * glow;
    ctx.beginPath(); ctx.arc(cx, cy, sR - 1, 0, 7); ctx.stroke();
    ctx.shadowBlur = 0;
  }
  // thin inner highlight just inside the rim
  ctx.strokeStyle = "rgba(200,230,255," + al(0.35 * glow) + ")";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, sR - 4, 0, 7); ctx.stroke();

  // soft top sheen
  const sh = ctx.createLinearGradient(cx - sR, cy - sR, cx + sR * 0.3, cy + sR * 0.3);
  sh.addColorStop(0, "rgba(255,255,255," + al(0.10 * glow) + ")");
  sh.addColorStop(0.4, "rgba(255,255,255,0)");
  ctx.fillStyle = sh;
  ctx.beginPath(); ctx.arc(cx, cy, sR, 0, 7); ctx.fill();

  // Radar sweep — a soft scanner wedge circling the globe.
  if (ctx.createConicGradient) {
    const swA = (t * 0.9) % (Math.PI * 2);
    const sw = ctx.createConicGradient(swA, cx, cy);
    sw.addColorStop(0, "rgba(150,215,255," + al(0.22 * glow) + ")");
    sw.addColorStop(0.10, "rgba(150,215,255," + al(0.05 * glow) + ")");
    sw.addColorStop(0.25, "rgba(150,215,255,0)");
    sw.addColorStop(1, "rgba(150,215,255,0)");
    ctx.fillStyle = sw;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, sR, 0, 7); ctx.fill();
  }

  // 9. Orbit ring front half (passes in front of the globe)
  strokeRing(0, Math.PI, "rgba(160,220,255," + al(0.80 * glow) + ")", 2, 12);

  // 9b. Orbiting satellites (front half, full brightness).
  for (let k = 0; k < 3; k++) {
    const sa = satAngle(k);
    if (Math.sin(sa) >= 0) drawSat(sa, true);
  }

  // 9c. Soft floor reflection beneath the globe.
  ctx.save(); ctx.translate(cx, cy + sR * 1.04); ctx.scale(1, 0.26);
  const rfl = ctx.createLinearGradient(0, -sR * 0.2, 0, sR * 1.1);
  rfl.addColorStop(0, "rgba(255,150,70," + al(0.12 * glow) + ")");
  rfl.addColorStop(1, "rgba(255,150,70,0)");
  ctx.fillStyle = rfl;
  ctx.beginPath(); ctx.arc(0, 0, sR * 0.85, 0, 7); ctx.fill();
  ctx.restore();

  // 10. Speaking ripple rings
  if (coreState === "speaking") {
    for (let i = 0; i < 2; i++) {
      const ph = (t * 0.9 + i * 0.5) % 1;
      ctx.strokeStyle = "rgba(255,150,60," + al((1 - ph) * 0.5 * glow) + ")";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, sR + ph * (R * 0.40 + p.pulse), 0, 7); ctx.stroke();
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
  for (const m of c.messages) {
    if (m.role === "error") appendErrorBubble(m.text, false);
    else appendMessageBubble(m.role, m.text, m.img, false);
  }
  scrollBottom();
}
function avatarFor(role) {
  return role === "user" ? "YOU" : "M";
}
function appendMessageBubble(role, text, img, animate) {
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
  scrollBottom();
  return body;
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
  av.className = "avatar"; av.textContent = "M";
  const dots = document.createElement("div");
  dots.className = "thinking-dots";
  dots.innerHTML = "<span></span><span></span><span></span>";
  div.appendChild(av); div.appendChild(dots);
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
  const bodyEl = appendMessageBubble("assistant", "", null, false);
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
            bodyEl.innerHTML = renderMarkdown(acc);
            scrollBottom(false);
          }
        }
      }
    }
    try { reader.releaseLock(); } catch (e) {}
  } catch (e) {
    // stream interrupted (user stopped, timed out, connection dropped); keep what arrived
  }
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
  const payload = { message: userText, history: historyPayload(c) };
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
      removeThinking();
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
        appendMessageBubble("assistant", reply, null, true);
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
  $("#input").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitFromComposer(); }
  });
  $("#input").addEventListener("input", autoresize);
  autoresize();

  // Image attach
  $("#attachBtn").addEventListener("click", () => $("#fileInput").click());
  $("#fileInput").addEventListener("change", e => { handleFile(e.target.files[0]); e.target.value = ""; });
  $("#imgRemove").addEventListener("click", () => { attachedImage = null; updateImgPreview(); });

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
