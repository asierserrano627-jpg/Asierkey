// AsierKey API (Vercel + Upstash Redis REST)
// Variables de entorno necesarias en Vercel:
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN  (base de datos)
//   ADMIN_PASSWORD                                    (contraseña para crear keys)
//   ADMIN_USER                                        (opcional: si lo pones, también se exige el usuario)
const crypto = require('crypto');

const RU = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/$/, '');
const RT = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const HAS = !!(RU && RT);
const ST_EX = 3196800; // 37 días: margen sobre el máximo de 30d de una key
const MAX_KEYS = 500;
const PROVIDERS = ['linkvertise', 'lootlabs', 'asierkey'];
const HOSTS = {
  linkvertise: ['linkvertise.com', 'link-to.net', 'direct-link.net', 'up-to-down.net', 'link-hub.net', 'link-target.net', 'link-center.net', 'link-depot.net', 'link-spot.net', 'link-place.net', 'file-link.net', 'filemedia.net'],
  lootlabs: ['loot-link.com', 'loot-links.com', 'lootlinks.co', 'lootdest.com', 'lootdest.org', 'lootdest.info', 'lootlabs.gg']
};
const NAMES = { linkvertise: 'Linkvertise', lootlabs: 'Lootlabs', asierkey: 'AsierKey' };
const MIN_WAIT = { asierkey: 15, linkvertise: 10, lootlabs: 10 }; // segundos mínimos por checkpoint
// Detección de origen: al volver de Linkvertise/Lootlabs el navegador debe venir de su dominio.
//   REF_MODE=log    (por defecto) solo registra de dónde vuelve cada jugador, no castiga
//   REF_MODE=strict si el origen no es Linkvertise/Lootlabs cuenta como falta (3 faltas = bypass)
const REF_MODE = process.env.REF_MODE === 'strict' ? 'strict' : 'log';
const refHost = r => { try { return new URL(String(r || '')).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } };
const refOk = (p, h) => !!h && !!HOSTS[p] && HOSTS[p].some(d => h === d || h.endsWith('.' + d));

// ---------- Redis ----------
async function rd(cmd) {
  const r = await fetch(RU, { method: 'POST', headers: { Authorization: 'Bearer ' + RT, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd.map(String)) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
async function pipe(cmds) {
  const r = await fetch(RU + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + RT, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds.map(c => c.map(String))) });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error((j && j.error) || 'pipeline');
  return j.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}
const getj = async k => { const v = await rd(['GET', k]); try { return v ? JSON.parse(v) : null; } catch (e) { return null; } };
const setj = (k, o, ex) => rd(ex ? ['SET', k, JSON.stringify(o), 'EX', ex] : ['SET', k, JSON.stringify(o)]);

// ---------- utilidades ----------
const ipOf = req => String((req.headers['x-forwarded-for'] || '').split(',')[0] || (req.socket && req.socket.remoteAddress) || 'x').trim().slice(0, 64);
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const hex = n => crypto.randomBytes(n).toString('hex');
const OKID = s => /^[a-f0-9]{10}$/.test(s);
const OKH = s => /^[A-Za-z0-9_-]{4,128}$/.test(s);
const OKKEY = s => /^ASIER-[A-F0-9]{4}(-[A-F0-9]{4}){2}$/.test(s);
const genKey = () => 'ASIER-' + [hex(2), hex(2), hex(2)].map(x => x.toUpperCase()).join('-');
const skey = (id, hwid) => 'st:' + id + ':' + hwid;

// Límite de intentos por IP: true si todavía puede pasar
async function rl(req, bucket, max, win) {
  const k = 'rl:' + bucket + ':' + ipOf(req);
  const n = await rd(['INCR', k]);
  if (n === 1) await rd(['EXPIRE', k, win]);
  return n <= max;
}

// Comprobación real del link: https, dominio oficial del proveedor y con ruta (no solo el dominio)
function okLink(p, u) {
  try {
    if (!HOSTS[p] || typeof u !== 'string' || u.length > 500) return false;
    const x = new URL(u);
    if (x.protocol !== 'https:' || x.username || x.password) return false;
    if (x.pathname.length < 2) return false;
    const h = x.hostname.replace(/^www\./, '').toLowerCase();
    return HOSTS[p].some(d => h === d || h.endsWith('.' + d));
  } catch (e) { return false; }
}

async function isAdmin(req) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!/^[a-f0-9]{48}$/.test(t)) return false;
  return !!(await rd(['GET', 'sess:' + t]));
}

async function getState(id, hwid) {
  let st = (await getj(skey(id, hwid))) || { done: 0, strikes: 0 };
  if (st.lockUntil && Date.now() >= st.lockUntil) st = { done: 0, strikes: 0 };
  return st;
}
const saveState = (id, hwid, st) => setj(skey(id, hwid), st, ST_EX);
const isLocked = st => !!(st.lockUntil && Date.now() < st.lockUntil);

