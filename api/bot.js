// api/bot.js — conecta el bot de Discord con AsierKey
// El bot manda: POST /api/bot { secret, action: "redeem"|"hwid"|"stats", key, discordId }
const { redis, same } = require('./_lib');
const E = process.env;
const J = async (k) => { const v = await redis('GET', k); return v ? JSON.parse(v) : null; };
const fail = (res, m, c = 400) => res.status(c).json({ ok: false, error: m });
const fecha = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return fail(res, 'Método no permitido.', 405);
    const { secret, action } = req.body || {};
    const S = E.BOT_SECRET || '';
    if (!S || typeof secret !== 'string' || !same(secret, S)) return fail(res, 'No autorizado.', 401);

    const did = String((req.body || {}).discordId || '').trim();
    if (!/^\d{5,25}$/.test(did)) return fail(res, 'Usuario de Discord no válido.');

    // --- blacklist (solo staff, desde el panel) ---
    if (action === 'bl_list') {
      const all = (await redis('SMEMBERS', 'blset')) || [], list = [];
      for (const h of all) {
        const v = await J('bl:' + h);
        if (!v || v.until <= Date.now()) { await redis('SREM', 'blset', h); continue; }
        const r = Math.ceil((v.until - Date.now()) / 1000), hh = Math.floor(r / 3600), mm = Math.floor((r % 3600) / 60);
        list.push({ hwid: h, left: hh + 'h ' + mm + 'm', reason: v.reason, disc: v.disc || null });
      }
      return res.json({ ok: true, list });
    }
    if (action === 'bl_remove') {
      const h = String((req.body || {}).key || '').trim();
      if (!/^[\w-]{4,64}$/.test(h)) return fail(res, 'HWID no válido.');
      await redis('DEL', 'bl:' + h); await redis('SREM', 'blset', h); await redis('DEL', 'hk:' + h);
      return res.json({ ok: true });
    }

    const key = String((req.body || {}).key || '').trim().toUpperCase();
    if (!/^AK-[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$/.test(key)) return fail(res, 'Esa key no tiene un formato válido.');

    const x = await J('keyidx:' + key);
    if (!x || x.exp <= Date.now()) return fail(res, 'Key inválida o caducada.');
    const owner = await redis('GET', 'dkey:' + key);

    if (action === 'redeem') {
      if (owner && owner !== did) return fail(res, 'Esta key ya fue canjeada por otra cuenta de Discord.', 403);
      // una sola key activa por cuenta de Discord
      const otra = await redis('GET', 'duser:' + did);
      if (otra && otra !== key) { const y = await J('keyidx:' + otra); if (y && y.exp > Date.now()) return fail(res, 'Ya tienes una key activa. Espera a que caduque para canjear otra.', 403); }
      const ttl = Math.ceil((x.exp - Date.now()) / 1000) + 60;
      await redis('SET', 'duser:' + did, key, 'EX', ttl);
      await redis('SET', 'dkey:' + key, did, 'EX', ttl);
      return res.json({ ok: true, status: 'active', expires: fecha(x.exp), hwid: !!x.shwid, uses: null });
    }

    // hwid y stats: solo el dueño que la canjeó
    if (owner !== did) return fail(res, 'Esta key no está canjeada por tu cuenta.', 403);

    if (action === 'stats') {
      return res.json({ ok: true, status: 'active', expires: fecha(x.exp), hwid: !!x.shwid, uses: null });
    }

    if (action === 'hwid') {
      const ok = await redis('SET', 'rst:' + key, '1', 'EX', 86400, 'NX');
      if (!ok) return fail(res, 'Solo puedes resetear el HWID una vez cada 24 horas.', 429);
      x.shwid = null;
      await redis('SET', 'keyidx:' + key, JSON.stringify(x), 'KEEPTTL');
      return res.json({ ok: true, status: 'active', expires: fecha(x.exp), hwid: false, uses: null });
    }

    return fail(res, 'Acción no válida.');
  } catch (e) {
    console.error(e);
    return fail(res, 'Error del servidor.', 500);
  }
};
