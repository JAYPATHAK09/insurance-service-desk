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
 if(req.method==='POST' && body.sessionOnly===true){
  const {agent,a,b,mode}=body;
  if(!modes.includes(agent)||!['rules','claude'].includes(mode)||![a,b].every(x=>typeof x==='string'&&x.trim()&&x.length<=30000))throw Error('Supply two source texts up to 30,000 characters each.');
  const key=req.headers['x-model-key'];
  if(mode==='claude'&&(!key||typeof key!=='string'))throw Error('Enter your Claude API key.');
  const findings=mode==='rules'?offline(agent,a,b):await analyze(agent,a,b,key);
  return res.json({id:randomUUID(),agent,mode,findings,saved:false});
 }
 if(!token&&(process.env.VERCEL||process.env.DATABASE_URL||process.env.ANTHROPIC_API_KEY))return res.status(503).json({error:'Configure DESK_PASSWORD first.'});
 if(token&&!timingSafeEqual(hash(token),hash(String(req.headers['x-desk-password']||''))))return res.status(401).json({error:'Enter the workspace password.'});
 if(req.method==='PATCH'){
  if(!process.env.DATABASE_URL)throw Error('Connect Neon to record decisions.');
  const {id,decision,note}=body;
  if(!['Needs follow-up','Verified','Reopened'].includes(decision)||typeof note!=='string'||!note.trim()||note.length>2000)throw Error('Choose a decision and enter a note of up to 2,000 characters.');
  const [action]=await sql('INSERT INTO desk_review_actions(id,review_id,decision,note) VALUES($1,$2,$3,$4) RETURNING decision,note,created_at',[randomUUID(),id,decision,note.trim()]);
  return res.json(action);
 }
 if(req.method==='GET')return res.json({history:process.env.DATABASE_URL?await sql(`SELECT r.*, COALESCE((SELECT jsonb_agg(jsonb_build_object('decision',d.decision,'note',d.note,'created_at',d.created_at) ORDER BY d.created_at) FROM desk_review_actions d WHERE d.review_id=r.id),'[]'::jsonb) AS actions FROM desk_agent_reviews r ORDER BY r.created_at DESC LIMIT 30`):[],database:!!process.env.DATABASE_URL});
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
