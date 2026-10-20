globalThis.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = v; }, removeItem(k) { delete this._d[k]; } };
globalThis.window = { innerWidth: 800, innerHeight: 600 };
globalThis.document = { getElementById: () => null, addEventListener() {}, removeEventListener() {}, exitPointerLock() {} };
let posted = [];
globalThis.fetch = async (path, o) => { if (o?.method === 'POST') posted.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => ({ id: 'abc' }) }; };
const { Drones } = await import('../src/drones.js');
const { Training } = await import('../src/training.js');
const { B, SOLID } = await import('../src/blocks.js');
const { SCRIPTED, generate } = await import('../src/scenario.js');
const { scoreSession } = await import('../src/scoring.js');
import * as THREE from 'three';

const edits = new Map(); const key = (x, y, z) => `${x},${y},${z}`;
function base(x, y, z) {
  if (y <= 10) return 1;
  if (x < -10 || x > 10 || z < -40 || z > -20 || y > 40) return 0;
  if (y === 40) return B.CONCRETE;
  const f = (y - 11) % 4, wall = x === -10 || x === 10 || z === -40 || z === -20;
  if (wall) return z === -20 && f >= 2 && x > -9 && x < 9 ? B.WINDOW : B.CONCRETE;
  return f === 0 ? B.FLOOR : 0;
}
const world = {
  getBlock: (x, y, z) => (edits.has(key(x, y, z)) ? edits.get(key(x, y, z)) : base(x, y, z)),
  setBlock(x, y, z, id) { edits.set(key(x, y, z), id); return true; },
  isLoaded: (x, z) => Math.abs(x) < 160 && Math.abs(z) < 160,
  topY(x, z) { for (let y = 200; y > 0; y--) if (SOLID[this.getBlock(x, y, z)]) return y; return 0; },
  raycast(ox, oy, oz, dx, dy, dz, max) {
    let pc = [Math.floor(ox), Math.floor(oy), Math.floor(oz)];
    for (let t = 0; t <= max; t += 0.1) {
      const c = [Math.floor(ox + dx * t), Math.floor(oy + dy * t), Math.floor(oz + dz * t)];
      const id = this.getBlock(...c);
      if (SOLID[id]) return { x: c[0], y: c[1], z: c[2], nx: pc[0] - c[0], ny: pc[1] - c[1], nz: pc[2] - c[2], id, t };
      pc = c;
    }
    return null;
  },
};
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
const player = { x: 0.5, y: 11, z: 0.5 }, eye = new THREE.Vector3(0.5, 12.7, 0.5), look = [0, 0, -1];

