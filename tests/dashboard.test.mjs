// Run the dashboard's real code against a real server, on a minimal fake DOM.
import { createServer } from '../server/server.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cuas-dash-'));
fs.mkdirSync(path.join(TMP, 'dist'));
const srv = createServer({ dataDir: path.join(TMP, 'data'), distDir: path.join(TMP, 'dist'), instructorCode: 'ICODE-1234' });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

class Text { constructor(t) { this.text = String(t); this.parent = null; } }
class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.style = {}; this.listeners = {}; this.className = ''; this.parent = null; this.dataset = {}; this.value = ''; this.checked = false; this._cls = new Set(); const self = this; this.classList = { toggle(c, on) { on === false || (on === undefined && self.className.includes(c)) ? self._cls.delete(c) : self._cls.add(c); } }; }
  appendChild(c) { if (c.parent) c.parent.removeChild(c); c.parent = this; this.children.push(c); return c; }
  append(...k) { k.forEach((x) => x && this.appendChild(typeof x === 'string' ? new Text(x) : x)); }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parent = null; return c; }
  remove() { this.parent && this.parent.removeChild(this); }
  before(n) { const p = this.parent; p.children.splice(p.children.indexOf(this), 0, n); n.parent = p; }
  get firstChild() { return this.children[0] || null; }
  setAttribute(k, v) { this.attrs[k] = v; if (k.startsWith('data-')) this.dataset[k.slice(5)] = v; if (k === 'value') this.value = v; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener() {}
  getContext() { return new Proxy({}, { get: () => () => {}, set: () => true }); }
  get clientWidth() { return 600; }
  set textContent(t) { this.children = []; if (t) this.appendChild(new Text(t)); }
  get textContent() { return this.children.map((c) => (c instanceof Text ? c.text : c.textContent)).join(' '); }
  async fire(type, ev = {}) { for (const f of this.listeners[type] || []) await f({ preventDefault() {}, target: this, ...ev }); }
}
const walk = (n, f) => { if (f(n) === false) return; (n.children || []).forEach((c) => c instanceof El && walk(c, f)); };
const body = new El('body'), appEl = new El('div'); appEl.attrs.id = 'app'; body.appendChild(appEl);
globalThis.document = { body, createElement: (t) => new El(t), createTextNode: (t) => new Text(t), getElementById: (id) => { let r = null; walk(body, (n) => { if (n.attrs.id === id) { r = n; return false; } }); return r; },
  querySelectorAll: (sel) => { const out = []; walk(body, (n) => { if (n.tagName === 'button' && n.parent?.tagName === 'nav') out.push(n); }); return out; }, addEventListener() {}, removeEventListener() {} };
globalThis.window = { devicePixelRatio: 1, print() {} };
globalThis.location = { search: '', href: '' };
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
globalThis.requestAnimationFrame = (f) => f();
let cookie = '';
globalThis.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = v; } };
const realFetch = globalThis.fetch;
globalThis.fetch = async (path, o = {}) => {
  const r = await realFetch(base + path, { ...o, headers: { ...(o.headers || {}), ...(cookie ? { Cookie: cookie } : {}) } });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
  return r;
};
const errors = [];
process.on('unhandledRejection', (e) => errors.push(e));
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const find = (pred) => { const out = []; walk(body, (n) => { if (pred(n)) out.push(n); }); return out; };
const text = () => body.textContent;
const input = (name) => find((n) => n.tagName === 'input' && n.attrs.name === name)[0];

