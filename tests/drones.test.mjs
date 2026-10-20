globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = {};
const { Drones, TYPES } = await import('../src/drones.js');
const { B, SOLID } = await import('../src/blocks.js');
import * as THREE from 'three';

// ---- fake world: ground to y=10; a hollow building x -10..10, z -40..-20, roof y=40, floors every 4,
//      windows on its south face (z=-20) at floor+2..+3
const edits = new Map();
const key = (x, y, z) => `${x},${y},${z}`;
function base(x, y, z) {
  if (y <= 10) return B.STONE ?? 1;
  if (x < -10 || x > 10 || z < -40 || z > -20 || y > 40) return 0;
  if (y === 40) return B.CONCRETE;
  const f = (y - 11) % 4;
  const wall = x === -10 || x === 10 || z === -40 || z === -20;
  if (wall) return z === -20 && f >= 2 && x > -9 && x < 9 ? B.WINDOW : B.CONCRETE;
  return f === 0 && y > 11 ? B.FLOOR : (y === 11 ? B.FLOOR : 0);
}
const world = {
  getBlock: (x, y, z) => (edits.has(key(x, y, z)) ? edits.get(key(x, y, z)) : base(x, y, z)),
  setBlock(x, y, z, id) { edits.set(key(x, y, z), id); return true; },
  isLoaded: (x, z) => Math.abs(x) < 160 && Math.abs(z) < 160,
  topY(x, z) { for (let y = 200; y > 0; y--) if (SOLID[this.getBlock(x, y, z)]) return y; return 0; },
  raycast(ox, oy, oz, dx, dy, dz, max) {
    let pc = [Math.floor(ox), Math.floor(oy), Math.floor(oz)];
    for (let t = 0; t <= max; t += 0.04) {
      const c = [Math.floor(ox + dx * t), Math.floor(oy + dy * t), Math.floor(oz + dz * t)];
      const id = this.getBlock(...c);
      if (SOLID[id]) return { x: c[0], y: c[1], z: c[2], nx: pc[0] - c[0], ny: pc[1] - c[1], nz: pc[2] - c[2], id, t };
      pc = c;
    }
    return null;
  },
};
const fx = { burst() {}, sparks() {} };
const log = [];
let strikes = 0, dmg = 0;
const mk = () => new Drones(new THREE.Scene(), world, fx, {
  onStrike: (n) => { strikes++; dmg += n; }, onClear() {}, toast: (t) => log.push(t),
});
const player = { x: 0.5, y: 11, z: 0.5 };
const eye = new THREE.Vector3(0.5, 12.7, 0.5);
const look = [0, 0, -1];
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);

// 1. spawn-site finders
let d = mk(); d.enabled = true;
let ins = 0, beh = 0, sky = 0, insHasExit = 0;
for (let i = 0; i < 60; i++) { const r = d.findInside(player, eye, look); if (r) { ins++; if (r.exit && SOLID[world.getBlock(r.exit.bx, r.exit.by, r.exit.bz)]) insHasExit++; } }
for (let i = 0; i < 60; i++) if (d.findBehind(player, eye, look)) beh++;
for (let i = 0; i < 60; i++) if (d.findSky(player, eye, look)) sky++;
console.log(`finders out of 60: inside ${ins}, behind ${beh}, sky ${sky}`);
ok(ins > 0 && insHasExit === ins, 'inside spawns found, each with a real window to break');
ok(beh > 0, 'behind-building spawns found');
ok(sky > 0, 'sky spawns found');

// 2. an inside drone breaks out and attacks
function run(origin, kind, secs) {
  edits.clear(); strikes = 0; dmg = 0; log.length = 0;
  const dd = mk(); dd.enabled = true; dd.s.rest = 1e9;
  let at = null;
  for (let i = 0; i < 400 && !at; i++) at = origin === 'inside' ? dd.findInside(player, eye, look) : dd.findBehind(player, eye, look);
  if (!at) return null;
  const def = TYPES[kind];
  // reuse spawnOne's body via the same fields
  const spawn = dd.spawnOne.bind(dd);
  dd.pickKind = () => kind;
  dd.findInside = origin === 'inside' ? () => at : () => null;
  dd.findBehind = origin === 'behind' ? () => at : () => null;
  dd.spawnOne(player, eye, look);
  const one = dd.list[0];
  let maxY = 0, t = 0, broke = 0;
  for (; t < secs && dd.list.length; t += 0.05) { dd.update(0.05, player, eye, true, look); if (dd.list[0]) maxY = Math.max(maxY, dd.list[0].y); }
  return { dd, strikes, dmg, maxY, t, state: one.state, glassBroken: dd.smashed.length, origin: one.origin, startY: at.y };
}
let r = run('inside', 'quad', 40);
console.log('inside quad:', r && { strikes: r.strikes, windowsBroken: r.glassBroken, startY: +r.startY.toFixed(1), tUntilEnd: +r.t.toFixed(1) });
ok(r && r.glassBroken >= 1, 'inside drone smashed out through glass');
ok(r && r.strikes === 1, 'inside drone reached the player and went off');

