import { Redis } from '@upstash/redis';
const redis = Redis.fromEnv();

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Verificar token de admin (igual que en tus otras rutas)
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (!auth) return res.status(401).json({ error: 'No autorizado' });
  const stored = await redis.get('ak_token:' + auth);
  if (!stored) return res.status(401).json({ error: 'Token inválido' });

  const { id, action } = req.body;
  if (!id || !['kill', 'reactivate'].includes(action))
    return res.status(400).json({ error: 'Parámetros inválidos' });

  // Verificar que la key pertenece a este admin
  const key = await redis.hgetall('ak_key:' + id);
  if (!key) return res.status(404).json({ error: 'Key no encontrada' });
  if (key.owner !== stored.email)
    return res.status(403).json({ error: 'No es tuya' });

  // Activar o desactivar kill switch
  await redis.hset('ak_key:' + id, { killed: action === 'kill' ? '1' : '0' });

  return res.status(200).json({ ok: true });
}
