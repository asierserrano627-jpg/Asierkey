// AsierKey API: un solo archivo para /api/ping, /api/create, /api/start, /api/complete, /api/status
const crypto = require('crypto');

const DB_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const DB_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const OWN_WAIT = 15;
const EXT_WAIT = 10;

const HOSTS = {
  linkvertise: ['linkvertise.com','link-to.net','direct-link.net','up-to-down.net','link-hub.net','link-target.net','link-center.net','link-depot.net','link-spot.net','link-place.net','file-link.net','filemedia.net'],
  lootlabs: ['loot-link.com','loot-links.com','lootlinks.co','lootdest.com','lootdest.org','lootdest.info','lootlabs.gg']
};

async function db(...cmd) {
  const r = await fetch(DB_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + DB_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}

const rnd = n => crypto.randomBytes(n).toString('hex');
const okLink = (p, u) => {
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:') return false;
    const h = x.hostname.replace(/^www\./, '').toLowerCase();
    return HOSTS[p].some(d => h === d || h.endsWith('.' + d));
  } catch (e) { return false; }
};
const getCfg = async k => {
  if (!/^[a-f0-9]{10}$/.test(k || '')) return null;
  const v = await db('GET', 'cfg:' + k);
  return v ? JSON.parse(v) : null;
};
const okHw = h => typeof h === 'string' && h.length >= 4 && h.length <= 128;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const send = (code, obj) => res.status(code).json(obj);
  const route = req.url.split('?')[0].replace(/^\/api\//, '').replace(/\/$/, '');

  if (route === 'ping') {
    let up = false;
    if (DB_URL && DB_TOKEN) { try { up = (await db('PING')) === 'PONG'; } catch (e) {} }
    return send(200, { ok: true, upstash: up });
  }

  if (!DB_URL || !DB_TOKEN) return send(500, { error: 'Faltan las variables de Upstash en Vercel.' });

  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }

  try {
    if (route === 'create' && req.method === 'POST') {
      const { provider, ttl, n, links } = body;
      if (!['linkvertise', 'lootlabs', 'asierkey'].includes(provider)) return send(400, { error: 'Proveedor no válido.' });
      if (!Number.isInteger(ttl) || ttl < 60 || ttl > 2592000) return send(400, { error: 'Tiempo no válido.' });
      if (!Number.isInteger(n) || n < 1 || n > 3) return send(400, { error: 'Checkpoints no válidos.' });
      let L = [];
      if (provider !== 'asierkey') {
        if (!Array.isArray(links) || links.length < n) return send(400, { error: 'Faltan links.' });
        L = links.slice(0, n);
        if (!L.every(u => okLink(provider, u))) return send(400, { error: 'Algún link no es válido.' });
      }
      const id = rnd(5);
      await db('SET', 'cfg:' + id, JSON.stringify({ provider, ttl, n, links: L }));
      return send(200, { id });
    }

    if (route === 'status') {
      const k = req.query.k, hwid = req.query.hwid;
      const cfg = await getCfg(k);
      if (!cfg) return send(200, { error: 'ID de key no encontrado.', total: 3, done: 0 });
      if (!okHw(hwid)) return send(200, { error: 'HWID no válido.', total: cfg.n, done: 0 });
      const key = await db('GET', `key:${k}:${hwid}`);
      if (key) {
        const left = await db('TTL', `key:${k}:${hwid}`);
        return send(200, { total: cfg.n, done: cfg.n, locked: false, key, expiresIn: Math.max(0, left) });
      }
      const done = parseInt(await db('GET', `prog:${k}:${hwid}`)) || 0;
      return send(200, { total: cfg.n, done, locked: false, key: null, expiresIn: 0 });
    }

    if (route === 'start' && req.method === 'POST') {
      const { k, hwid } = body;
      const cfg = await getCfg(k);
      if (!cfg) return send(404, { error: 'ID de key no encontrado.' });
      if (!okHw(hwid)) return send(400, { error: 'HWID no válido.' });
      if (await db('GET', `key:${k}:${hwid}`)) return send(400, { error: 'Ya tienes una key activa.' });
      const done = parseInt(await db('GET', `prog:${k}:${hwid}`)) || 0;
      if (done >= cfg.n) return send(400, { error: 'Ya completaste los checkpoints.' });
      const token = rnd(16);
      await db('SET', 'tok:' + token, JSON.stringify({ k, hwid, t0: Date.now() }), 'EX', 3600);
      if (cfg.provider === 'asierkey') return send(200, { token, min: OWN_WAIT });
      return send(200, { token, url: cfg.links[done] });
    }

    if (route === 'complete' && req.method === 'POST') {
      const { token } = body;
      if (!/^[a-f0-9]{32}$/.test(token || '')) return send(400, { error: 'Token no válido.' });
      const raw = await db('GET', 'tok:' + token);
      if (!raw) return send(400, { error: 'Checkpoint caducado, pulsa Open otra vez.' });
      const t = JSON.parse(raw);
      const cfg = await getCfg(t.k);
      if (!cfg) return send(404, { error: 'ID de key no encontrado.' });
      const min = cfg.provider === 'asierkey' ? OWN_WAIT : EXT_WAIT;
      const wait = Math.ceil(min - (Date.now() - t.t0) / 1000);
      if (wait > 0) return send(400, { error: 'Demasiado pronto.', wait });
      await db('DEL', 'tok:' + token);
      const pk = `prog:${t.k}:${t.hwid}`;
      const done = await db('INCR', pk);
      await db('EXPIRE', pk, 86400);
      if (done >= cfg.n) {
        const key = 'ASIER-' + rnd(2).toUpperCase() + '-' + rnd(2).toUpperCase() + '-' + rnd(2).toUpperCase();
        await db('SET', `key:${t.k}:${t.hwid}`, key, 'EX', cfg.ttl);
        await db('DEL', pk);
      }
      return send(200, { ok: true, done });
    }

    return send(404, { error: 'Ruta no encontrada: /api/' + route });
  } catch (e) {
    return send(500, { error: 'Error del servidor: ' + e.message });
  }
};
