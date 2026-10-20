import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.js';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cuas-srv-'));
const DIST = path.join(TMP, 'dist');
fs.mkdirSync(DIST);
fs.writeFileSync(path.join(DIST, 'index.html'), '<h1>game</h1>');
fs.writeFileSync(path.join(DIST, 'dashboard.html'), '<h1>dash</h1>');
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
const srv = createServer({ dataDir: path.join(TMP, 'data'), distDir: DIST, instructorCode: 'INSTR-CODE-1' });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
class Client { constructor() { this.cookie = ''; }
  async call(method, path, body, headers = {}) {
    const r = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
    const ct = r.headers.get('content-type') || ''; const data = ct.includes('json') ? await r.json() : await r.text();
    return { status: r.status, data, headers: r.headers };
  } }
const mkSession = (over = {}) => ({
  scenarioId: 'S1', scenarioName: 'First contact', difficulty: 2, env: 'day', sensors: { radar: 'full', iff: 'ok' }, terrain: 'urban', startedAt: new Date(Date.now() - Math.random() * 1e6).toISOString(), duration: 100, reason: 'complete', shots: 8, hits: 4, falseAlarms: 0,
  contacts: [
    { id: 'T01', kind: 'quad', truth: 'ATTACK', origin: 'behind', tSpawn: 10, tObs: 14, tDes: 15, guess: 'ATTACK', engaged: true, engageT: 17, engageRange: 30, guessAtEngage: 'ATTACK', outcome: 'neutralized', eta: 22 },
    { id: 'T02', kind: 'civil', truth: 'CIVILIAN', origin: 'sky', tSpawn: 30, tObs: 31, tDes: 33, guess: 'RECON', engaged: false, outcome: 'expired' },
  ], events: [{ t: 10, type: 'launch', id: 'T01', truth: 'ATTACK', origin: 'behind' }], ...over });

// --- accounts
const ins = new Client(), tr1 = new Client(), tr2 = new Client(), other = new Client(), anon = new Client();
let r = await anon.call('POST', '/api/register', { username: 'maj.rao', name: 'Maj Rao', password: 'longpassword1', role: 'instructor', instructorCode: 'WRONG', unitName: '1 Coy' });
ok(r.status === 403, 'instructor registration refused with the wrong code');
r = await anon.call('POST', '/api/register', { username: 'maj.rao', name: 'Maj Rao', password: 'longpassword1', role: 'instructor', instructorCode: 'wrong-multibyte-é', unitName: '1 Coy' });
ok(r.status === 403, 'a multibyte code guess is refused cleanly (no 500)');
r = await ins.call('POST', '/api/register', { username: 'maj.rao', name: 'Maj Rao', password: 'longpassword1', role: 'instructor', instructorCode: 'INSTR-CODE-1', unitName: '1 Coy' });
ok(r.status === 200 && r.data.user.role === 'instructor' && r.data.user.unit.joinCode.length === 6, `instructor created a unit, join code ${r.data.user?.unit?.joinCode}`);
const JOIN = r.data.user.unit.joinCode;
ok(/HttpOnly/.test(r.headers.get('set-cookie')) && /SameSite=Strict/.test(r.headers.get('set-cookie')), 'session cookie is HttpOnly + SameSite=Strict');
r = await tr1.call('POST', '/api/register', { username: 'sep.kumar', name: '=HYPERLINK("http://x")', password: 'password123', joinCode: JOIN.toLowerCase() });
ok(r.status === 200 && r.data.user.unit?.name === '1 Coy' && r.data.user.role === 'trainee', 'trainee joined the unit by join code (case-insensitive)');
r = await tr2.call('POST', '/api/register', { username: 'sep.singh', name: 'Sep Singh', password: 'password123', joinCode: JOIN });
ok(r.status === 200, 'second trainee registered');
r = await other.call('POST', '/api/register', { username: 'cpl.other', name: 'Cpl Other', password: 'password123' });
ok(r.status === 200 && r.data.user.unit === null, 'trainee with no code is unaffiliated');
for (const [b, why] of [[{ username: 'ab', name: 'x', password: 'password123' }, 'short username'], [{ username: 'okname', name: 'x', password: 'short' }, 'short password'], [{ username: 'okname2', name: 'x', password: 'password123', joinCode: 'NOPE00' }, 'bad join code'], [{ username: 'sep.kumar', name: 'x', password: 'password123' }, 'duplicate username (409)']]) {
  r = await new Client().call('POST', '/api/register', b); ok(r.status >= 400 && r.status < 500, `rejected: ${why} -> ${r.status}`);
}
r = await new Client().call('POST', '/api/register', { username: 'x'.repeat(5), name: 'x', password: 'password123' }, { Origin: 'http://evil.example' });
ok(r.status === 403, 'cross-origin POST refused');
r = await new Client().call('POST', '/api/register', { username: 'nullorigin', name: 'x', password: 'password123' }, { Origin: 'null' });
ok(r.status === 403, "Origin: null refused cleanly (not a 500)");

