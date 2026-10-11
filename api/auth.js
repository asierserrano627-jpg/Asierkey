// POST /api/auth {mode:'login'|'register', email, password} -> envía el código por correo
const {crypto,redis,sha,hashPw,same}=require('./_lib');
const mail=(to,code)=>fetch('https://api.resend.com/emails',{method:'POST',
  headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json'},
  body:JSON.stringify({from:process.env.MAIL_FROM,to,subject:'Tu código de AsierKey: '+code,
  text:`Hola,\n\nHemos recibido una solicitud para entrar en AsierKey con este correo.\n\nTU CÓDIGO DE VERIFICACIÓN:\n\n        ${code}\n\nEscríbelo en la página para continuar. Caduca en 10 minutos y solo se puede usar una vez.\n\nPor tu seguridad:\n- Nunca compartas este código con nadie. El equipo de AsierKey jamás te lo pedirá.\n- Si no fuiste tú, ignora este mensaje: nadie podrá entrar sin el código.\n- Si recibes muchos correos así sin haberlos pedido, cambia tu contraseña.\n\nGracias por usar AsierKey.\n— El equipo de AsierKey`})});
const run=async(req,res)=>{
  if(req.method!=='POST')return res.status(405).json({error:'Método no permitido'});
  const {mode,email:e0,password}=req.body||{},email=String(e0||'').trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)||typeof password!=='string'||password.length<1||password.length>200)return res.status(400).json({error:'Datos no válidos.'});
  const n=await redis('INCR','rl:'+email);if(n===1)await redis('EXPIRE','rl:'+email,600);
  if(n>5)return res.status(429).json({error:'Demasiados intentos. Espera unos minutos.'});
  const raw=await redis('GET','user:'+email),user=raw&&JSON.parse(raw);
  if(mode==='register'){
    if(user)return res.status(409).json({error:'Ese correo ya está registrado. Inicia sesión.'});
    if(password.length<8)return res.status(400).json({error:'La contraseña debe tener al menos 8 caracteres.'});
    await redis('SET','pend:'+email,JSON.stringify(hashPw(password)),'EX',600);
  }else{
    if(!user||!same(hashPw(password,user.salt).hash,user.hash))return res.status(401).json({error:'Correo o contraseña incorrectos.'});
  }
  const code=String(crypto.randomInt(0,1000000)).padStart(6,'0');
  await redis('SET','code:'+email,JSON.stringify({h:sha(code),m:mode}),'EX',600);await redis('DEL','tries:'+email);
  const m=await mail(email,code);if(!m.ok){let t='';try{t=(await m.json()).message||''}catch(e){}console.error('RESEND',m.status,t);return res.status(502).json({error:'No se pudo enviar el correo. '+t})}
  res.json({ok:true});
};
module.exports=async(req,res)=>{try{await run(req,res)}catch(e){console.error('AUTH ERROR',e);res.status(500).json({error:'Error del servidor: '+(e&&e.message||'desconocido')})}};
