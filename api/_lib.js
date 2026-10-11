const crypto=require('crypto');
const E=process.env,U=E.UPSTASH_REDIS_REST_URL||E.KV_REST_API_URL,T=E.UPSTASH_REDIS_REST_TOKEN||E.KV_REST_API_TOKEN;
const redis=async(...c)=>(await(await fetch(U,{method:'POST',headers:{Authorization:'Bearer '+T},body:JSON.stringify(c)})).json()).result;
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const hashPw=(p,salt=crypto.randomBytes(16).toString('hex'))=>({salt,hash:crypto.scryptSync(p,salt,64).toString('hex')});
const same=(a,b)=>a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
module.exports={crypto,redis,sha,hashPw,same};
