// Un solo archivo para: ping, google, create, list, delete, status, start, complete, renew, check
const {crypto,redis}=require('./_lib');
const E=process.env,CID=E.GOOGLE_CLIENT_ID||'383654977179-foddamf6uif2dv4fj8fa7b04hmc0ofgc.apps.googleusercontent.com';
const ADMINS=(E.ADMINS||'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean); // opcional: solo estos correos crean keys
const HOSTS={linkvertise:['linkvertise.com','link-to.net','direct-link.net','up-to-down.net','link-hub.net','link-target.net','link-center.net','link-depot.net','link-spot.net','link-place.net','file-link.net','filemedia.net'],lootlabs:['loot-link.com','loot-links.com','lootlinks.co','lootdest.com','lootdest.org','lootdest.info','lootlabs.gg'],rekonise:['rekonise.com']};
const inHost=(p,h)=>HOSTS[p].some(d=>h===d||h.endsWith('.'+d));
const hostOf=u=>{try{return new URL(u).hostname.replace(/^www\./,'').toLowerCase()}catch(e){return ''}};
const okLink=(p,u)=>{try{return new URL(u).protocol==='https:'&&inHost(p,hostOf(u))}catch(e){return false}};
const rid=n=>crypto.randomBytes(n).toString('hex');
const bad=(res,m,c=400)=>res.status(c).json({error:m});
const J=async k=>{const v=await redis('GET',k);return v?JSON.parse(v):null};
const S=(k,v,ex)=>ex?redis('SET',k,JSON.stringify(v),'EX',ex):redis('SET',k,JSON.stringify(v));
const log=async(o,l,x)=>{await redis('LPUSH',l+':'+o,JSON.stringify(x));await redis('LTRIM',l+':'+o,0,29);
  if(l==='lbyp'&&E.DISCORD_WEBHOOK)await fetch(E.DISCORD_WEBHOOK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:'⚠️ Bypass en AsierKey: '+x.reason+' · HWID '+String(x.hwid).slice(0,10)})}).catch(()=>{})};