// seed: a trainee with sessions, via the API directly (cookie jar swapped)
const post = async (path, b) => (await globalThis.fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
const mk = (i) => ({ scenarioId: 'S2', scenarioName: 'Roofline ambush', difficulty: 2 + (i % 3), env: ['day', 'dusk', 'night'][i % 3], sensors: { radar: i % 2 ? 'degraded' : 'full', iff: 'ok' }, terrain: 'urban', startedAt: new Date(Date.now() - (9 - i) * 86400000).toISOString(), duration: 120, reason: 'complete', shots: 10, hits: 5, falseAlarms: i % 2,
  contacts: [{ id: 'T01', kind: 'quad', truth: 'ATTACK', origin: 'behind', tSpawn: 10, tObs: 13, tDes: 13 + 2 + i, guess: 'ATTACK', engaged: true, engageT: 20, engageRange: 30, guessAtEngage: 'ATTACK', outcome: 'neutralized', outcomeT: 21, eta: 25 },
    { id: 'T02', kind: 'civil', truth: 'CIVILIAN', origin: 'sky', tSpawn: 30, tObs: 31, tDes: 34, guess: i % 2 ? 'RECON' : 'CIVILIAN', engaged: false, outcome: 'expired', outcomeT: 60, guessT: 36 }], events: [{ t: 10, type: 'launch', id: 'T01', truth: 'ATTACK', origin: 'behind' }] });
// trainee account created through the server, then log out
await post('/api/register', { username: 'maj.rao', name: 'Maj Rao', password: 'longpassword1', role: 'instructor', instructorCode: 'ICODE-1234', unitName: '1 PARA' });
const unit = await (await globalThis.fetch('/api/me')).json(); const JOIN = unit.user.unit.joinCode;
await globalThis.fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
await post('/api/register', { username: 'sep.kumar', name: 'Sep Kumar', password: 'password123', joinCode: JOIN });
for (let i = 0; i < 8; i++) await post('/api/sessions', { session: mk(i) });
await post('/api/register', { username: 'sep.idle', name: 'Sep Idle', password: 'password123', joinCode: JOIN });
await globalThis.fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

// ---- the dashboard, signed out
await import('../src/dashboard/dashboard.js'); await sleep(100);
ok(text().includes('Sign in') && !!input('username') && !!input('password'), 'signed out: the sign-in form shows');
// switch to register as a brand-new trainee
const regLink = find((n) => n.tagName === 'a' && n.textContent.includes('Create an account'))[0];
await regLink.fire('click');
ok(!!input('name') && text().includes('Create account') && !!input('joinCode'), 'register form: name, username, password and unit join code for a trainee');
const instrSeg = find((n) => n.tagName === 'button' && n.textContent === 'Instructor')[0]; await instrSeg.fire('click');
ok(!!input('instructorCode') && !!input('unitName') && !input('joinCode'), 'instructor form asks for the instructor code and a unit name');
// wrong instructor code -> error shown
input('name').value = 'Lt X'; input('username').value = 'lt.x'; input('password').value = 'password123'; input('instructorCode').value = 'nope'; input('unitName').value = 'Z';
await find((n) => n.tagName === 'form')[0].fire('submit'); await sleep(200);
ok(text().includes('Wrong instructor code'), 'wrong instructor code shows the server\'s message in the form');
// sign in as the trainee
const signin = find((n) => n.tagName === 'a' && n.textContent.includes('Sign in'))[0]; await signin.fire('click');
input('username').value = 'sep.kumar'; input('password').value = 'password123';
await find((n) => n.tagName === 'form')[0].fire('submit'); await sleep(400);
ok(text().includes('Sep Kumar') && text().includes('trainee') && text().includes('1 PARA'), 'trainee signed in: header shows name, role and unit');
const tabs = () => find((n) => n.tagName === 'button' && n.parent?.tagName === 'nav').map((b) => b.textContent);
ok(JSON.stringify(tabs()) === JSON.stringify(['Train', 'Performance', 'Sessions']), `trainee tabs: ${tabs().join(' / ')}`);
ok(text().includes('Recommended next') && text().includes('Scripted scenarios') && text().includes('Build a procedural scenario'), 'Train tab: recommendation, 8 scripted scenarios, procedural builder');
ok(find((n) => n.tagName === 'a' && (n.attrs.href || '').startsWith('/?train=')).length >= 9, `launch links point at the simulator (${find((n) => n.tagName === 'a' && (n.attrs.href || '').startsWith('/?train=')).length})`);
const launches = find((n) => n.tagName === 'a' && (n.attrs.href || '').includes('train=P')).map((n) => n.attrs.href); console.log('  custom launch link:', launches[0]);
const clickTab = async (label) => { await find((n) => n.tagName === 'button' && n.parent?.tagName === 'nav' && n.textContent === label)[0].fire('click'); await sleep(300); };
await clickTab('Performance');
ok(text().includes('Score over sessions') && text().includes('Confusion matrix') && text().includes('Average, last 5'), 'Performance tab renders KPIs, charts and the confusion matrix');
ok(find((n) => n.tagName === 'canvas').length >= 2, 'charts drawn on canvases');
await clickTab('Sessions');
const rows = find((n) => n.tagName === 'tr' && n.className === 'click');
ok(rows.length === 8, `Sessions tab lists 8 sessions (${rows.length})`);
await rows[0].fire('click'); await sleep(300);
ok(text().includes('After-action review') && text().includes('Coaching') && text().includes('Decision path per contact') && text().includes('Timeline'), 'clicking a session opens the AAR with coaching, timeline and decision paths');
ok(find((n) => n.tagName === 'canvas').length >= 1, 'AAR timeline canvas present');
find((n) => n.className === 'modal').forEach((m) => m.remove());
// sign out, then the instructor
await find((n) => n.tagName === 'button' && n.textContent === 'Sign out')[0].fire('click'); await sleep(200);
ok(text().includes('Sign in') && !text().includes('Sep Kumar'), 'sign out returns to the sign-in form');
input('username').value = 'maj.rao'; input('password').value = 'longpassword1';
await find((n) => n.tagName === 'form')[0].fire('submit'); await sleep(500);
ok(JSON.stringify(tabs()) === JSON.stringify(['Unit', 'Train', 'My performance', 'My sessions']), `instructor tabs: ${tabs().join(' / ')}`);
ok(text().includes('1 PARA') && text().includes(JOIN), 'Unit tab shows the unit name and its join code');
ok(text().includes('Sep Kumar') && text().includes('Sep Idle') && text().includes('Roster'), 'roster lists both trainees');
ok(text().includes('Needs attention') && text().includes('no sessions yet'), 'attention list flags the trainee with no sessions');
ok(text().includes('Unit trend by day') && text().includes('Unit confusion matrix'), 'unit trend and confusion matrix render');
ok(find((n) => n.tagName === 'a' && n.attrs.href === '/api/unit/export.csv').length === 1, 'CSV export link present');
const row = find((n) => n.tagName === 'tr' && n.className === 'click' && n.textContent.includes('Sep Kumar'))[0]; await row.fire('click'); await sleep(300);
ok(text().includes('Sep Kumar') && text().includes('Score over sessions') && text().includes('Sessions'), "instructor drills into a trainee's performance");
const s1 = find((n) => n.tagName === 'tr' && n.className === 'click')[0]; await s1.fire('click'); await sleep(300);
ok(text().includes('After-action review') && text().includes('Sep Kumar'), "instructor opens a trainee's AAR");
// XSS: a hostile name is only ever text
find((n) => n.className === 'modal').forEach((m) => m.remove());
ok(!find((n) => n.tagName === 'script').length, 'no script elements created anywhere');
ok(errors.length === 0, `no unhandled errors (${errors.length}${errors[0] ? ': ' + errors[0].message : ''})`);
process.exit(0);
