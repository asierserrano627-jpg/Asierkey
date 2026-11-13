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

    const key = String((req.body || {}).key || '').trim().toUpperCase();
    const did = String((req.body || {}).discordId || '').trim();
    if (!/^AK-[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$/.test(key)) return fail(res, 'Esa key no tiene un formato válido.');
    if (!/^\d{5,25}$/.test(did)) return fail(res, 'Usuario de Discord no válido.');

    const x = await J('keyidx:' + key);
    if (!x || x.exp <= Date.now()) return fail(res, 'Key inválida o caducada.');
    const owner = await redis('GET', 'dkey:' + key);

    if (action === 'redeem') {
      if (owner && owner !== did) return fail(res, 'Esta key ya fue canjeada por otra cuenta de Discord.', 403);
      const ttl = Math.ceil((x.exp - Date.now()) / 1000) + 60;
      await redis('SET', 'dkey:' + key, did, 'EX', ttl);
      return res.json({ ok: true, status: 'active', expires: fecha(x.exp), hwid: !!x.hwid, uses: null });
    }

    // hwid y stats: solo el dueño que la canjeó
    if (owner !== did) return fail(res, 'Esta key no está canjeada por tu cuenta.', 403);

    if (action === 'stats') {
      return res.json({ ok: true, status: 'active', expires: fecha(x.exp), hwid: !!x.hwid, uses: null });
    }

    if (action === 'hwid') {
      const ok = await redis('SET', 'rst:' + key, '1', 'EX', 86400, 'NX');
      if (!ok) return fail(res, 'Solo puedes resetear el HWID una vez cada 24 horas.', 429);
      x.hwid = null;
      await redis('SET', 'keyidx:' + key, JSON.stringify(x), 'KEEPTTL');
      return res.json({ ok: true, status: 'active', expires: fecha(x.exp), hwid: false, uses: null });
    }

    return fail(res, 'Acción no válida.');
  } catch (e) {
    console.error(e);
    return fail(res, 'Error del servidor.', 500);
  }
};
