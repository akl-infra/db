import { importPrivateKey, signRequest } from '~/git/akl/aklgg/.claude/worktrees/ldb-arch-review/bot/src/client/sign.ts';
import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync(process.env.HOME + '/.config/aklgg/latency-client.env', 'utf8').split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const DB = 'https://akl-db.akl-58a.workers.dev';
const ACTOR = '184412255822020608';
const LINE = '2cb8a634dffbebc1469476d4c4c1f011bba0e194215f1c1f65dbadddf3654024';
const ORIGIN = 'https://pub-bba1babff00548f4b9960b17c1d898ea.r2.dev';
const key = await importPrivateKey(env.CLIENT_PRIVATE_KEY);
async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const buf = body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(body));
  const h = await signRequest(key, env.CLIENT_ID, ACTOR, method, path, buf, Date.now());
  const res = await fetch(DB + path, { method, headers: { ...h, 'Content-Type': 'application/json', ...extra }, body: buf });
  return { status: res.status, json: await res.json().catch(() => null) as any };
}
const src = await (await fetch(`${DB}/v1/layouts/colemak?format=spark/1`)).json() as any;
const name = `lead-e2p-${Date.now().toString(36)}`;
const t0 = Date.now();
const created = await call('POST', '/v1/layouts', { name, format: 'spark/1', payload: src.payload });
const tCreate = Date.now() - t0;
console.log('create', created.status, created.json?.id, `${tCreate}ms`);
if (created.status !== 201) { console.log(JSON.stringify(created.json).slice(0, 300)); process.exit(1); }
const id = created.json.id as string;
const meta = await (await fetch(`${DB}/v1/meta`)).json() as any;
console.log('layoutdb head after create', meta.seq);
let seen = false; let tPtr = 0; let ptr: any = null;
for (let i = 0; i < 240 && !seen; i++) {
  ptr = await (await fetch(`${ORIGIN}/lines/${LINE}/current.json`, { cache: 'no-store' })).json();
  if (ptr.overlay) {
    const lay = await (await fetch(`${ORIGIN}/o/${ptr.overlay}/layouts.json`, { cache: 'no-store' })).json() as any;
    const rows = Array.isArray(lay) ? lay : Object.values(lay?.layouts ?? lay ?? {});
    seen = rows.some((r: any) => r && (r._dbId === id || r.id === id || r.name === name)) || (typeof lay === 'object' && lay !== null && (id in lay || name in lay));
  }
  if (seen) { tPtr = Date.now() - t0; break; }
  await new Promise(r => setTimeout(r, 5000));
}
console.log(seen ? `visible in overlay after ${tPtr}ms (pointer db_seq ${ptr.db_seq}, synced_at ${ptr.synced_at})` : 'NOT visible within 20 min');
const rec = await (await fetch(`${DB}/v1/layouts/${id}?format=spark/1`)).json() as any;
const del = await call('DELETE', `/v1/layouts/${id}`, undefined, { 'If-Match': `layout:${rec.layout_rev}` });
console.log('delete', del.status);