async function runSession(sc, bot, label) {
  edits.clear(); posted = [];
  let health = 20, dead = false, enabled = false;
  const drones = new Drones(new THREE.Scene(), world, { burst() {}, sparks() {} }, { onStrike: (n) => { health -= n; if (health <= 0) dead = true; }, toast() {} });
  const toasts = [];
  let ended = null;
  const tr = new Training({ drones, world, toast: (t) => toasts.push(t), enable: () => { enabled = true; drones.start(); }, disable: () => { enabled = false; drones.stop(); }, isDead: () => dead, onEnd: (s, m) => { ended = { s, m }; } });
  tr.start(sc, player, eye, look);
  let target = null, aim = [0, 0, -1];
  const dt = 0.05;
  for (let step = 0; step < 6000 && !tr.finished; step++) {
    drones.update(dt, player, eye, !dead, look, aim);
    tr.update(dt, player, eye, look, !dead);
    // --- the bot
    aim = [0, 0, -1];
    const cands = drones.list.filter((c) => c.observable && c.state !== 'lurk');
    target = bot.choose(cands, tr);
    if (target) {
      const v = [target.x - eye.x, target.y - eye.y, target.z - eye.z], l = Math.hypot(...v);
      aim = v.map((x) => x / l);
      drones.update(0, player, eye, !dead, look, aim);   // refresh d.angle toward the crosshair
      if (bot.designate && !tr.prompt && !target.rec.guess) { tr.designate(player, eye, aim); }
      if (tr.prompt && tr.prompt.c === target) tr.classify(bot.guess(target));
      if (bot.engage(target)) {
        const dir = aim, a = { x: eye.x, y: eye.y, z: eye.z, damage: 10, mine: true };
        drones.arrowHit(a, dir, l + 1);
      }
    }
    // an extra: a bot that wastes effort on radar ghosts
    if (bot.ghosts && drones.ghosts.length) { const g = drones.ghosts[0]; const v = [g.x - eye.x, g.y - eye.y, g.z - eye.z], l = Math.hypot(...v); tr.designate(player, eye, v.map((x) => x / l)); }
  }
  await new Promise((r) => setTimeout(r, 20));
  return { ended, toasts, posted, drones };
}
const truth = (c) => c.cls;
const perfect = { designate: true, choose: (c) => c.filter((x) => !x.rec.outcome).sort((a, b) => a.dist - b.dist)[0], guess: (c) => c.cls, engage: (c) => c.rec.guess === 'ATTACK' || c.rec.guess === 'RECON' };
const passive = { designate: false, choose: () => null, guess: () => 'ATTACK', engage: () => false };
const trigger = { designate: false, choose: (c) => c.filter((x) => !x.rec.outcome).sort((a, b) => a.dist - b.dist)[0], guess: () => 'ATTACK', engage: (c) => c.dist < 60 };

const S2 = SCRIPTED.find((s) => s.id === 'S2');
const A = await runSession(S2, perfect, 'perfect'), P = await runSession(S2, passive, 'passive'), T = await runSession(S2, trigger, 'trigger');
for (const [n, r] of [['perfect', A], ['passive', P], ['trigger-happy', T]]) {
  const m = r.ended?.m; console.log(`${n.padEnd(14)}`, m && { score: m.score, grade: m.grade, leaks: m.leaks, fratricide: m.fratricide, detect: m.meanDetect, skills: m.skills }, 'died:', m?.died, 'reason:', r.ended?.s.reason);
}
ok(A.ended.m.score >= 85, `perfect trainee scores high (${A.ended.m.score})`);
ok(A.ended.m.fratricide === 0 && A.ended.m.leaks === 0, 'perfect trainee: no leaks, no fratricide');
ok(P.ended.m.score < 45, `passive trainee scores low (${P.ended.m.score})`);
ok(T.ended.m.fratricide >= 1, `trigger-happy trainee shot the friendly (fratricide ${T.ended.m.fratricide})`);
ok(T.ended.m.score < A.ended.m.score - 20, `trigger-happy scores well below perfect (${T.ended.m.score})`);
ok(A.posted.length === 1 && A.posted[0].session.contacts.length === 4, 'session posted to the server with all 4 contacts');
ok(['rural','suburban'].includes(A.ended.s.terrain), `terrain on a one-building map measures as ${A.ended.s.terrain} (not urban)`);
ok(A.ended.s.events.some((e) => e.type === 'observable') && A.ended.s.events.some((e) => e.type === 'designated') && A.ended.s.events.some((e) => e.type === 'neutralized'), 'event log has observable/designated/neutralized');
// the friendly must not have leaked as an attack; recon none here
console.log('events sample:', A.ended.s.events.slice(0, 6));