r = run('behind', 'heavy', 60);
console.log('behind heavy:', r && { strikes: r.strikes, maxY: +r.maxY.toFixed(1), tUntilEnd: +r.t.toFixed(1), startY: +r.startY.toFixed(1) });
ok(r && r.maxY > 40, 'behind drone climbed over the 40 m roof');
ok(r && r.strikes === 1, 'behind heavy drone reached the player');

// 3. arrows: hit, damage, kill, score; lurkers immune
edits.clear();
d = mk(); d.enabled = true; d.s.rest = 1e9;
d.pickKind = () => 'scout'; d.findInside = () => null; d.findBehind = () => null;
d.findSky = () => ({ x: 0.5, y: 14, z: -30 });
d.spawnOne(player, eye, look);
const dr = d.list[0];
const arrow = { x: eye.x, y: eye.y, z: eye.z, damage: 10, mine: true };
const dir = [0, 0.0, -1]; const ty = dr.y - eye.y; const l = Math.hypot(ty, 30.5); const dd2 = [0, ty / l, -30.5 / l];
const hit = d.arrowHit(arrow, dd2, 40);
ok(hit === true, 'arrow aimed at a drone registers a hit');
ok(d.list.length === 0 && d.s.downed === 1 && d.s.score >= 100, `10-damage arrow downs a 6-hp scout (score ${d.s.score})`);
d.pickKind = () => 'heavy'; d.spawnOne(player, eye, look);
const h = d.list[0]; h.y = 12.7; h.z = -20; h.x = 0.5;
d.arrowHit({ ...arrow }, [0, 0, -1], 40);
ok(d.list.length === 1 && h.hp === 16, 'heavy survives one arrow (26 -> 16 hp)');
const miss = d.arrowHit({ ...arrow, x: 30 }, [0, 0, -1], 40);
ok(miss === false, 'arrow that passes wide misses');
h.state = 'lurk';
ok(d.arrowHit({ ...arrow }, [0, 0, -1], 40) === false, 'a drone still hidden in its room cannot be hit');

// 4. arrow smashes a window, restore puts it back
edits.clear();
const wallHit = world.raycast(0.5, 12.7 + 0, 0.5, 0, 0.0, -1, 30);
console.log('first solid on the arrow line:', wallHit && [wallHit.x, wallHit.y, wallHit.z, wallHit.id === B.WINDOW ? 'WINDOW' : wallHit.id]);
const win = { x: 0, y: 13, z: -20, id: B.WINDOW };
ok(world.getBlock(0, 13, -20) === B.WINDOW, 'fixture: window exists at (0,13,-20)');
ok(d.smash(win) && world.getBlock(0, 13, -20) === 0, 'arrow smashes the window');
ok(d.smash({ x: 10, y: 15, z: -30, id: B.CONCRETE }) === false, 'arrow does not break concrete');
d.clearAll();
ok(world.getBlock(0, 13, -20) === B.WINDOW, 'clearAll puts the window back');

// 5. full director: wave 1 start to clear (a perfect shooter: kill whatever is out)
edits.clear(); strikes = 0;
d = mk(); d.enabled = true;
let t = 0, killed = 0;
while (t < 90 && d.s.wave < 2) {
  d.update(0.05, player, eye, true, look);
  for (const x of [...d.list]) if (x.state !== 'lurk' && Math.hypot(x.x - eye.x, x.z - eye.z) < 45) { x.hp = 0; d.down(x); killed++; }
  t += 0.05;
}
console.log('wave log:', log.slice(0, 4));
ok(d.s.wave === 2 && d.s.downed === killed, `director ran wave 1 (6 drones) to completion and began wave 2 (t=${t.toFixed(1)}s, downed ${d.s.downed})`);
console.log(d.summary());
