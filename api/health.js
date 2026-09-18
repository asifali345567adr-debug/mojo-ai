import { API_KEY, MODEL } from "./_lib.js";

export default function handler(req, res) {
  res.status(200).json({ ok: true, model: MODEL, keyConfigured: !!API_KEY });
}