// ---- sensors: jammed radar means no radar tracks; degraded flickers, ghosts appear
function sensorTest(radar) {
  edits.clear();
  const drones = new Drones(new THREE.Scene(), world, { burst() {}, sparks() {} }, { onStrike() {}, toast() {} });
  drones.enabled = true; drones.training = { colorOf: () => '#fff', ghostColor: () => '#fff', hud: () => '' };
  drones.sensors = { radar, iff: 'ok' };
  const d = drones.spawn('quad', 'sky', player, eye, look);
  d.x = 30; d.z = 0.5; d.y = 14;
  let radarHits = 0, ticks = 0;
  for (let i = 0; i < 100; i++) { drones.update(0.05, player, eye, true, look, [1, 0, 0]); d.x = 30; d.z = 0.5; d.y = 14; d.vx = d.vy = d.vz = 0; ticks++; if (d.radar) radarHits++; }
  return { radarHits, ticks, ghosts: drones.ghosts.length };
}
const full = sensorTest('full'), deg = sensorTest('degraded'), jam = sensorTest('jammed');
console.log('radar sees a quad at 30 m over 100 ticks: full', full.radarHits, 'degraded', deg.radarHits, 'jammed', jam.radarHits);
ok(full.radarHits === 100 && jam.radarHits === 0 && deg.radarHits > 40 && deg.radarHits < 95, 'radar modes behave: full always, degraded flickers, jammed never');
// radar shadow: a drone behind the building is not tracked
edits.clear();
{ const drones = new Drones(new THREE.Scene(), world, { burst() {}, sparks() {} }, { onStrike() {}, toast() {} }); drones.enabled = true;
  const d = drones.spawn('quad', 'sky', player, eye, look); d.x = 0.5; d.z = -60; d.y = 14; d.vx = d.vy = d.vz = 0;
  for (let i = 0; i < 10; i++) { drones.update(0.05, player, eye, true, look, [0, 0, -1]); d.x = 0.5; d.z = -60; d.y = 14; }
  ok(!d.los && !d.radar && !d.observable, 'a drone behind the building is in radar shadow and not observable'); }

// ---- night/dusk shortens the visual range to the beacons; fov matters
{ const drones = new Drones(new THREE.Scene(), world, { burst() {}, sparks() {} }, { onStrike() {}, toast() {} }); drones.enabled = true; drones.sensors = { radar: 'jammed', iff: 'ok' }; drones.env = 'dusk';
  const d = drones.spawn('quad', 'sky', player, eye, look); d.x = 0.5 + 0; d.z = 0.5 + 80; d.y = 14; d.vx = d.vy = d.vz = 0;   // 80 m BEHIND the player
  drones.update(0.05, player, eye, true, look, [0, 0, -1]);
  ok(!d.visual, 'a contact behind you (outside the field of view) is not seen');
  d.x = 0.5; d.z = -55 + 0.5; d.y = 14; d.losAt = 0;
  // 55 m ahead is above the building? building spans z -40..-20 so place at z=+... use east instead
  d.x = 55; d.z = 0.5; drones.update(0.05, player, eye, true, look, [1, 0, 0]);
  ok(d.visual, 'a contact in front at 55 m is seen at dusk'); }
// ---- non-hostile contacts spawn and never strike
edits.clear();
{ let struck = 0; const drones = new Drones(new THREE.Scene(), world, { burst() {}, sparks() {} }, { onStrike() { struck++; }, toast() {} }); drones.enabled = true; drones.training = { hud: () => '', colorOf: () => '#fff', ghostColor: () => '#fff' };
  for (const k of ['recon', 'friendly', 'civil', 'bird']) { const d = drones.spawn(k, 'any', player, eye, look); if (!d) console.log('FAIL spawn', k); }
  const kinds = drones.list.map((d) => d.cls);
  for (let i = 0; i < 1800; i++) drones.update(0.05, player, eye, true, look, [0, 0, -1]);
  ok(kinds.length === 4 && struck === 0, `recon/friendly/civil/bird spawned and none attacked (${kinds.join(',')})`);
  ok(drones.list.every((d) => Math.hypot(d.x, d.z) < 170), 'neutral contacts stay in the area or leave'); }
// ---- procedural scenario plays through
{ const sc = generate({ seed: 777, difficulty: 7 }); const r = await runSession(sc, perfect, 'p7'); const m = r.ended.m;
  console.log('procedural D7:', sc.name, '->', { contacts: m.contacts, score: m.score, died: m.died });
  ok(m.contacts >= sc.timeline.length - r.ended.s.skipped - 1, `procedural scenario launched its contacts (${m.contacts}/${sc.timeline.length})`); }
