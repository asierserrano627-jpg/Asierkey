// POST /api/auth {mode:'login'|'register'|'reset', email, password, cf, resend}
const {crypto,redis,sha,hashPw,same}=require('./_lib');
const E=process.env;
const body=c=>`Hola,\n\nHemos recibido una solicitud para entrar en AsierKey con este correo.\n\nTU CÓDIGO DE VERIFICACIÓN:\n\n        ${c}\n\nEscríbelo en la página para continuar. Caduca en 10 minutos y solo se puede usar una vez.\n\nPor tu seguridad:\n- Nunca compartas este código con nadie. El equipo de AsierKey jamás te lo pedirá.\n- Si no fuiste tú, ignora este mensaje: nadie podrá entrar sin el código.\n- Si recibes muchos correos así sin haberlos pedido, cambia tu contraseña.\n\nGracias por usar AsierKey.\n— El equipo de AsierKey`;
const send=async(to,code)=>{
  const subject='Tu código de AsierKey: '+code,text=body(code);
  if(E.GMAIL_USER&&E.GMAIL_PASS){ // gratis: Gmail con contraseña de aplicación
    await require('nodemailer').createTransport({service:'gmail',auth:{user:E.GMAIL_USER,pass:E.GMAIL_PASS}}).sendMail({from:'AsierKey <'+E.GMAIL_USER+'>',to,subject,text});return '';
  }
  const m=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+E.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:E.MAIL_FROM,to,subject,text})});
  if(m.ok)return '';let t='';try{t=(await m.json()).message||''}catch(e){}return t||'error';
};
const run=async(req,res)=>{
  if(req.method!=='POST')return res.status(405).json({error:'Método no permitido'});
  const {mode,email:e0,password,cf,resend}=req.body||{},email=String(e0||'').trim().toLowerCase();
  if(!['login','register','reset'].includes(mode)||!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)||(mode!=='reset'&&(typeof password!=='string'||!password||password.length>200)))return res.status(400).json({error:'Datos no válidos.'});
  if(E.TURNSTILE_SECRET&&mode==='register'&&!(resend&&await redis('EXISTS','pend:'+email))){
    const r=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({secret:E.TURNSTILE_SECRET,response:String(cf||'')})});
    if(!(await r.json()).success)return res.status(400).json({error:'Verifica que no eres un robot.'});
  }
  const n=await redis('INCR','rl:'+email);if(n===1)await redis('EXPIRE','rl:'+email,600);
  if(n>6)return res.status(429).json({error:'Demasiados intentos. Espera unos minutos.'});
  const raw=await redis('GET','user:'+email),user=raw&&JSON.parse(raw);
  if(mode==='register'){
    if(user)return res.status(409).json({error:'Ese correo ya está registrado. Inicia sesión.'});
    if(password.length<8)return res.status(400).json({error:'La contraseña debe tener al menos 8 caracteres.'});
    await redis('SET','pend:'+email,JSON.stringify(hashPw(password)),'EX',600);
  }else if(mode==='login'){
    if(!user||!same(hashPw(password,user.salt).hash,user.hash))return res.status(401).json({error:'Correo o contraseña incorrectos.'});
  }else if(!user)return res.json({ok:true}); // reset: no revelamos si existe
  const code=String(crypto.randomInt(0,1000000)).padStart(6,'0');
  await redis('SET','code:'+email,JSON.stringify({h:sha(code),m:mode}),'EX',600);await redis('DEL','tries:'+email);
  const err=await send(email,code);if(err){console.error('MAIL',err);return res.status(502).json({error:'No se pudo enviar el correo. '+err})}
  res.json({ok:true});
};
module.exports=async(req,res)=>{try{await run(req,res)}catch(e){console.error('AUTH ERROR',e);res.status(500).json({error:'Error del servidor: '+(e&&e.message||'desconocido')})}};
