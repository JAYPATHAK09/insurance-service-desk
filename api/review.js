import {modes,offline,analyze} from '../lib/engine.js';
import {randomUUID,timingSafeEqual,createHash} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest();
async function sql(query,params=[]){
 const db=new URL(process.env.DATABASE_URL);
 const response=await fetch('https://'+db.hostname+'/sql',{method:'POST',headers:{'Neon-Connection-String':db.href,'Content-Type':'application/json'},body:JSON.stringify({query,params})});
 if(!response.ok)throw Error('Database request failed. Check the Neon connection and apply schema.sql.');
 return (await response.json()).rows;
}
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 try{
 const body=req.body||{},token=process.env.DESK_PASSWORD;
 if(!token&&(process.env.VERCEL||process.env.DATABASE_URL||process.env.ANTHROPIC_API_KEY))return res.status(503).json({error:'Configure DESK_PASSWORD first.'});
 if(token&&!timingSafeEqual(hash(token),hash(String(req.headers['x-desk-password']||''))))return res.status(401).json({error:'Enter the workspace password.'});
 if(req.method==='GET')return res.json({history:process.env.DATABASE_URL?await sql('SELECT id, agent, mode, findings, created_at FROM desk_agent_reviews ORDER BY created_at DESC LIMIT 30'):[],database:!!process.env.DATABASE_URL});
 if(req.method!=='POST')return res.status(405).json({error:'Unsupported method'});
 const {agent,a,b,mode}=body;
 if(!modes.includes(agent)||!['rules','claude'].includes(mode)||![a,b].every(x=>typeof x==='string'&&x.trim()&&x.length<=30000))throw Error('Select a tool and supply two source texts under 30,001 characters each.');
 const key=req.headers['x-model-key']||process.env.ANTHROPIC_API_KEY;
 if(mode==='claude'&&!key)throw Error('Enter a Claude API key or configure the server key.');
 const findings=mode==='rules'?offline(agent,a,b):await analyze(agent,a,b,key),id=randomUUID();
 if(process.env.DATABASE_URL)await sql('INSERT INTO desk_agent_reviews(id,agent,mode,findings) VALUES($1,$2,$3,$4::jsonb)',[id,agent,mode,JSON.stringify(findings)]);
 res.json({id,agent,mode,findings,saved:!!process.env.DATABASE_URL});
 }catch(e){res.status(400).json({error:e.message})}
}
