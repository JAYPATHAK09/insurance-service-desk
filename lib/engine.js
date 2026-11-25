import fs from 'node:fs';
export const modes=['claim-query-reconciler','proposal-disclosure-checker','renewal-terms-reviewer'];
const states=JSON.parse(fs.readFileSync(new URL('../tools/states.json',import.meta.url)));
const normalize=s=>s.trim().toLowerCase().replace(/\s+/g,' ');
function fields(source){
 const result=new Map();
 for(const line of source.trim().split('\n')){
  const [name,...values]=line.split('|'),key=normalize(name);
  if(!key||!values.length||result.has(key))throw Error('Use one unique field | value per line.');
  result.set(key,{line,value:values.join('|').trim()});
 }return result;
}
export function offline(agent,a,b){
 const left=fields(a),right=fields(b),findings=[];
 for(const key of agent===modes[0]?left.keys():new Set([...left.keys(),...right.keys()])){
  const l=left.get(key),r=right.get(key);
  let status;
  if(agent===modes[0])status=!r?'missing':!r.value?'ambiguous':normalize(l.value)===normalize(r.value.split(' @ ')[0])&&r.value.split(' @ ')[1]?.trim()?'receipt located':'partial evidence';
  else status=!l?.value||!r?.value?(agent===modes[1]?'needs confirmation':'unconfirmed'):normalize(l.value)===normalize(r.value)?states[agent][0]:states[agent][1];
  findings.push({field:key,status,a_quote:l?.line||'',b_quote:r?.line||'',action:status==='receipt located'?'Verify that the receipt and submitted document satisfy the request.':'Review the paired evidence and record any correction.'});
 }return findings;
}
export async function analyze(agent,a,b,key){
 const instructions=fs.readFileSync(new URL('../.claude/agents/'+agent+'.md',import.meta.url),'utf8');
 const response=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':key,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model:process.env.ANTHROPIC_MODEL||'claude-sonnet-4-6',max_tokens:4096,system:instructions,messages:[{role:'user',content:JSON.stringify({case_id:'review',source_a:a,source_b:b})}]}),signal:AbortSignal.timeout(55000)});
 if(!response.ok)throw Error('Claude request failed (HTTP '+response.status+'). Check your key, model access and balance.');
 const data=await response.json(),report=JSON.parse(data.content.filter(x=>x.type==='text').map(x=>x.text).join('').trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/g,''));
 if(report.agent!==agent||report.case_id!=='review'||!Array.isArray(report.findings)||!report.findings.length||report.findings.some(x=>!states[agent].includes(x.status)||![x.field,x.action].every(y=>typeof y==='string'&&y.trim())||typeof x.a_quote!=='string'||typeof x.b_quote!=='string'||!(x.a_quote.trim()||x.b_quote.trim())||!a.includes(x.a_quote)||!b.includes(x.b_quote)))throw Error('Review failed evidence validation. Retry or review manually.');
 return report.findings;
}
