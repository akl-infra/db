import fs from 'node:fs';
function load(p){ const s=JSON.parse(fs.readFileSync(p,'utf8')); const f=s.snapshot.meta.node_fields; const ef=s.snapshot.meta.edge_fields; return {s,f,ef,w:f.length,ew:ef.length,types:s.snapshot.meta.node_types[0],etypes:s.snapshot.meta.edge_types[0]}; }
const A=load(process.argv[2]), B=load(process.argv[3]);
const idsA=new Set(); { const iI=A.f.indexOf('id'); for(let i=0;i<A.s.nodes.length;i+=A.w) idsA.add(A.s.nodes[i+iI]); }
const n=B.s.nodes, e=B.s.edges, st=B.s.strings; const iT=B.f.indexOf('type'), iN=B.f.indexOf('name'), iI=B.f.indexOf('id'), iE=B.f.indexOf('edge_count'), iS=B.f.indexOf('self_size');
const eT=B.ef.indexOf('type'), eN=B.ef.indexOf('name_or_index'), eTo=B.ef.indexOf('to_node');
// first edge offset per node
const N=n.length/B.w; const firstEdge=new Int32Array(N+1); { let off=0; for(let k=0;k<N;k++){ firstEdge[k]=off; off+=n[k*B.w+iE]*B.ew; } firstEdge[N]=off; }
// reverse edges for retainers
const retCount=new Int32Array(N); for(let k=0;k<N;k++){ for(let o=firstEdge[k];o<firstEdge[k+1];o+=B.ew){ const to=e[o+eTo]/B.w; retCount[to]++; } }
const retStart=new Int32Array(N+1); for(let k=0;k<N;k++) retStart[k+1]=retStart[k]+retCount[k];
const ret=new Int32Array(retStart[N]); const fill=new Int32Array(N); for(let k=0;k<N;k++){ for(let o=firstEdge[k];o<firstEdge[k+1];o+=B.ew){ const t=B.etypes[e[o+eT]]; if(t==='weak') continue; const to=e[o+eTo]/B.w; ret[retStart[to]+fill[to]++]=k*B.w+ (o<<0)*0; ret[retStart[to]+fill[to]-1]=k; } }
function name(k){ return B.types[n[k*B.w+iT]]+' '+st[n[k*B.w+iN]]; }
function sig(k){ const props=[]; for(let o=firstEdge[k];o<firstEdge[k+1]&&props.length<6;o+=B.ew){ const t=B.etypes[e[o+eT]]; if(t==='property') props.push(st[e[o+eN]]); } return props.join(','); }
const groups=new Map(); const sample=new Map();
for(let k=0;k<N;k++){ if(idsA.has(n[k*B.w+iI])) continue; const t=B.types[n[k*B.w+iT]]; if(t!=='object'&&t!=='array') continue; const key=name(k)+' {'+sig(k)+'}'; const g=groups.get(key)||{c:0,s:0}; g.c++; g.s+=n[k*B.w+iS]; groups.set(key,g); if(!sample.has(key)) sample.set(key,k); }
const rows=[...groups].sort((a,b)=>b[1].s-a[1].s).slice(0,15);
for(const [k,g] of rows){ console.log(String(g.s).padStart(9), String(g.c).padStart(7), k.slice(0,120)); }
// retainer chain for top 3 groups
function chain(k,depth){ const out=[]; let cur=k; const seen=new Set(); for(let d=0;d<depth;d++){ seen.add(cur); const rs=retStart[cur], re=retStart[cur+1]; if(rs===re) break; // pick a retainer that is not a new node if possible
 let pick=-1; for(let i=rs;i<re;i++){ const r=ret[i]; if(seen.has(r)) continue; if(idsA.has(n[r*B.w+iI])) { pick=r; break; } if(pick<0) pick=r; } if(pick<0) break; // find edge name
 let en='?'; for(let o=firstEdge[pick];o<firstEdge[pick+1];o+=B.ew){ if(e[o+eTo]/B.w===cur){ const t=B.etypes[e[o+eT]]; en=(t==='element'||t==='hidden')? '['+e[o+eN]+']' : st[e[o+eN]]; break; } }
 out.push(`${name(pick)} .${en}`); cur=pick; } return out; }
console.log('\nRETAINER CHAINS (leaf -> root):');
for(const [k] of rows.slice(0,5)){ console.log('\n== '+k.slice(0,100)); for(const l of chain(sample.get(k),14)) console.log('   <- '+l.slice(0,140)); }
