// POST /api/verify {email, code} -> {token,name}
const {crypto,redis,sha,same}=require('./_lib');
const run=async(req,res)=>{
  if(req.method!=='POST')return res.status(405).json({error:'Método no permitido'});
  const email=String((req.body||{}).email||'').trim().toLowerCase(),code=String((req.body||{}).code||'');
  const t=await redis('INCR','tries:'+email);await redis('EXPIRE','tries:'+email,600);
  if(t>5)return res.status(429).json({error:'Demasiados intentos. Pide un código nuevo.'});
  const raw=await redis('GET','code:'+email);if(!raw)return res.status(400).json({error:'El código caducó. Pide uno nuevo.'});
  const c=JSON.parse(raw);if(!/^\d{6}$/.test(code)||!same(sha(code),c.h))return res.status(400).json({error:'Código incorrecto.'});
  await redis('DEL','code:'+email);
  if(c.m==='register'){const p=await redis('GET','pend:'+email);if(!p)return res.status(400).json({error:'Registro caducado.'});await redis('SET','user:'+email,p);await redis('DEL','pend:'+email)}
  const token=crypto.randomBytes(24).toString('hex');
  await redis('SET','adm:'+token,email,'EX',2592000); // ⚠️ usa el MISMO formato que tu /api/login actual
  res.json({token,name:email});
};
module.exports=async(req,res)=>{try{await run(req,res)}catch(e){console.error('AUTH ERROR',e);res.status(500).json({error:'Error del servidor: '+(e&&e.message||'desconocido')})}};
