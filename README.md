# Mojo AI — Public Link Package (backend + web app)

This package gives you **one public link with the brain inside**. Your API
key stays **server-side** (the web page never sees it), `POST /api/chat`
answers with the model, and the Mojo web app is served from the same place.

Two free hosting paths are supported — pick one:

- **Vercel** (recommended — no credit card, instant): `api/` holds
  serverless functions (`_lib.js` shared, `health.js`, `chat.js`); `public/`
  is served as the static web app.
- **Render**: `server.mjs` is the all-in-one Node server (serves API +
  static app), deployed via the `render.yaml` Blueprint. Render now asks for
  a credit card for identity verification.

No dependencies. Plain Node.js 18+.

## Files

- `api/` — Vercel serverless functions (Mojo-branded, per-IP rate limiting)
- `server.mjs` — the all-in-one Node server (Render / local runs)
- `public/` — the Mojo web app (black/orange/light-blue, chat, voice, vision)
- `render.yaml` — Render Blueprint for one-click deploy
- `package.json` — start script for hosts like Render

## Deploy free on Vercel (recommended, about 10 minutes, no card)

1. Create a free account at **github.com** (or sign in with Google).
2. On github.com → **New repository** → name it `mojo-ai` (Public) → Create.
3. Extract this zip, then in the new repo click **Add file → Upload files**
   and upload **everything**: `api/`, `server.mjs`, `package.json`,
   `render.yaml` **and the whole `public/` folder**. Commit.
4. Create a free account at **vercel.com** → Continue with GitHub.
5. On vercel.com → **Add New… → Project** → Import the `mojo-ai` repo →
   **Deploy**.
6. After deploy: Project → **Settings → Environment Variables** → add
   `AI_API_KEY` = your OpenRouter key from https://openrouter.ai/keys
   (never share it) → **Save**, then **Redeploy** from the Deployments tab.
7. **The project URL IS your public Mojo link** — e.g.
   `https://mojo-ai.vercel.app`. Open it on any phone or browser. Check
   `/api/health` on that URL to confirm the brain is connected
   (`keyConfigured:true`).

## Deploy free on Render (card required for verification)

1–3. Same GitHub repo steps as above.
4. Create a free account at **render.com** (or sign in with Google).
5. On render.com → **New +** → **Blueprint** → connect your GitHub → select
   the `mojo-ai` repo.
6. Render shows the environment variables. Paste your key for `AI_API_KEY`
   (your OpenRouter key from https://openrouter.ai/keys — never share it).
   `AI_API_URL` and `AI_MODEL` are pre-filled. Click **Apply**.
7. Wait for deploy (2–4 minutes). **The service URL IS your public Mojo
   link** — e.g. `https://mojo-ai.onrender.com`. Open it on any phone or
   browser: the app loads, and the brain answers through `/api/chat`.
   Check `/api/health` on that URL to confirm the brain is connected
   (`keyConfigured:true`).

Notes:
- Free Render services sleep when idle — the first visit after a long pause
  can take ~30 seconds to wake up. The app shows a "waking up" notice; that
  is normal.
- The free OpenRouter model has daily limits. If many people use the public
  link, add $10 of OpenRouter credits to raise limits a lot.
- To change the AI model later: Render dashboard → your service →
  Environment → edit `AI_MODEL` → Save (auto-redeploys).

## Run locally (optional)

```bash
AI_API_KEY=your_key_here node server.mjs
# open http://localhost:8787  — the app loads, served by the same server
```

## Endpoints

- `GET /api/health` → `{ ok, model, keyConfigured }`
- `POST /api/chat` → `{ message, history?, image?, model? }` → `{ reply }`
  Rate limited per IP (default 30/min, 300/day; tune with `RATE_PER_MINUTE`
  / `RATE_PER_DAY` env vars).
