// POST /api/auth {mode:'login'|'register', email, password} -> {token,name}
const {crypto,redis,hashPw,same}=require('./_lib');
const run=async(req,res)=>{
  if(req.method!=='POST')return res.status(405).json({error:'Método no permitido'});
  const {mode,email:e0,password}=req.body||{},email=String(e0||'').trim().toLowerCase();
  if(!['login','register'].includes(mode)||!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)||typeof password!=='string'||!password||password.length>200)return res.status(400).json({error:'Datos no válidos.'});
  const n=await redis('INCR','rl:'+email);if(n===1)await redis('EXPIRE','rl:'+email,600);
  if(n>6)return res.status(429).json({error:'Demasiados intentos. Espera unos minutos.'});
  const raw=await redis('GET','user:'+email),user=raw&&JSON.parse(raw);
  if(mode==='register'){
    if(user)return res.status(409).json({error:'Ese correo ya está registrado. Inicia sesión.'});
    if(password.length<8)return res.status(400).json({error:'La contraseña debe tener al menos 8 caracteres.'});
    await redis('SET','user:'+email,JSON.stringify(hashPw(password)));
  }else{
    if(!user||!same(hashPw(password,user.salt).hash,user.hash))return res.status(401).json({error:'Correo o contraseña incorrectos.'});
  }
  const token=crypto.randomBytes(24).toString('hex');
  await redis('SET','adm:'+token,email,'EX',2592000);
  res.json({token,name:email});
};
module.exports=async(req,res)=>{try{await run(req,res)}catch(e){console.error('AUTH ERROR',e);res.status(500).json({error:'Error del servidor: '+(e&&e.message||'desconocido')})}};