const okId=v=>typeof v==='string'&&/^[\w-]{4,64}$/.test(v);
const who=async req=>{const t=(req.headers.authorization||'').replace('Bearer ','');return /^[0-9a-f]{48}$/.test(t)?redis('GET','adm:'+t):null};
const H={
ping:async(q,res)=>res.json({ok:true,upstash:!!(E.UPSTASH_REDIS_REST_URL||E.KV_REST_API_URL)}),
google:async(q,res)=>{
  const r=await fetch('https://oauth2.googleapis.com/tokeninfo?id_token='+encodeURIComponent(String((q.body||{}).credential||'')));const d=await r.json();
  if(!r.ok||d.aud!==CID||d.email_verified!=='true')return bad(res,'Google no válido.',401);
  const email=d.email.toLowerCase(),token=rid(24);await redis('SET','adm:'+token,email,'EX',2592000);
  res.json({token,name:d.name||email,email});
},
create:async(q,res,me)=>{
  const {provider,ttl,n,links}=q.body||{};
  if(!HOSTS[provider]&&provider!=='asierkey')return bad(res,'Proveedor no válido.');
  if(!(ttl>=60&&ttl<=2592000)||!(n>=1&&n<=3))return bad(res,'Tiempo o checkpoints no válidos.');
  let L=[];if(provider!=='asierkey'){L=(links||[]).slice(0,n);if(L.length<n||!L.every(u=>okLink(provider,u)))return bad(res,'Links no válidos.')}
  if((await redis('SCARD','own:'+me))>=50)return bad(res,'Máximo 50 links.');
  const rc=await redis('INCR','rlc:'+me);if(rc===1)await redis('EXPIRE','rlc:'+me,3600);
  if(rc>10)return bad(res,'Has creado demasiados links seguidos. Espera un rato (máximo 10 por hora).',429);
  const id=rid(5);await S('link:'+id,{id,owner:me,provider,n,ttl,links:L});await redis('SADD','own:'+me,id);res.json({id});
},
list:async(q,res,me)=>{
  const ids=(await redis('SMEMBERS','own:'+me))||[],items=[];
  for(const id of ids){const l=await J('link:'+id);if(l)items.push({id,provider:l.provider,n:l.n,ttl:l.ttl,players:await redis('SCARD','players:'+id)})}
  const g=async k=>((await redis('LRANGE',k,0,29))||[]).map(x=>JSON.parse(x));
  const stats={links:items.length,players:items.reduce((a,i)=>a+i.players,0),keys:+(await redis('GET','kc:'+me))||0,bypass:await redis('LLEN','lbyp:'+me)};
  res.json({items,stats,banned:await redis('SMEMBERS','ban:'+me),logs:{mode:E.REF_STRICT==='1'?'strict':'log',ref:await g('lref:'+me),bypass:await g('lbyp:'+me)}});
},
ban:async(q,res,me)=>{const h=(q.body||{}).hwid;if(!okId(h))return bad(res,'HWID no válido.');await redis('SADD','ban:'+me,h);res.json({ok:true})},
unban:async(q,res,me)=>{const h=(q.body||{}).hwid;if(!okId(h))return bad(res,'HWID no válido.');await redis('SREM','ban:'+me,h);res.json({ok:true})},
delete:async(q,res,me)=>{
  const id=(q.body||{}).id,l=okId(id)&&await J('link:'+id);
  if(!l||l.owner!==me)return bad(res,'No encontrado.',404);
  await redis('DEL','link:'+id);await redis('SREM','own:'+me,id);res.json({ok:true});
},
status:async(q,res)=>{
  const {hwid,k}=q.query,l=okId(k)&&okId(hwid)&&await J('link:'+k);
  if(!l)return res.json({error:'Link no válido.',total:3,done:0});
  const s=(await J('ps:'+k+':'+hwid))||{done:0};
  res.json({total:l.n,done:s.done,locked:!!s.key,key:s.key||null,expiresIn:s.key?Math.max(0,Math.round((s.exp-Date.now())/1000)):0});
},
start:async(q,res)=>{
  const {k,hwid,env}=q.body||{},l=okId(k)&&okId(hwid)&&await J('link:'+k);
  if(!l)return bad(res,'Link no válido.');
  if(await redis('SISMEMBER','ban:'+l.owner,hwid))return bad(res,'Tu dispositivo está bloqueado.',403);
  const s=(await J('ps:'+k+':'+hwid))||{done:0};
  if(s.key)return bad(res,'Ya tienes una key.');
  if(env&&env.wd){await log(l.owner,'lbyp',{t:Date.now(),reason:'webdriver',hwid});return bad(res,'Navegador automatizado no permitido.',403)}
  const own=l.provider==='asierkey',min=own?15:12,token=rid(16);
  await S('tok:'+token,{k,hwid,t0:Date.now(),min,p:l.provider},3600);
  res.json(own?{token,min}:{token,url:l.links[s.done]});
},
complete:async(q,res)=>{
  const tk=String((q.body||{}).token||''),t=/^[0-9a-f]{32}$/.test(tk)&&await J('tok:'+tk);
  if(!t)return bad(res,'Checkpoint no válido o caducado. Pulsa Open otra vez.');
  await redis('DEL','tok:'+tk); // un solo uso
  const l=await J('link:'+t.k);if(!l)return bad(res,'Link no válido.');
  if(await redis('SISMEMBER','ban:'+l.owner,t.hwid))return bad(res,'Tu dispositivo está bloqueado.',403);
  const wait=Math.ceil((t.t0+t.min*1000-Date.now())/1000);
  if(wait>0){await log(l.owner,'lbyp',{t:Date.now(),reason:'demasiado rápido',hwid:t.hwid});return res.status(425).json({error:'Checkpoint completado demasiado rápido.',wait})}
  if(t.p!=='asierkey'){
    const host=hostOf((q.body||{}).ref||''),ok=!!host&&inHost(t.p,host);
    await log(l.owner,'lref',{t:Date.now(),p:t.p,host:host||'(sin origen)',ok});
    if(!ok&&E.REF_STRICT==='1')return bad(res,'Origen no válido.',403);
  }
  const sk='ps:'+t.k+':'+t.hwid,s=(await J(sk))||{done:0};
  if(s.key)return bad(res,'Ya tienes una key.');
  s.done=Math.min(l.n,s.done+1);
  if(s.done>=l.n){s.key='AK-'+rid(3).toUpperCase()+'-'+rid(3).toUpperCase()+'-'+rid(3).toUpperCase();s.exp=Date.now()+l.ttl*1000;
    await S('keyidx:'+s.key,{hwid:t.hwid,exp:s.exp},l.ttl+60);await redis('INCR','kc:'+l.owner)}
  await S(sk,s);await redis('SADD','players:'+t.k,t.hwid);res.json({ok:true});
},
renew:async(q,res)=>{
  const {k,hwid}=q.body||{};if(!okId(k)||!okId(hwid))return bad(res,'Datos no válidos.');
  const s=await J('ps:'+k+':'+hwid);
  if(s&&s.key&&s.exp>Date.now())return bad(res,'Tu key aún no caduca.');
  await redis('DEL','ps:'+k+':'+hwid);res.json({ok:true});
},
check:async(q,res)=>{ // para tu script: GET /api/check?key=AK-...&hwid=... (hwid opcional)
  const {key,hwid}=q.query,x=okId(key)&&await J('keyidx:'+key);
  res.json({valid:!!(x&&(!hwid||x.hwid===hwid)&&x.exp>Date.now()),expiresIn:x?Math.max(0,Math.round((x.exp-Date.now())/1000)):0});
}};
const PUB=['ping','google','status','start','complete','renew','check'];
module.exports=async(req,res)=>{try{
  const a=req.query.action,f=Object.prototype.hasOwnProperty.call(H,a)&&H[a];if(!f)return bad(res,'No existe.',404);
  let me=null;if(!PUB.includes(a)){me=await who(req);if(!me)return bad(res,'No autorizado.',401);if(ADMINS.length&&!ADMINS.includes(me))return bad(res,'No tienes permiso.',403)}
  await f(req,res,me);
}catch(e){console.error(e);bad(res,'Error del servidor: '+(e.message||''),500)}};
