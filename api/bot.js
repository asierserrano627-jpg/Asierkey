// api/bot.js — Vercel. Lo llama el bot de Discord (POST /api/bot).
// Variables en Vercel (Settings > Environment Variables, luego Redeploy):
//   BOT_SECRET   (el mismo que pusiste en el bot con "Conectar web")
//   SUPABASE_URL (https://xxxx.supabase.co, sin barra final)
//   SUPABASE_KEY (service_role)
// Crea la tabla ejecutando tabla-keys.sql en Supabase > SQL Editor.

const env = () => {
  const U = (process.env.SUPABASE_URL || "").replace(/\/+$/, ""), K = process.env.SUPABASE_KEY || "";
  if (!U || !K || !process.env.BOT_SECRET) throw new Error("Faltan variables en Vercel: BOT_SECRET, SUPABASE_URL o SUPABASE_KEY");
  return { U, H: { apikey: K, Authorization: `Bearer ${K}`, "Content-Type": "application/json", Prefer: "return=representation" } };
};

async function db(method, path, body, extraHeaders) {
  const { U, H } = env();
  const r = await fetch(`${U}/rest/v1/${path}`, { method, headers: { ...H, ...(extraHeaders || {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j; try { j = t ? JSON.parse(t) : []; } catch { j = t; }
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(j && j.message) || t}`.slice(0, 250));
  return j;
}
const get = async (key) => (await db("GET", `keys?key=eq.${encodeURIComponent(key)}&select=*`))[0] || null;
const patch = (key, body) => db("PATCH", `keys?key=eq.${encodeURIComponent(key)}`, body);

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Método no permitido" });
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = {}; } }
  b = b || {};
  const { secret, action, key, discordId, robloxId, robloxName, script } = b;

  try {
    env();
    if (secret !== process.env.BOT_SECRET) return res.status(401).json({ ok: false, error: "Secreto incorrecto (BOT_SECRET distinto en bot y web)" });

    if (action === "setscript") {
      await db("POST", "keys", { key: "__script__", script }, { Prefer: "resolution=merge-duplicates,return=minimal" });
      return res.json({ ok: true });
    }
    if (action === "bl_list") return res.json({ ok: true, list: [] });
    if (action === "bl_remove") return res.json({ ok: true });

    const k = await get(String(key || "").trim());
    if (!k || k.key === "__script__") return res.json({ ok: false, error: "Key inválida" });
    if (k.status === "banned") return res.json({ ok: false, error: "Key bloqueada" });
    if (k.expires && new Date(k.expires) < new Date()) return res.json({ ok: false, error: "Key expirada" });

    if (robloxId && k.roblox_id && k.roblox_id !== String(robloxId))
      return res.json({ ok: false, error: "Esta key ya está ligada a otra cuenta de Roblox" });

    if (action === "redeem") {
      if (k.discord && k.discord !== discordId) return res.json({ ok: false, error: "Esta key ya fue canjeada por otra persona" });
      const upd = { discord: discordId };
      if (robloxId) { upd.roblox_id = String(robloxId); upd.roblox_name = robloxName || null; }
      await patch(k.key, upd);
      return res.json({ ok: true, expires: k.expires, status: k.status || "active", uses: k.uses || 0 });
    }

    // hwid / stats / roblox: si la key aún no tiene dueño, se le asigna a quien la pide
    if (k.discord && k.discord !== discordId) return res.json({ ok: false, error: "Esta key no es tuya" });
    if (!k.discord) await patch(k.key, { discord: discordId });

    if (action === "hwid") { await patch(k.key, { hwid: null }); return res.json({ ok: true }); }
    if (action === "roblox") { await patch(k.key, { roblox_id: String(robloxId), roblox_name: robloxName || null }); return res.json({ ok: true }); }
    if (action === "stats") return res.json({ ok: true, expires: k.expires, hwid: k.hwid, uses: k.uses || 0, status: k.status || "active", roblox: k.roblox_name });

    return res.json({ ok: false, error: "Acción desconocida: " + action });
  } catch (e) {
    // El mensaje real sale en Discord para saber qué falla
    return res.status(200).json({ ok: false, error: String(e.message || e).slice(0, 250) });
  }
};
