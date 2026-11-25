import http from 'node:http';
import fs from 'node:fs';
import handler from './api/review.js';
http.createServer(async(req,res)=>{
 if(req.url==='/api/review'){
 res.status=n=>{res.statusCode=n;return res};res.json=o=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(o))};
 try{let data='';for await(const chunk of req){data+=chunk;if(data.length>300000)throw Error()}req.body=data?JSON.parse(data):{};await handler(req,res)}catch{res.status(400).json({error:'Invalid request'})}return}
 if(req.url!=='/'){res.writeHead(404).end();return}res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fs.readFileSync('public/index.html'));
}).listen(Number(process.env.PORT||3000),'127.0.0.1');