// Anticheat: reinicia checkpoints y bloquea hasta que pase el tiempo de la key
const BYP = { error: 'Bypass detectado: tus checkpoints se reiniciaron y no podrás hacer otros hasta que pase el tiempo de tu key.', bypass: true };
async function flagBypass(req, st, cfg, id, hwid, reason) {
  st.done = 0; st.tok = null; st.strikes = 0; st.lockUntil = Date.now() + cfg.ttl * 1000;
  await pipe([
    ['SET', skey(id, hwid), JSON.stringify(st), 'EX', ST_EX],
    ['LPUSH', 'log:bypass', JSON.stringify({ t: Date.now(), id, hwid, ip: ipOf(req), reason })],
    ['LTRIM', 'log:bypass', 0, 199]
  ]);
}

// ---------- rutas ----------
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const route = (req.url || '').split('?')[0].replace(/^\/api\/?/, '').replace(/\/+$/, '');
  const q = req.query || {};
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body && typeof body === 'object' ? body : {};
  const out = (c, o) => res.status(c).json(o);
  const TOO = () => out(429, { error: 'Demasiados intentos. Espera un momento e inténtalo otra vez.' });
  const needPost = () => req.method !== 'POST' && (out(405, { error: 'Método no permitido.' }), true);

  try {
    if (route === 'ping') {
      let up = false;
      if (HAS) { try { up = (await rd(['PING'])) === 'PONG'; } catch (e) {} }
      return out(200, { ok: true, upstash: up, admin: !!process.env.ADMIN_PASSWORD });
    }
    if (!HAS) return out(500, { error: 'Falta conectar Upstash (UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN).' });

    // ----- login de administrador -----
    if (route === 'login') {
      if (needPost()) return;
      const pw = process.env.ADMIN_PASSWORD;
      if (!pw) return out(500, { error: 'Falta la variable ADMIN_PASSWORD en Vercel.' });
      if (!(await rl(req, 'login', 5, 600))) return out(429, { error: 'Demasiados intentos. Espera 10 minutos.' });
      const okU = process.env.ADMIN_USER ? same(body.u || '', process.env.ADMIN_USER) : true;
      const okP = same(body.p || '', pw);
      if (!(okU && okP)) return out(401, { error: 'Usuario o contraseña incorrectos.' });
      const token = hex(24);
      await rd(['SET', 'sess:' + token, '1', 'EX', 43200]);
      return out(200, { token });
    }

    // ----- crear key (solo admin) -----
    if (route === 'create') {
      if (needPost()) return;
      if (!(await isAdmin(req))) return out(401, { error: 'Necesitas iniciar sesión.' });
      if (!(await rl(req, 'create', 30, 3600))) return TOO();
      const provider = String(body.provider || '');
      if (!PROVIDERS.includes(provider)) return out(400, { error: 'Proveedor no válido.' });
      const ttl = Math.floor(Number(body.ttl));
      if (!(ttl >= 60 && ttl <= 2592000)) return out(400, { error: 'El tiempo tiene que estar entre 1m y 30d.' });
      const n = Math.floor(Number(body.n));
      if (!(n >= 1 && n <= 3)) return out(400, { error: 'Los checkpoints tienen que ser entre 1 y 3.' });
      const links = [];
      if (provider !== 'asierkey') {
        const arr = Array.isArray(body.links) ? body.links : [];
        for (let i = 0; i < n; i++) {
          const v = String(arr[i] || '').trim();
          if (!okLink(provider, v)) return out(400, { error: 'El link ' + (i + 1) + ' no es un link válido de ' + NAMES[provider] + ' (tiene que ser https y de su dominio oficial).' });
          links.push(v);
        }
      }
      if ((await rd(['SCARD', 'keys:list'])) >= MAX_KEYS) return out(400, { error: 'Has llegado al máximo de ' + MAX_KEYS + ' keys. Borra alguna en Mis links.' });
      const id = hex(5);
      await pipe([['SET', 'key:' + id, JSON.stringify({ id, provider, ttl, n, links, created: Date.now() })], ['SADD', 'keys:list', id]]);
      return out(200, { id });
    }

    // ----- Mis links (solo admin) -----
    if (route === 'list') {
      if (!(await isAdmin(req))) return out(401, { error: 'Necesitas iniciar sesión.' });
      if (!(await rl(req, 'list', 60, 60))) return TOO();
      const lg = await pipe([['LRANGE', 'log:ref', 0, 9], ['LRANGE', 'log:bypass', 0, 9]]);
      const pj = a => (a || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
      const logs = { ref: pj(lg[0]), bypass: pj(lg[1]), mode: REF_MODE };
      const ids = (await rd(['SMEMBERS', 'keys:list'])) || [];
      if (!ids.length) return out(200, { items: [], logs });
      const cmds = [];
      ids.forEach(id => { cmds.push(['GET', 'key:' + id]); cmds.push(['SCARD', 'pl:' + id]); });
      const r = await pipe(cmds);
      const items = [], dead = [];
      ids.forEach((id, i) => {
        let c = null; try { c = r[i * 2] ? JSON.parse(r[i * 2]) : null; } catch (e) {}
        if (!c) dead.push(id); else items.push({ id, provider: c.provider, ttl: c.ttl, n: c.n, created: c.created, players: r[i * 2 + 1] || 0 });
      });
      if (dead.length) await rd(['SREM', 'keys:list', ...dead]);
      items.sort((a, b) => b.created - a.created);
      return out(200, { items, logs });
    }

    // ----- borrar / revocar (solo admin) -----
    if (route === 'delete') {
      if (needPost()) return;
      if (!(await isAdmin(req))) return out(401, { error: 'Necesitas iniciar sesión.' });
      if (!(await rl(req, 'delete', 60, 60))) return TOO();
      const id = String(body.id || '');
      if (!OKID(id)) return out(400, { error: 'ID no válido.' });
      await pipe([['DEL', 'key:' + id], ['SREM', 'keys:list', id], ['DEL', 'pl:' + id]]);
      return out(200, { ok: true });
    }

    // ----- estado del jugador -----
    if (route === 'status') {
      const k = String(q.k || ''), hwid = String(q.hwid || '');
      if (!OKID(k) || !OKH(hwid)) return out(400, { error: 'Link no válido. Abre el link de tu key (el que acaba en ?k=...).' });
      if (!(await rl(req, 'status', 120, 60))) return TOO();
      const cfg = await getj('key:' + k);
      if (!cfg) return out(404, { error: 'Este link de key no existe o fue revocado.' });
      const st = await getState(k, hwid);
      return out(200, { total: cfg.n, done: st.done, locked: isLocked(st), key: st.key || null, expiresIn: st.key ? Math.max(0, Math.round((st.expAt - Date.now()) / 1000)) : 0 });
    }

    // ----- empezar checkpoint (pulsar Open) -----
    if (route === 'start') {
      if (needPost()) return;
      const k = String(body.k || ''), hwid = String(body.hwid || '');
      if (!OKID(k) || !OKH(hwid)) return out(400, { error: 'Link no válido.' });
      if (!(await rl(req, 'start', 20, 300))) return TOO();
      const cfg = await getj('key:' + k);
      if (!cfg) return out(404, { error: 'Este link de key no existe o fue revocado.' });
      const st = await getState(k, hwid);
      if (isLocked(st)) return out(403, { error: 'Checkpoints reiniciados: no puedes hacer otros hasta que tu key caduque.' });
      if (st.key) return out(400, { error: st.expAt > Date.now() ? 'Ya tienes una key activa.' : 'Tu key caducó. Pulsa Renovar.' });
      // Anticheat: navegador automatizado (Selenium, Puppeteer, etc.)
      if (body.env && body.env.wd) { await flagBypass(req, st, cfg, k, hwid, 'automation'); return out(403, BYP); }
      const token = hex(24);
      st.tok = token; st.t0 = Date.now(); st.ip = ipOf(req);
      await pipe([
        ['SET', skey(k, hwid), JSON.stringify(st), 'EX', ST_EX],
        ['SET', 'tok:' + token, JSON.stringify({ id: k, hwid }), 'EX', 1800],
        ['SADD', 'pl:' + k, hwid]
      ]);
      const min = MIN_WAIT[cfg.provider] || 10;
      if (cfg.provider === 'asierkey') return out(200, { token, min });
      return out(200, { token, min, url: cfg.links[st.done] || cfg.links[0] });
    }

    // ----- terminar checkpoint -----
    if (route === 'complete') {
      if (needPost()) return;
      if (!(await rl(req, 'complete', 40, 300))) return TOO();
      const token = String(body.token || '');
      if (!/^[a-f0-9]{48}$/.test(token)) return out(400, { error: 'Token no válido.' });
      const t = await rd(['GETDEL', 'tok:' + token]); // un solo uso
      if (!t) return out(400, { error: 'Token no válido o ya usado. Pulsa Open otra vez.' });
      let ref = null; try { ref = JSON.parse(t); } catch (e) {}
      if (!ref) return out(400, { error: 'Token no válido.' });
      const { id, hwid } = ref;
      const cfg = await getj('key:' + id);
      if (!cfg) return out(404, { error: 'Este link de key no existe o fue revocado.' });
      const st = await getState(id, hwid);
      if (isLocked(st)) return out(403, { error: 'Checkpoints reiniciados: no puedes hacer otros hasta que tu key caduque.' });
      if (st.tok !== token) return out(400, { error: 'Token antiguo. Pulsa Open otra vez.' });
      const min = MIN_WAIT[cfg.provider] || 10;
      const elapsed = (Date.now() - (st.t0 || 0)) / 1000;
      const strike = async (reason, resp) => {
        st.strikes = (st.strikes || 0) + 1; st.tok = null;
        if (st.strikes >= 3) { await flagBypass(req, st, cfg, id, hwid, reason); return out(403, BYP); }
        await saveState(id, hwid, st);
        return out(400, resp);
      };
      if (elapsed < min - 1) // se saltó la espera / los anuncios
        return strike('too-fast', { error: 'Checkpoint completado demasiado rápido.', wait: Math.max(1, Math.ceil(min - elapsed)) });
      if (cfg.provider !== 'asierkey') { // ¿ha vuelto realmente desde Linkvertise/Lootlabs?
        const rh = refHost(body.ref), good = refOk(cfg.provider, rh);
        await pipe([['LPUSH', 'log:ref', JSON.stringify({ t: Date.now(), p: cfg.provider, host: rh || '(vacío)', ok: good })], ['LTRIM', 'log:ref', 0, 99]]);
        if (!good && REF_MODE === 'strict')
          return strike('referrer:' + (rh || 'vacio'), { error: 'No hemos detectado que vengas del link de ' + NAMES[cfg.provider] + '. Pulsa Open y completa el link.' });
      }
      st.done += 1; st.tok = null;
      if (st.done >= cfg.n) {
        const key = genKey();
        st.key = key; st.expAt = Date.now() + cfg.ttl * 1000;
        await pipe([
          ['SET', 'kv:' + key, JSON.stringify({ id, hwid, expAt: st.expAt }), 'EX', cfg.ttl + 604800],
          ['SET', skey(id, hwid), JSON.stringify(st), 'EX', ST_EX]
        ]);
      } else await saveState(id, hwid, st);
      return out(200, { ok: true, done: st.done });
    }

    // ----- renovar (solo si la key ya caducó) -----
    if (route === 'renew') {
      if (needPost()) return;
      const k = String(body.k || ''), hwid = String(body.hwid || '');
      if (!OKID(k) || !OKH(hwid)) return out(400, { error: 'Link no válido.' });
      if (!(await rl(req, 'renew', 20, 300))) return TOO();
      if (!(await getj('key:' + k))) return out(404, { error: 'Este link de key no existe o fue revocado.' });
      const st = await getState(k, hwid);
      if (isLocked(st)) return out(403, { error: 'Checkpoints reiniciados: no puedes hacer otros hasta que tu key caduque.' });
      if (st.key && st.expAt > Date.now()) return out(400, { error: 'Tu key todavía no ha caducado.' });
      await saveState(k, hwid, { done: 0, strikes: 0 });
      return out(200, { ok: true });
    }

    // ----- verificar key (la llama tu script) -----
    // GET/POST /api/verify?k=ID_DEL_LINK&hwid=TU_HWID&key=ASIER-XXXX-XXXX-XXXX   (k es opcional)
    if (route === 'verify') {
      if (!(await rl(req, 'verify', 60, 60))) return out(429, { valid: false, status: 'rate_limited', message: 'Demasiados intentos.' });
      const key = String(q.key || body.key || '').trim().toUpperCase();
      const hwid = String(q.hwid || body.hwid || '');
      if (!OKKEY(key) || !OKH(hwid)) return out(200, { valid: false, status: 'invalid', message: 'Key no válida.' });
      const rec = await getj('kv:' + key);
      if (!rec) return out(200, { valid: false, status: 'invalid', message: 'Key no válida.' });
      const kk = String(q.k || body.k || '');
      if (kk && kk !== rec.id) return out(200, { valid: false, status: 'invalid', message: 'Key no válida.' });
      if (rec.hwid !== hwid) return out(200, { valid: false, status: 'hwid_mismatch', message: 'Esta key pertenece a otro dispositivo.' });
      if (!(await getj('key:' + rec.id))) return out(200, { valid: false, status: 'revoked', message: 'Esta key fue revocada.' });
      const left = Math.round((rec.expAt - Date.now()) / 1000);
      if (left <= 0) return out(200, { valid: false, status: 'expired', message: 'Tu key ha caducado. Entra en la página de tu key y pulsa Renovar.', expiredAgo: -left });
      return out(200, { valid: true, status: 'valid', expiresIn: left });
    }

    return out(404, { error: 'Ruta no encontrada.' });
  } catch (e) {
    return out(500, { error: 'Error del servidor: ' + (e && e.message ? e.message : e) });
  }
};
