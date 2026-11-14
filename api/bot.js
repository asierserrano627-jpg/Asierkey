// api/bot.js — Vercel serverless. Lo llama el bot de Discord (POST /api/bot).
// Variables de entorno: BOT_SECRET, SUPABASE_URL, SUPABASE_KEY (service_role)
// Tabla Supabase `keys`:
//   key text primary key, discord text, roblox_id text, roblox_name text,
//   hwid text, uses int default 0, expires text, status text default 'active', script text
// (si ya tienes otra tabla, solo cambia las funciones get/patch de abajo)

const U = process.env.SUPABASE_URL, K = process.env.SUPABASE_KEY;
const H = { apikey: K, Authorization: `Bearer ${K}`, "Content-Type": "application/json", Prefer: "return=representation" };

const get = async (key) => {
  const r = await fetch(`${U}/rest/v1/keys?key=eq.${encodeURIComponent(key)}&select=*`, { headers: H });
  return (await r.json())[0] || null;
};
const patch = (key, body) =>
  fetch(`${U}/rest/v1/keys?key=eq.${encodeURIComponent(key)}`, { method: "PATCH", headers: H, body: JSON.stringify(body) });

const expirada = (k) => k.expires && new Date(k.expires) < new Date();

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Método no permitido" });
  const { secret, action, key, discordId, robloxId, robloxName, script } = req.body || {};
  if (!process.env.BOT_SECRET || secret !== process.env.BOT_SECRET) return res.status(401).json({ ok: false, error: "No autorizado" });

  try {
    if (action === "setscript") {
      // guarda el script en la fila especial "__script__"
      await fetch(`${U}/rest/v1/keys`, { method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ key: "__script__", script }) });
      return res.json({ ok: true });
    }

    const k = await get(String(key || ""));
    if (!k || k.key === "__script__") return res.json({ ok: false, error: "Key inválida" });
    if (expirada(k) || k.status === "banned") return res.json({ ok: false, error: "Key expirada o bloqueada" });

    // Si la key ya está ligada a otro Roblox, se rechaza
    if (robloxId && k.roblox_id && k.roblox_id !== String(robloxId))
      return res.json({ ok: false, error: "Esta key ya está ligada a otra cuenta de Roblox" });

    if (action === "redeem") {
      if (k.discord && k.discord !== discordId) return res.json({ ok: false, error: "Esta key ya fue canjeada por otra persona" });
      const upd = { discord: discordId };
      if (robloxId) Object.assign(upd, { roblox_id: String(robloxId), roblox_name: robloxName || null });
      await patch(k.key, upd);
      return res.json({ ok: true, expires: k.expires, status: k.status, uses: k.uses });
    }

    if (k.discord !== discordId) return res.json({ ok: false, error: "Esta key no es tuya" });

    if (action === "roblox") {
      await patch(k.key, { roblox_id: String(robloxId), roblox_name: robloxName || null });
      return res.json({ ok: true });
    }
    if (action === "hwid") { await patch(k.key, { hwid: null }); return res.json({ ok: true }); }
    if (action === "stats")
      return res.json({ ok: true, expires: k.expires, hwid: k.hwid, uses: k.uses, status: k.status, roblox: k.roblox_name });

    return res.json({ ok: false, error: "Acción desconocida" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Error del servidor" });
  }
};

/* En tu /api/loader, para comprobar la cuenta de Roblox (viene en ?uid=):
   const k = await get(req.query.script_key);
   if (k.roblox_id && String(req.query.uid) !== k.roblox_id) return res.status(403).send("-- Cuenta de Roblox distinta");
   (el uid lo manda el cliente, así que el HWID sigue siendo la protección real)
*/
