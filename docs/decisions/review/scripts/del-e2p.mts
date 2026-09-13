import { importPrivateKey, signRequest } from '~/git/akl/aklgg/.claude/worktrees/ldb-arch-review/bot/src/client/sign.ts';
import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync(process.env.HOME + '/.config/aklgg/latency-client.env', 'utf8').split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const DB = 'https://akl-db.akl-58a.workers.dev'; const id = process.argv[2];
const key = await importPrivateKey(env.CLIENT_PRIVATE_KEY);
const rec = await (await fetch(`${DB}/v1/layouts/${id}?format=spark/1`)).json() as any;
if (rec.deleted) { console.log('already deleted'); process.exit(0); }
const h = await signRequest(key, env.CLIENT_ID, '184412255822020608', 'DELETE', `/v1/layouts/${id}`, undefined, Date.now());
const res = await fetch(`${DB}/v1/layouts/${id}`, { method: 'DELETE', headers: { ...h, 'If-Match': `layout:${rec.layout_rev}` } });
console.log('delete', res.status, (await res.text()).slice(0, 120));
