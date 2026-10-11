// POST /api/verify {email, code, newPassword?} -> {token,name}
const {crypto,redis,sha,hashPw,same}=require('./_lib');
const run=async(req,res)=>{
  if(req.method!=='POST')return res.status(405).json({error:'Método no permitido'});
  const b=req.body||{},email=String(b.email||'').trim().toLowerCase(),code=String(b.code||'');
  const t=await redis('INCR','tries:'+email);await redis('EXPIRE','tries:'+email,600);
  if(t>5)return res.status(429).json({error:'Demasiados intentos. Pide un código nuevo.'});
  const raw=await redis('GET','code:'+email);if(!raw)return res.status(400).json({error:'El código caducó. Pide uno nuevo.'});
  const c=JSON.parse(raw);if(!/^\d{6}$/.test(code)||!same(sha(code),c.h))return res.status(400).json({error:'Código incorrecto.'});
  const np=String(b.newPassword||'');
  if(c.m==='reset'&&np.length<8)return res.status(400).json({error:'La contraseña nueva debe tener al menos 8 caracteres.'});
  await redis('DEL','code:'+email);
  if(c.m==='register'){const p=await redis('GET','pend:'+email);if(!p)return res.status(400).json({error:'Registro caducado.'});await redis('SET','user:'+email,p);await redis('DEL','pend:'+email)}
  if(c.m==='reset')await redis('SET','user:'+email,JSON.stringify(hashPw(np)));
  const token=crypto.randomBytes(24).toString('hex');
  await redis('SET','adm:'+token,email,'EX',2592000);
  res.json({token,name:email});
};
module.exports=async(req,res)=>{try{await run(req,res)}catch(e){console.error('VERIFY ERROR',e);res.status(500).json({error:'Error del servidor: '+(e&&e.message||'desconocido')})}};