// --- login, lockout, logout
const t = new Client();
r = await t.call('POST', '/api/login', { username: 'sep.kumar', password: 'wrongwrong' }); ok(r.status === 401, 'wrong password -> 401');
r = await t.call('POST', '/api/login', { username: 'nobody', password: 'wrongwrong' }); ok(r.status === 401 && r.data.error === 'Wrong username or password.', 'unknown user gets the same message');
r = await t.call('POST', '/api/login', { username: 'sep.kumar', password: 'password123' }); ok(r.status === 200, 'correct login');
r = await t.call('GET', '/api/me'); ok(r.status === 200 && r.data.user.username === 'sep.kumar', '/api/me with the cookie');
r = await t.call('POST', '/api/logout', {}); r = await t.call('GET', '/api/me'); ok(r.status === 401, 'logout kills the session');
let locked = false; for (let i = 0; i < 9; i++) { r = await new Client().call('POST', '/api/login', { username: 'sep.singh', password: 'bad-password' }); if (r.status === 429) locked = true; }
ok(locked, 'repeated failures lock the account / rate limit');

// --- sessions: server re-scores, validates
r = await tr1.call('GET', '/api/me'); ok(r.status === 200, 'still signed in (cookie client)');
r = await tr1.call('POST', '/api/sessions', { session: { ...mkSession(), score: 100, m: { score: 100 } } });
ok(r.status === 200 && r.data.summary.score < 100, `client-claimed score 100 ignored; server scored it ${r.data.summary?.score}`);
const sid = r.data.id;
const first = mkSession(); r = await tr1.call('POST', '/api/sessions', { session: first }); const again = await tr1.call('POST', '/api/sessions', { session: first });
ok(again.data.duplicate === true && again.data.id === r.data.id, 'resubmitting the same session is idempotent');
r = await tr1.call('POST', '/api/sessions', { session: { ...mkSession(), contacts: [] } }); ok(r.status === 400, 'empty session rejected');
r = await tr1.call('POST', '/api/sessions', { session: { ...mkSession(), contacts: [{ truth: 'DRAGON' }] } }); ok(r.status === 400, 'unknown contact class rejected');
const evil = mkSession(); evil.contacts[0].tDes = 'NaN'; evil.contacts[0].tSpawn = 1e12; evil.shots = -5; evil.difficulty = 99; evil.env = '<script>';
r = await tr1.call('POST', '/api/sessions', { session: evil });
ok(r.status === 200, 'out-of-range numbers are clamped, not trusted'); const det = await tr1.call('GET', `/api/sessions/${r.data.id}`);
ok(det.data.session.difficulty === 10 && det.data.session.env === 'day' && det.data.session.shots === 0 && det.data.session.contacts[0].tSpawn === 3600, 'clamped: difficulty 10, env fell back to day, shots 0, tSpawn 3600');
r = await tr1.call('POST', '/api/sessions', { session: { ...mkSession(), padding: 'x'.repeat(700 * 1024) } }); ok(r.status === 413, 'oversized body -> 413');
r = await anon.call('POST', '/api/sessions', { session: mkSession() }); ok(r.status === 401, 'unauthenticated submit -> 401');
r = await tr1.call('GET', '/api/sessions'); ok(r.data.sessions.length === 3, `trainee lists own sessions (${r.data.sessions.length})`);
r = await tr1.call('GET', `/api/sessions/${sid}`); ok(r.status === 200 && Array.isArray(r.data.coach) && r.data.metrics.perContact.length === 2, 'session detail has per-contact path + coaching');

// --- adaptive next
r = await tr2.call('GET', '/api/next'); ok(r.data.difficulty === 1 && r.data.scripted === 'S1', 'new trainee: difficulty 1, scripted S1');
r = await tr1.call('GET', '/api/next'); ok(typeof r.data.difficulty === 'number' && r.data.reason, `trainee with history: ${r.data.reason}`);
for (let i = 0; i < 3; i++) await tr2.call('POST', '/api/sessions', { session: mkSession({ contacts: [{ ...mkSession().contacts[0] }], difficulty: 3 }) });
r = await tr2.call('GET', '/api/next'); ok(r.data.difficulty === 5, `three strong sessions at D3 -> D${r.data.difficulty} recommended`);

