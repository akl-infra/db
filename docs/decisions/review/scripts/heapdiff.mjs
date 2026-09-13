// summarize a V8 .heapsnapshot by (type,name): count + self_size; diff two.
import fs from 'node:fs';
function load(p){ const s=JSON.parse(fs.readFileSync(p,'utf8')); const f=s.snapshot.meta.node_fields; const n=s.nodes; const st=s.strings; const types=s.snapshot.meta.node_types[0];
 const iT=f.indexOf('type'), iN=f.indexOf('name'), iS=f.indexOf('self_size'); const w=f.length; const m=new Map(); let total=0;
 for(let i=0;i<n.length;i+=w){ const t=types[n[i+iT]]; let name=st[n[i+iN]]; if(t==='string'||t==='concatenated string'||t==='sliced string') name='(string)'; if(t==='code'||t==='closure') name=t+':'+name; const k=t+' '+name; const e=m.get(k)||{c:0,s:0}; e.c++; e.s+=n[i+iS]; total+=n[i+iS]; m.set(k,e);} return {m,total}; }
const [a,b]=process.argv.slice(2).map(load);
console.log('total self bytes', a.total, '->', b.total, 'delta', b.total-a.total);
const rows=[]; for(const [k,e] of b.m){ const p=a.m.get(k)||{c:0,s:0}; rows.push({k,dc:e.c-p.c,ds:e.s-p.s,c:e.c,s:e.s}); }
rows.sort((x,y)=>y.ds-x.ds); console.log('\nTOP by size growth'); for(const r of rows.slice(0,25)) console.log(String(r.ds).padStart(10), String(r.dc).padStart(8), String(r.s).padStart(10), r.k.slice(0,90));
rows.sort((x,y)=>y.dc-x.dc); console.log('\nTOP by count growth'); for(const r of rows.slice(0,25)) console.log(String(r.dc).padStart(8), String(r.ds).padStart(10), r.k.slice(0,90));
