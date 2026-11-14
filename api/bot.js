// api/bot.js — Vercel. Lo llama el bot de Discord (POST /api/bot).
// Usa el MISMO Redis (Upstash) y las MISMAS keys que [action].js (keyidx:, dkey:, bl:, script:main).
// Variable nueva en Vercel (Settings > Environment Variables, luego Redeploy):
//   BOT_SECRET   (el mismo que pusiste en el bot con "Conectar web")
// Ya tienes UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (o KV_REST_API_*) de tu web. No usa Supabase.
const { redis } = require("./_lib");
const E = process.env;

const J = async (k) => { const v = await redis("GET", k); try { return v ? JSON.parse(v) : null; } catch { return null; } };
const okKey = (k) => typeof k === "string" && /^[\w-]{4,64}$/.test(k);
const fmt = (r) => { const h = Math.floor(r / 3600), m = Math.floor((r % 3600) / 60), s = r % 60; return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`; };

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  const out = (o, c = 200) => res.status(c).json(o);
  const err = (m, c = 200) => out({ ok: false, error: m }, c);
  if (req.method !== "POST") return err("Método no permitido", 405);
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = {}; } }
  b = b || {};
  const { secret, action, key, discordId, robloxId, robloxName, script } = b;

  try {
    if (!E.BOT_SECRET) return err("Falta la variable BOT_SECRET en Vercel");
    if (!(E.UPSTASH_REDIS_REST_URL || E.KV_REST_API_URL)) return err("Falta la conexión a Upstash/Redis en Vercel");
    if (secret !== E.BOT_SECRET) return err("Secreto incorrecto (BOT_SECRET distinto en bot y web)", 401);

    // ── acciones que no necesitan key ──
    if (action === "setscript") {
      if (typeof script !== "string" || !script.trim()) return err("El script está vacío");
      await redis("SET", "script:main", script);
      return out({ ok: true });
    }
    if (action === "bl_list") {
      const list = [];
      for (const hwid of (await redis("SMEMBERS", "blset")) || []) {
        const v = await J("bl:" + hwid);
        if (v && v.until > Date.now()) list.push({ hwid, disc: v.disc || null, left: fmt(Math.ceil((v.until - Date.now()) / 1000)), reason: v.reason || "—" });
        else await redis("SREM", "blset", hwid);
      }
      return out({ ok: true, list });
    }
    if (action === "bl_remove") {
      const h = String(key || "").trim();
      if (!okKey(h)) return err("HWID no válido");
      await redis("DEL", "bl:" + h); await redis("SREM", "blset", h); await redis("DEL", "hk:" + h);
      return out({ ok: true });
    }

    // ── acciones con key (las keys las crea tu web al terminar los checkpoints) ──
    const k = String(key || "").trim();
    if (!okKey(k)) return err("Key inválida");
    const x = await J("keyidx:" + k);
    if (!x) return err("Key inválida");
    const now = Date.now();
    if (x.exp <= now) return err("Key expirada");
    const secs = Math.max(60, Math.ceil((x.exp - now) / 1000) + 60);

    if (robloxId) {
      const r = await J("rbx:" + k);
      if (r && r.id !== String(robloxId)) return err("Esta key ya está ligada a otra cuenta de Roblox");
    }
    const guardaRoblox = async () => { if (robloxId) await redis("SET", "rbx:" + k, JSON.stringify({ id: String(robloxId), name: robloxName || null }), "EX", secs); };

    const dueno = await redis("GET", "dkey:" + k);
    if (action === "redeem") {
      if (dueno && dueno !== discordId) return err("Esta key ya fue canjeada por otra persona");
      await redis("SET", "dkey:" + k, String(discordId), "EX", secs);
      await guardaRoblox();
      return out({ ok: true, expires: `<t:${Math.floor(x.exp / 1000)}:R>`, status: "active", uses: 0 });
    }

    // hwid / stats / roblox: si la key aún no tiene dueño, se le asigna a quien la pide
    if (dueno && dueno !== discordId) return err("Esta key no es tuya");
    if (!dueno) await redis("SET", "dkey:" + k, String(discordId), "EX", secs);

    if (action === "roblox") { await guardaRoblox(); return out({ ok: true }); }
    if (action === "hwid") {
      const old = x.shwid; delete x.shwid;
      await redis("SET", "keyidx:" + k, JSON.stringify(x), "KEEPTTL");
      if (old) await redis("DEL", "hk:" + old);
      return out({ ok: true });
    }
    if (action === "stats") {
      const bl = x.shwid && (await J("bl:" + x.shwid));
      const rb = await J("rbx:" + k);
      return out({ ok: true, expires: `<t:${Math.floor(x.exp / 1000)}:R>`, hwid: x.shwid || null, uses: 0, status: bl && bl.until > now ? "blacklist" : "active", roblox: rb ? rb.name : null });
    }
    return err("Acción desconocida: " + action);
  } catch (e) {
    return err(String((e && e.message) || e).slice(0, 250));
  }
};