// --- authorisation
r = await tr1.call('GET', '/api/unit'); ok(r.status === 403, 'trainee cannot open the unit view');
r = await anon.call('GET', '/api/unit'); ok(r.status === 401, 'anonymous cannot open the unit view');
r = await ins.call('GET', '/api/unit');
ok(r.status === 200 && r.data.roster.length === 2 && r.data.totals.sessions === 6, `instructor sees own unit: ${r.data.roster.length} trainees, ${r.data.totals.sessions} sessions`);
ok(!JSON.stringify(r.data).includes('pw') && !JSON.stringify(r.data).includes('scrypt'), 'no password hashes anywhere in the unit payload');
const trainee1Id = r.data.roster.find((x) => x.username === 'sep.kumar').id;
r = await ins.call('GET', `/api/sessions/${sid}`); ok(r.status === 200, "instructor can open a unit trainee's session");
r = await ins.call('GET', `/api/unit/users/${trainee1Id}/sessions`); ok(r.status === 200 && r.data.sessions.length === 3, 'instructor can list a trainee\'s sessions');
r = await other.call('GET', `/api/sessions/${sid}`); ok(r.status === 404, "an unrelated trainee cannot read someone else's session");
const ins2 = new Client(); await ins2.call('POST', '/api/register', { username: 'maj.other', name: 'Maj Other', password: 'longpassword1', role: 'instructor', instructorCode: 'INSTR-CODE-1', unitName: '2 Coy' });
r = await ins2.call('GET', `/api/sessions/${sid}`); ok(r.status === 404, "another unit's instructor cannot read it");
r = await ins2.call('GET', `/api/unit/users/${trainee1Id}/sessions`); ok(r.status === 404, "another unit's instructor cannot list that trainee");
r = await ins2.call('GET', '/api/unit'); ok(r.data.roster.length === 0, "other unit's roster is empty (isolation)");
// rotate code
r = await ins.call('POST', '/api/unit/rotate-code', {}); ok(r.data.joinCode && r.data.joinCode !== JOIN, 'join code rotates');
const late = new Client(); r = await late.call('POST', '/api/register', { username: 'late.join', name: 'x', password: 'password123', joinCode: JOIN }); ok(r.status === 400, 'the old join code no longer works');
// CSV
r = await ins.call('GET', '/api/unit/export.csv'); ok(r.status === 200 && /text\/csv/.test(r.headers.get('content-type')), 'CSV export');
const lines = r.data.trim().split('\n'); ok(lines.length === 7 && lines[0].startsWith('date,name'), `csv has header + 6 rows (${lines.length})`);
ok(!lines.some((l) => /,=HYPERLINK/.test(l)) && lines.some((l) => l.includes(`'=HYPERLINK`)), 'a name starting with = is neutralised against spreadsheet formula injection');
// scenarios
r = await tr1.call('GET', '/api/scenarios'); ok(r.data.scenarios.length === 8 && !r.data.scenarios[0].timeline, 'scripted scenario list (no timelines leaked)');
// static
r = await anon.call('GET', '/'); ok(r.status === 200 && r.data.includes('game'), 'serves the game build at /');
r = await anon.call('GET', '/dashboard.html'); ok(r.status === 200 && /Content-Security-Policy/i.test([...r.headers.keys()].join()), 'dashboard served with a CSP');
r = await anon.call('GET', '/..%2f..%2fetc%2fpasswd'); ok(r.status === 403 || r.status === 404, `path traversal blocked (${r.status})`);
r = await anon.call('GET', '/%E0%A4%A'); ok(r.status === 400, 'malformed escape -> 400 not 500');
// persistence
srv.db.flush(); await new Promise((r2) => srv.close(r2));
const srv2 = createServer({ dataDir: path.join(TMP, 'data'), distDir: DIST, instructorCode: 'INSTR-CODE-1' });
ok(Object.keys(srv2.db.d.users).length === 5 && srv2.db.d.sessions.length === 6, `data persisted across restart (${Object.keys(srv2.db.d.users).length} users, ${srv2.db.d.sessions.length} sessions)`);
ok(!/password123|longpassword1/.test(JSON.stringify(srv2.db.d)), 'no plaintext passwords on disk');
process.exit(0);
