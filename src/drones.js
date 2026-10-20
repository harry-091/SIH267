// Drone defence: hostile quadcopters come for the player over, around and through the buildings,
// and the bow is what stops them.
//
// Where they come from:
//   behind  - launched on the far side of a building, so the first the player sees of one is a
//             drone climbing over the roofline;
//   inside  - hovering in a room behind a window, until it smashes out through the glass;
//   sky     - from the open air, when a place has no building to hide behind.
//
// How a drone flies: straight at the player's eye, weaving a little, gliding down the last
// stretch. It looks ahead for what is in the way (a roof, a tree) and climbs over it, slowing
// down while it does. Glass is no obstacle: it breaks it and goes through. At arm's length it
// goes off. The player's arrows are tested against it in arrowHit(), and break any window they
// meet while drone defence is on (smash()).
//
// Free play runs endless waves, each bigger and faster than the last. Training sessions
// (training.js) instead launch a scripted or generated timeline of contacts, and add contacts that
// are not hostile (recon, friendly with IFF, civilian, birds), a sensor model (radar shadow behind
// buildings, short-range / flickering / jammed radar, ghost tracks, night) and the hooks the
// scoring needs.
import * as THREE from 'three';
import { B, SOLID } from './blocks.js';
import { sfx, droneHum } from './sound.js';

const BEST_KEY = 'geocrafter:drones:best';
const HIT_PAD = 0.45; // metres added to a drone's own half-span: this is a bow, not a rifle
const RADAR = 100; // metres from the centre of the radar to its rim
// how far the eye can pick a contact out, by the light (at night: the beacons)
const VISUAL = { day: 95, dusk: 65, night: 70 };
const MAX_DIST = 118; // nothing is launched further off than this (the voxel world ends about there)
const GLASSY = new Set([B.GLASS, B.GLASS_DARK, B.WINDOW, B.WINDOW_DARK, B.GLASS_PANE]);
const turnTo = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

// speed in m/s, span in m (rotor tip to rotor tip along the diagonal), dmg: what it takes off the
// player's 20 health when it goes off. wob: how much it weaves. A full draw of the bow does 10.
// cls: what the contact really is (scoring.js). led: its beacon colour; ttl: how long a contact
// that is not hostile stays around. model: how it is drawn.
export const TYPES = {
  scout: { name: 'Scout', cls: 'ATTACK', hp: 6, speed: 11, span: 0.55, dmg: 3, score: 100, wob: 1, pitch: 1.35, color: 0x3b414d, led: 0xff2a2a, dot: '#ffd23f' },
  quad: { name: 'Quad', cls: 'ATTACK', hp: 10, speed: 7.5, span: 0.75, dmg: 5, score: 150, wob: 0.8, pitch: 1, color: 0x2c3038, led: 0xff2a2a, dot: '#ff8a3d' },
  heavy: { name: 'Heavy', cls: 'ATTACK', hp: 26, speed: 4.6, span: 1.15, dmg: 9, score: 300, wob: 0.3, pitch: 0.7, color: 0x4b5033, led: 0xff2a2a, dot: '#ff4d4d', cargo: true },
  recon: { name: 'Fixed-wing', cls: 'RECON', hp: 8, speed: 6, span: 1.6, dmg: 0, score: 0, wob: 0, pitch: 0.85, color: 0x9aa0a8, led: 0xffffff, dot: '#ffb347', model: 'wing', ttl: 55 },
  friendly: { name: 'Quad (own)', cls: 'FRIENDLY', hp: 10, speed: 8, span: 0.8, dmg: 0, score: 0, wob: 0, pitch: 1.05, color: 0x2f6b3a, led: 0x39ff7a, dot: '#4dff88', ttl: 45 },
  civil: { name: 'Quad (commercial)', cls: 'CIVILIAN', hp: 8, speed: 3.2, span: 0.6, dmg: 0, score: 0, wob: 0, pitch: 1.15, color: 0xe6e9ec, led: 0xfff1b0, dot: '#6ab7ff', ttl: 55 },
  bird: { name: 'Bird', cls: 'BIRD', hp: 1, speed: 6.5, span: 0.6, dmg: 0, score: 0, wob: 0, pitch: 1, color: 0x1c1c1e, led: null, dot: '#9aa0a8', model: 'bird', ttl: 25 },
};

// ---------------------------------------------------------------- the model

let shared = null;
function parts() {
  if (shared) return shared;
  const basic = (color, extra = {}) => new THREE.MeshBasicMaterial({ color, ...extra });
  shared = {
    body: new THREE.BoxGeometry(0.44, 0.16, 0.44),
    arm: new THREE.BoxGeometry(1.0, 0.05, 0.07),
    motor: new THREE.CylinderGeometry(0.06, 0.06, 0.1, 8),
    disc: new THREE.CylinderGeometry(0.27, 0.27, 0.008, 18),
    blade: new THREE.BoxGeometry(0.54, 0.012, 0.045),
    pod: new THREE.SphereGeometry(0.075, 8, 6),
    led: new THREE.BoxGeometry(0.07, 0.05, 0.05),
    cargo: new THREE.BoxGeometry(0.34, 0.2, 0.34),
    stripe: new THREE.BoxGeometry(0.352, 0.05, 0.352),
    dark: basic(0x15171c),
    rotor: basic(0xcfd6dd, { transparent: true, opacity: 0.2, depthWrite: false }),
    blades: basic(0x0b0c0f),
    ledOn: basic(0xff2a2a),
    pod_: basic(0x0a0b0d),
    cargoM: basic(0xd9601c),
    stripeM: basic(0x141414),
  };
  return shared;
}

// A drone, facing +z, scaled to the type's own span: a quadcopter, a small fixed-wing aircraft or
// a bird.
function build(def) {
  const p = parts();
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshBasicMaterial({ color: def.color });
  const ledMat = def.led == null ? null : new THREE.MeshBasicMaterial({ color: def.led });
  const rotors = [], flap = [];
  let led = null;
  if (def.model === 'bird') {
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.3), bodyMat));
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.09), bodyMat);
    head.position.set(0, 0.02, 0.2);
    g.add(head);
    for (const sx of [1, -1]) {
      const pivot = new THREE.Group();
      pivot.position.set(sx * 0.06, 0.03, 0);
      const wing = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.015, 0.14), bodyMat);
      wing.position.x = sx * 0.15;
      pivot.add(wing);
      g.add(pivot);
      flap.push(pivot);
    }
    g.scale.setScalar(def.span / 0.66);
  } else if (def.model === 'wing') {
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.14, 1.0), bodyMat));
    const wing = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.03, 0.22), bodyMat);
    wing.position.z = 0.05;
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.03, 0.14), bodyMat);
    tail.position.z = -0.45;
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.2, 0.16), bodyMat);
    fin.position.set(0, 0.1, -0.45);
    const prop = new THREE.Group();
    prop.position.z = 0.53;
    prop.add(new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.008, 14).rotateX(Math.PI / 2), p.rotor), new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.04, 0.012), p.blades));
    led = new THREE.Mesh(p.led, ledMat);
    led.position.set(0, 0.1, 0.1);
    g.add(wing, tail, fin, prop, led);
    rotors.push(prop);
    prop.userData.dir = 1;
    prop.userData.axis = 'z';
    g.scale.setScalar(def.span / 1.6);
  } else {
    g.add(new THREE.Mesh(p.body, bodyMat));
    for (const a of [Math.PI / 4, -Math.PI / 4]) {
      const arm = new THREE.Mesh(p.arm, p.dark);
      arm.rotation.y = a;
      g.add(arm);
    }
    for (const [i, [sx, sz]] of [[1, 1], [-1, 1], [1, -1], [-1, -1]].entries()) {
      const motor = new THREE.Mesh(p.motor, p.dark);
      motor.position.set(sx * 0.35, 0.05, sz * 0.35);
      g.add(motor);
      const rot = new THREE.Group();
      rot.position.set(sx * 0.35, 0.115, sz * 0.35);
      rot.userData.dir = i % 2 ? -1 : 1;
      rot.add(new THREE.Mesh(p.disc, p.rotor), new THREE.Mesh(p.blade, p.blades));
      g.add(rot);
      rotors.push(rot);
    }
    const pod = new THREE.Mesh(p.pod, p.pod_); // the camera
    pod.position.set(0, -0.06, 0.2);
    led = new THREE.Mesh(p.led, ledMat);
    led.position.set(0, 0.095, 0.17);
    g.add(pod, led);
    if (def.cargo) {
      // the warhead: slung underneath, in warning colours
      const c = new THREE.Mesh(p.cargo, p.cargoM);
      c.position.y = -0.2;
      const st = new THREE.Mesh(p.stripe, p.stripeM);
      st.position.y = -0.2;
      g.add(c, st);
    }
    g.scale.setScalar(def.span);
  }
  return { mesh: g, bodyMat, ledMat, rotors, led, flap };
}

// ---------------------------------------------------------------- the drones

export class Drones {
  // hooks: onStrike(damage, dx, dz) - one went off at the player, onClear() - a wave was beaten,
  //        toast(text, ms), onShake(amount)
  constructor(scene, world, fx, hooks = {}) {
    this.world = world;
    this.fx = fx;
    this.hooks = hooks;
    this.group = new THREE.Group(); // kept out of the photo depth maps
    scene.add(this.group);
    this.enabled = false;
    this.list = [];
    this.smashed = []; // [x, y, z, id] of every pane broken this session, put back afterwards
    this.clock = 0;
    this.sayAt = -9;
    this.uiAt = 0;
    this.last = { x: 0, z: 0 }; // where the player's eye was, for scoring a long shot
    this.training = null; // set by a training session (training.js): the wave director then stands down
    this.env = 'day'; // day | dusk | night: how far a contact can be seen by eye
    this.sensors = { radar: 'full', iff: 'ok' }; // radar: full | degraded | jammed
    this.speedMul = 1; // how much faster than normal the hostile drones fly
    this.ghosts = []; // false radar tracks: { x, z, exp }
    this.ghostT = 6;
    this.nextId = 1;
    this.fixedDir = null; // a swarm: every drone of a group launches from the same side
    this.best = +localStorage.getItem(BEST_KEY) || 0;
    this.hud = null;
    this.radar = null;
    this.resetSession();
  }

  resetSession() {
    // rest: seconds until the next wave. toSpawn: left to launch in this one.
    this.s = { wave: 0, toSpawn: 0, timer: 0, rest: 4, cap: 2, gap: 4, score: 0, downed: 0, leaked: 0, shots: 0 };
  }

  bind(hudEl, radarEl) {
    this.hud = hudEl;
    this.radar = radarEl ? radarEl.getContext('2d') : null;
    this.radarEl = radarEl;
    this.show(false);
  }

  show(on) {
    if (this.hud) this.hud.classList.toggle('hidden', !on);
    if (this.radarEl) this.radarEl.classList.toggle('hidden', !on);
  }

  start() {
    this.enabled = true;
    this.clearAll();
    this.resetSession();
    this.show(true);
  }

  stop() {
    this.enabled = false;
    this.clearAll();
    this.show(false);
    droneHum.off();
  }

  // Everything back as it was: no drones, every window whole again.
  reset() {
    this.clearAll();
    this.resetSession();
  }

  clearAll() {
    for (let i = this.list.length - 1; i >= 0; i--) this.remove(i);
    const w = this.world;
    for (const [x, y, z, id] of this.smashed) w.setBlock(x, y, z, id);
    this.smashed.length = 0;
    this.ghosts.length = 0;
  }

  remove(i) {
    const d = this.list[i];
    this.group.remove(d.mesh);
    d.bodyMat.dispose();
    if (d.ledMat) d.ledMat.dispose();
    this.list.splice(i, 1);
  }

  summary() {
    const s = this.s;
    if (s.score > this.best) {
      this.best = s.score;
      try {
        localStorage.setItem(BEST_KEY, String(this.best));
      } catch (e) {
        // storage blocked: the best is just not kept
      }
    }
    return `Drones downed: ${s.downed} · Wave ${s.wave} · Score ${s.score} · Best ${this.best}`;
  }

  // ---------------------------------------------------------------- places to launch from

  // A random heading, mostly the way the player looks, sometimes from the sides, now and then
  // from behind them. Returns a unit vector [x, z].
  bearing(look) {
    if (this.fixedDir) {
      const a = (Math.random() - 0.5) * 0.4, [fx, fz] = this.fixedDir;
      return [fx * Math.cos(a) - fz * Math.sin(a), fx * Math.sin(a) + fz * Math.cos(a)];
    }
    const l = Math.hypot(look[0], look[2]) || 1;
    const fx = look[0] / l, fz = look[2] / l;
    const r = Math.random();
    const spread = r < 0.6 ? 70 : r < 0.9 ? 130 : 180;
    const a = (Math.random() * 2 - 1) * spread * (Math.PI / 180);
    return [fx * Math.cos(a) - fz * Math.sin(a), fx * Math.sin(a) + fz * Math.cos(a)];
  }

  // Room for a drone here: nothing solid in the cells around it.
  free(x, y, z) {
    const w = this.world;
    const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) if (SOLID[w.getBlock(bx + dx, by + dy, bz + dz)]) return false;
      }
    }
    return true;
  }

  column(x, z) {
    const bx = Math.floor(x), bz = Math.floor(z);
    return this.world.isLoaded(bx, bz) ? this.world.topY(bx, bz) : 0;
  }

  // Behind a building: walk out along a heading until something tall has stood in the way and
  // then ended, and launch from the air a little way past its back.
  findBehind(player, eye, look) {
    const w = this.world;
    for (let n = 0; n < 16; n++) {
      const [dx, dz] = this.bearing(look);
      let hitD = -1, clearD = -1;
      for (let d = 14; d <= MAX_DIST; d += 2) {
        const x = eye.x + dx * d, z = eye.z + dz * d;
        if (!w.isLoaded(x, z)) break;
        const tall = this.column(x, z) > player.y + 7;
        if (hitD < 0) {
          if (tall) hitD = d;
        } else if (!tall) {
          clearD = d;
          break;
        }
      }
      if (hitD < 0 || clearD < 0) continue;
      const d = clearD + 2 + Math.random() * 8;
      if (d > MAX_DIST) continue;
      const x = eye.x + dx * d, z = eye.z + dz * d;
      if (!w.isLoaded(x, z)) continue;
      const y = this.column(x, z) + 3 + Math.random() * 7;
      if (!this.free(x, y, z)) continue;
      // out of sight: something solid between the player's eye and it
      const vx = x - eye.x, vy = y - eye.y, vz = z - eye.z, vl = Math.hypot(vx, vy, vz);
      if (!w.raycast(eye.x, eye.y, eye.z, vx / vl, vy / vl, vz / vl, vl - 0.5)) continue;
      return { x, y, z };
    }
    return null;
  }

  // Inside a building: an open room cell below a tall roof, with a pane in the wall on the side
  // that faces the player. It starts there; the pane is the way out.
  findInside(player, eye, look) {
    const w = this.world;
    for (let n = 0; n < 40; n++) {
      const [dx, dz] = this.bearing(look);
      const dist = 26 + Math.random() * 56;
      const x = Math.floor(eye.x + dx * dist), z = Math.floor(eye.z + dz * dist);
      if (!w.isLoaded(x, z)) continue;
      const top = w.topY(x, z);
      const lo = Math.ceil(player.y) + 1, hi = top - 3;
      if (top < player.y + 6 || hi - lo < 2) continue;
      const span = hi - lo, y0 = Math.floor(Math.random() * span);
      for (let k = 0; k < span; k++) {
        const y = lo + ((y0 + k) % span);
        if (w.getBlock(x, y, z) !== B.AIR || w.getBlock(x, y + 1, z) !== B.AIR || !SOLID[w.getBlock(x, y - 1, z)]) continue;
        const cx = x + 0.5, cy = y + 1, cz = z + 0.5;
        const hit = w.raycast(cx, cy, cz, -dx, 0, -dz, 28);
        if (!hit || hit.t < 2 || !GLASSY.has(hit.id)) continue;
        // the cell beyond the pane must be open air, or there is no way out
        if (SOLID[w.getBlock(hit.x - hit.nx, hit.y - hit.ny, hit.z - hit.nz)]) continue;
        const reach = hit.t + 3;
        return { x: cx, y: cy, z: cz, exit: { x: cx - dx * reach, y: cy, z: cz - dz * reach, bx: hit.x, by: hit.y, bz: hit.z } };
      }
    }
    return null;
  }

  // From the open air, well off.
  findSky(player, eye, look) {
    for (let n = 0; n < 12; n++) {
      const [dx, dz] = this.bearing(look);
      const d = 70 + Math.random() * 25;
      const x = eye.x + dx * d, z = eye.z + dz * d;
      if (!this.world.isLoaded(x, z)) continue;
      const y = eye.y + 5 + Math.random() * 14;
      if (this.free(x, y, z)) return { x, y, z };
    }
    return null;
  }

  pickKind() {
    const w = this.s.wave, r = Math.random();
    const heavy = w >= 3 ? Math.min(0.3, 0.1 + 0.04 * (w - 3)) : 0;
    const scout = w >= 2 ? Math.min(0.4, 0.2 + 0.03 * w) : 0.15;
    return r < heavy ? 'heavy' : r < heavy + scout ? 'scout' : 'quad';
  }

  // A free-play wave drone: any kind, from wherever there is room.
  spawnOne(player, eye, look) {
    return !!this.spawn(this.pickKind(), 'any', player, eye, look);
  }

  // Launch one contact. pref: where a hostile attack drone should come from (inside | behind | sky |
  // any); it falls back to the next best place the map offers. Contacts that are not hostile always
  // come through open air. opts: { dir: [x, z] to launch from one side, spoof: answers IFF as friendly }.
  spawn(kind, pref, player, eye, look, opts = {}) {
    const def = TYPES[kind];
    this.fixedDir = opts.dir || null;
    let at = null, origin = 'sky';
    if (def.cls === 'ATTACK') {
      let order;
      if (pref === 'inside') order = ['inside', 'behind', 'sky'];
      else if (pref === 'behind') order = ['behind', 'inside', 'sky'];
      else if (pref === 'sky') order = ['sky'];
      else {
        const r = Math.random();
        order = r < 0.45 ? ['inside', 'behind', 'sky'] : r < 0.92 ? ['behind', 'sky'] : ['sky'];
      }
      for (const o of order) {
        at = o === 'inside' ? this.findInside(player, eye, look) : o === 'behind' ? this.findBehind(player, eye, look) : this.findSky(player, eye, look);
        if (at) {
          origin = o;
          break;
        }
      }
    } else at = this.findPass(def, eye, look);
    this.fixedDir = null;
    if (!at) return null;
    const m = build(def);
    this.group.add(m.mesh);
    const d = {
      n: this.nextId++, kind, def, cls: def.cls, origin, hp: def.hp, x: at.x, y: at.y, z: at.z, vx: 0, vy: 0, vz: 0, yaw: 0, age: 0, flash: 0,
      seen: false, los: false, radar: false, visual: false, observable: false, losAt: 0, stuck: 0, done: false, spoof: !!opts.spoof,
      state: origin === 'inside' ? 'lurk' : 'strike', lurk: 2.5 + Math.random() * 3, exit: at.exit || null,
      to: at.to || null, orbit: at.orbit || null, hdg: Math.random() * 6.28, hover: 4 + Math.random() * 3,
      wf: 1.2 + Math.random() * 1.6, ph: Math.random() * 6.28, ...m,
    };
    d.id = 'T' + String(d.n).padStart(2, '0');
    // what IFF says: the own drone answers (unless the sensors are degraded and it does not); a spoofed hostile answers too
    d.iff = d.spoof ? 'friend' : def.cls === 'FRIENDLY' ? (this.sensors.iff === 'degraded' && Math.random() < 0.5 ? 'none' : 'friend') : 'none';
    this.list.push(d);
    if (this.hooks.onSpawn) this.hooks.onSpawn(d);
    return d;
  }

  // Open air for a contact that is not hostile: a start well out, and where it heads (a pass-by
  // that crosses the player's sky), or an orbit round the player (the recon aircraft).
  findPass(def, eye, look) {
    for (let n = 0; n < 12; n++) {
      const [dx, dz] = this.bearing(look);
      const dist = 78 + Math.random() * 18;
      const x = eye.x + dx * dist, z = eye.z + dz * dist;
      if (!this.world.isLoaded(x, z)) continue;
      const hi = def.cls === 'RECON' ? 16 + Math.random() * 10 : def.cls === 'BIRD' ? 4 + Math.random() * 14 : 4 + Math.random() * 8;
      let y = eye.y + hi;
      for (let k = 0; k < 4 && !this.free(x, y, z); k++) y += 5;
      if (!this.free(x, y, z)) continue;
      if (def.cls === 'RECON') {
        const r = 38 + Math.random() * 16;
        return { x: eye.x + dx * r, y, z: eye.z + dz * r, orbit: { a: Math.atan2(dz, dx), r, dir: Math.random() < 0.5 ? 1 : -1, y } };
      }
      const turn = Math.PI + (Math.random() < 0.5 ? 1 : -1) * (0.35 + Math.random() * 0.55);
      const ex = eye.x + (dx * Math.cos(turn) - dz * Math.sin(turn)) * 92, ez = eye.z + (dx * Math.sin(turn) + dz * Math.cos(turn)) * 92;
      return { x, y, z, to: { x: ex, y, z: ez } };
    }
    return null;
  }

  // ---------------------------------------------------------------- the waves

  direct(dt, player, eye, look) {
    const s = this.s;
    if (s.rest > 0) {
      s.rest -= dt;
      if (s.rest <= 0) this.nextWave();
      return;
    }
    if (s.toSpawn > 0) {
      s.timer -= dt;
      if (s.timer <= 0 && this.list.length < s.cap) {
        if (this.spawnOne(player, eye, look)) {
          s.toSpawn--;
          s.timer = s.gap * (0.6 + Math.random() * 0.8);
        } else s.timer = 1;
      }
    } else if (this.list.length === 0) {
      s.rest = 7;
      s.score += 50 * s.wave;
      if (this.hooks.onClear) this.hooks.onClear();
      this.say(`Wave ${s.wave} cleared · +${50 * s.wave}`, 2600, true);
    }
  }

  nextWave() {
    const s = this.s;
    s.wave++;
    s.toSpawn = 4 + 2 * s.wave;
    s.cap = Math.min(2 + s.wave, 8);
    s.gap = Math.max(1.6, 5 - 0.3 * s.wave);
    s.timer = 1;
    this.say(`Wave ${s.wave} · ${s.toSpawn} drones inbound`, 2600, true);
  }

  say(text, ms = 1500, force = false) {
    if (!force && this.clock - this.sayAt < 1.3) return;
    this.sayAt = this.clock;
    if (this.hooks.toast) this.hooks.toast(text, ms);
  }

  // ---------------------------------------------------------------- flight

  // dt seconds. player: the player's feet; eye: their head; active: false while paused or dead
  // (everything hangs in the air then); look: the direction they face along the ground, [x, 0, z];
  // aim: where the camera points, [x, y, z] (what the eye can see).
  update(dt, player, eye, active, look, aim = look) {
    if (!this.enabled) return;
    this.clock += dt;
    this.last = eye;
    if (active && !this.training) this.direct(dt, player, eye, look);
    if (active) this.tickGhosts(dt, eye);
    for (let i = this.list.length - 1; i >= 0; i--) {
      const d = this.list[i];
      d.flash = Math.max(0, d.flash - dt);
      if (active) {
        d.age += dt;
        const away = Math.hypot(d.x - eye.x, d.y - eye.y, d.z - eye.z);
        if (d.done || away > 170 || d.age > (d.cls === 'ATTACK' ? 80 : (d.def.ttl || 60) + 40)) {
          this.expire(d, i); // it left, or was lost
          continue;
        }
        if (this.fly(d, dt, eye)) {
          this.strike(d, i, eye);
          continue;
        }
        this.sense(d, dt, eye, aim);
      }
      this.pose(d, dt);
    }
    this.sound(eye, look, active);
    this.uiAt -= dt;
    if (this.uiAt <= 0) {
      this.uiAt = 0.1;
      this.paint(eye, look);
    }
  }

  // A contact that is not hostile (or a hostile one that was lost) is gone.
  expire(d, i) {
    if (this.hooks.onExpire) this.hooks.onExpire(d);
    this.remove(i);
  }

  // The contacts that are not hostile: a pass-by, an orbit, a bird's wandering. Never goes off.
  flyNeutral(d, dt, eye) {
    const def = d.def;
    let tx, ty = d.y, tz, speed = def.speed;
    if (def.model === 'bird') {
      // erratic, and never far away
      d.hdg += (Math.random() - 0.5) * dt * 7;
      const away = Math.hypot(eye.x - d.x, eye.z - d.z);
      if (away > 75) d.hdg += turnTo(d.hdg, Math.atan2(eye.x - d.x, eye.z - d.z)) * dt * 2;
      tx = d.x + Math.sin(d.hdg) * 6;
      tz = d.z + Math.cos(d.hdg) * 6;
      ty = d.y + Math.sin(d.age * 2.3 + d.ph) * 2;
      speed *= 0.7 + 0.5 * Math.abs(Math.sin(d.age * 1.7 + d.ph));
      if (d.age > def.ttl) d.done = true;
    } else if (d.orbit) {
      const o = d.orbit;
      if (d.age > def.ttl) {
        // done watching: climbs and leaves along the way it was going round
        tx = d.x + (d.x - eye.x) * 3;
        tz = d.z + (d.z - eye.z) * 3;
        ty = o.y + 20;
      } else {
        o.a += (o.dir * speed / o.r) * dt;
        tx = eye.x + Math.cos(o.a) * o.r;
        tz = eye.z + Math.sin(o.a) * o.r;
        ty = o.y;
      }
    } else {
      tx = d.to.x;
      tz = d.to.z;
      ty = d.to.y;
      if (Math.hypot(tx - d.x, tz - d.z) < 3) d.done = true;
      if (d.cls === 'CIVILIAN') {
        // a commercial drone stops to look at something now and then
        d.hover -= dt;
        if (d.hover < 0) {
          speed = 0;
          if (d.hover < -2.5) d.hover = 5 + Math.random() * 4;
        }
      }
    }
    let vx = tx - d.x, vz = tz - d.z;
    const hl = Math.hypot(vx, vz);
    if (hl > 0.3) {
      vx = (vx / hl) * speed;
      vz = (vz / hl) * speed;
    } else vx = vz = 0;
    const vy = Math.max(-3, Math.min(3, (ty - d.y) * 1.2));
    const k = Math.min(1, dt * 2.5);
    d.vx += (vx - d.vx) * k;
    d.vy += (vy - d.vy) * k;
    d.vz += (vz - d.vz) * k;
    this.move(d, dt);
  }

  // Steer and move one drone. True when it has reached the player.
  fly(d, dt, eye) {
    const def = d.def;
    if (d.cls !== 'ATTACK') {
      this.flyNeutral(d, dt, eye);
      return false;
    }
    if (d.state === 'lurk') {
      d.lurk -= dt;
      if (d.lurk <= 0) d.state = 'breakout';
      return false;
    }
    const hx = eye.x - d.x, hz = eye.z - d.z, hd = Math.hypot(hx, hz) || 1;
    const ux = hx / hd, uz = hz / hd;
    let tx, ty, tz, speed = def.speed * this.speedMul;
    if (d.state === 'breakout') {
      // out through the pane and three metres beyond it
      tx = d.exit.x;
      ty = d.exit.y;
      tz = d.exit.z;
      speed *= 0.8;
      if (Math.hypot(tx - d.x, ty - d.y, tz - d.z) < 1) d.state = 'strike';
    } else {
      // weave across the line to the player, less the nearer it gets
      const sway = Math.sin(d.age * d.wf + d.ph) * Math.min(3.2, hd * 0.1) * def.wob;
      tx = eye.x - uz * sway;
      tz = eye.z + ux * sway;
      // glide down the last stretch, but never into what is in the way: climb over it
      ty = eye.y - 0.2 + Math.min(10, hd * 0.16);
      if (hd > 5) {
        let top = 0;
        for (const k of [2, 5, 9, 14, 20]) top = Math.max(top, this.column(d.x + ux * k, d.z + uz * k));
        ty = Math.max(ty, top + 2.5);
      }
      // while it has climbing to do it hardly goes forward
      speed *= 1 - Math.min(0.7, Math.max(0, (ty - d.y - 2) / 12));
    }
    let vx = tx - d.x, vz = tz - d.z;
    const hl = Math.hypot(vx, vz);
    if (hl > 0.3) {
      vx = (vx / hl) * speed;
      vz = (vz / hl) * speed;
    } else vx = vz = 0;
    const vmax = def.speed * this.speedMul * 0.9;
    const vy = Math.max(-vmax, Math.min(vmax, (ty - d.y) * 1.6));
    const k = Math.min(1, dt * 3.5);
    d.vx += (vx - d.vx) * k;
    d.vy += (vy - d.vy) * k;
    d.vz += (vz - d.vz) * k;
    this.move(d, dt);
    return d.state === 'strike' && Math.hypot(eye.x - d.x, eye.y - d.y, eye.z - d.z) < 1.5 + def.span * 0.5;
  }

  // One axis at a time, so it slides along what it cannot pass. Glass it breaks.
  move(d, dt) {
    const w = this.world;
    const open = (x, y, z) => {
      const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
      const id = w.getBlock(bx, by, bz);
      if (!SOLID[id]) return true;
      if (GLASSY.has(id) && d.cls === 'ATTACK' && d.state !== 'lurk') return this.shatter(bx, by, bz, id);
      return false;
    };
    let blocked = false;
    const nx = d.x + d.vx * dt, ny = d.y + d.vy * dt, nz = d.z + d.vz * dt;
    if (open(nx, d.y, d.z)) d.x = nx;
    else {
      d.vx *= -0.2;
      blocked = true;
    }
    if (open(d.x, ny, d.z)) d.y = ny;
    else {
      d.vy *= -0.2;
      blocked = true;
    }
    if (open(d.x, d.y, nz)) d.z = nz;
    else {
      d.vz *= -0.2;
      blocked = true;
    }
    // pinned against something: lift off it
    d.stuck = blocked ? d.stuck + dt : Math.max(0, d.stuck - dt);
    if (d.stuck > 0.4 && open(d.x, d.y + 3 * dt, d.z)) d.y += 3 * dt;
  }

  // A pane breaks: by an arrow, or by a drone going through it.
  shatter(x, y, z, id) {
    if (!this.world.setBlock(x, y, z, B.AIR)) return false;
    this.smashed.push([x, y, z, id]);
    this.fx.burst(x + 0.5, y + 0.5, z + 0.5, [0.72, 0.86, 0.95], 14, 5, 0.1, 0.9);
    sfx.dig('glass');
    return true;
  }

  // What the sensors make of a contact. los: nothing solid between the player's eye and it (every
  // quarter second). radar: tracked (needs a clear line, a range, and a radar that is working).
  // visual: in the line of sight, near enough for the light, inside the field of view.
  sense(d, dt, eye, aim) {
    d.losAt -= dt;
    if (d.losAt <= 0) {
      d.losAt = 0.25;
      d.los = false;
      if (d.state !== 'lurk') {
        const vx = d.x - eye.x, vy = d.y - eye.y, vz = d.z - eye.z, vl = Math.hypot(vx, vy, vz) || 1;
        d.los = !this.world.raycast(eye.x, eye.y, eye.z, vx / vl, vy / vl, vz / vl, vl - 0.6);
      }
    }
    const vx = d.x - eye.x, vy = d.y - eye.y, vz = d.z - eye.z, dist = Math.hypot(vx, vy, vz) || 1;
    d.dist = dist;
    d.radar = this.radarSees(d, dist);
    const al = Math.hypot(aim[0], aim[1], aim[2]) || 1;
    const cos = (vx * aim[0] + vy * aim[1] + vz * aim[2]) / (dist * al);
    d.angle = Math.acos(Math.max(-1, Math.min(1, cos))); // off the crosshair, radians
    d.visual = d.los && dist < VISUAL[this.env] && d.angle < 1.05;
    d.observable = d.radar || d.visual;
    if (!d.seen && d.observable) {
      d.seen = true;
      d.seenAt = this.clock;
      if (this.hooks.onObserve) this.hooks.onObserve(d);
      if (!this.training && d.cls === 'ATTACK') {
        const [fwd, side] = this.relative(d, eye, [aim[0], 0, aim[2]]);
        const hour = ((Math.round((Math.atan2(side, fwd) * 6) / Math.PI) + 11) % 12) + 1;
        this.say(`Contact — ${hour} o'clock${vy > 6 ? ', high' : vy < -6 ? ', low' : ''} · ${d.def.name}`, 1500);
      }
    }
  }

  radarSees(d, dist) {
    const r = this.sensors.radar;
    if (r === 'jammed' || !d.los) return false; // jammed, or hidden behind a building (radar shadow)
    if (r === 'degraded') {
      if (dist > 55) return false;
      // it flickers: each track drops out about a third of the time, twice a second
      const h = Math.imul(d.n * 2654435761 + Math.floor(this.clock * 2) * 40503, 2246822519) >>> 0;
      if (h % 100 < 30) return false;
    } else if (dist > RADAR) return false;
    return true;
  }

  // False tracks on a degraded radar: clutter that blinks up for a few seconds.
  tickGhosts(dt, eye) {
    this.ghosts = this.ghosts.filter((g) => g.exp > this.clock);
    if (!this.training || this.sensors.radar !== 'degraded') return;
    this.ghostT -= dt;
    if (this.ghostT > 0) return;
    this.ghostT = 7 + Math.random() * 9;
    const a = Math.random() * Math.PI * 2, r = 15 + Math.random() * 40;
    this.ghosts.push({ x: eye.x + Math.cos(a) * r, y: eye.y + 3 + Math.random() * 12, z: eye.z + Math.sin(a) * r, exp: this.clock + 4 + Math.random() * 3, id: 'T' + String(90 + (this.nextId++ % 10)) });
  }

  // What the track says about a contact: range, height, speed, heading, size, IFF. Degraded radar
  // gives less, jammed radar gives nothing (visual only).
  trackInfo(d, eye, player) {
    const mode = this.sensors.radar;
    const info = { id: d.id, range: Math.round(Math.hypot(d.x - eye.x, d.z - eye.z)), visual: d.visual, radar: d.radar };
    if (!d.radar || mode === 'jammed') return { ...info, noData: true };
    const sp = Math.hypot(d.vx, d.vy, d.vz);
    const toward = ((eye.x - d.x) * d.vx + (eye.z - d.z) * d.vz) > 0.5;
    info.speed = mode === 'degraded' ? Math.round(sp + (Math.random() - 0.5) * 4) : Math.round(sp * 10) / 10;
    info.alt = mode === 'degraded' ? null : Math.round(d.y - player.y);
    info.closing = toward;
    const span = d.def.span;
    info.rcs = span < 0.5 ? 'tiny' : span < 0.7 ? 'small' : span < 1 ? 'medium' : 'large';
    info.iff = d.iff === 'friend' ? 'FRIEND reply' : 'no reply';
    return info;
  }

  // Where a drone is as the player faces: [metres ahead, metres to the right].
  relative(d, eye, look) {
    const l = Math.hypot(look[0], look[2]) || 1;
    const fx = look[0] / l, fz = look[2] / l;
    const dx = d.x - eye.x, dz = d.z - eye.z;
    return [dx * fx + dz * fz, dx * -fz + dz * fx];
  }

  // The drone as drawn: turned the way it flies, leaning into it, rotors spinning.
  pose(d, dt) {
    const m = d.mesh;
    m.position.set(d.x, d.y + Math.sin(d.age * 7 + d.ph) * (d.def.model === 'bird' ? 0.01 : 0.03), d.z);
    const sp = Math.hypot(d.vx, d.vz);
    if (sp > 0.5) d.yaw += turnTo(d.yaw, Math.atan2(d.vx, d.vz)) * Math.min(1, dt * 5);
    m.rotation.set(d.def.model ? 0 : Math.min(0.5, sp * 0.045), d.yaw, 0, 'YXZ');
    for (const r of d.rotors) {
      if (r.userData.axis === 'z') r.rotation.z += dt * 60;
      else r.rotation.y += dt * 70 * r.userData.dir;
    }
    if (d.flap.length) {
      const f = Math.sin(d.age * 18 + d.ph) * 0.9;
      d.flap[0].rotation.z = f;
      d.flap[1].rotation.z = -f;
    }
    // beacons: hostile ones strobe, recon flashes slowly, own and commercial drones burn steady
    if (d.led) d.led.visible = d.cls === 'FRIENDLY' || d.cls === 'CIVILIAN' || Math.floor(d.age * (d.cls === 'RECON' ? 1.5 : 3)) % 2 === 0;
    d.bodyMat.color.setHex(d.flash > 0 ? 0xff4a3a : d.def.color);
  }

  // It got there.
  strike(d, i, eye) {
    const dx = eye.x - d.x, dz = eye.z - d.z, l = Math.hypot(dx, dz) || 1;
    this.fx.burst(d.x, d.y, d.z, [1, 0.7, 0.25], 34, 10, 0.14, 0.55);
    this.fx.burst(d.x, d.y, d.z, [0.3, 0.3, 0.32], 26, 4, 0.45, 1.8, 1.6);
    sfx.boom(3);
    this.s.leaked++;
    this.remove(i);
    if (this.hooks.onStrike) this.hooks.onStrike(d.def.dmg, dx / l, dz / l, d);
  }

  // ---------------------------------------------------------------- arrows

  // The player's arrow flew from (a.x, a.y, a.z) along dir for `reach` metres: did it meet a
  // drone? True when it did (the arrow is spent). A drone still in its room cannot be hit.
  arrowHit(a, dir, reach) {
    if (!this.enabled) return false;
    let best = null, bt = Infinity;
    for (const d of this.list) {
      if (d.state === 'lurk') continue;
      const r = d.def.span * 0.5 + HIT_PAD;
      const ox = d.x - a.x, oy = d.y - a.y, oz = d.z - a.z;
      const t = Math.max(0, Math.min(reach, ox * dir[0] + oy * dir[1] + oz * dir[2]));
      const px = a.x + dir[0] * t - d.x, py = a.y + dir[1] * t - d.y, pz = a.z + dir[2] * t - d.z;
      if (px * px + py * py + pz * pz < r * r && t < bt) {
        best = d;
        bt = t;
      }
    }
    if (!best) return false;
    const d = best;
    if (this.hooks.onHit) this.hooks.onHit(d, a);
    d.hp -= a.damage;
    d.flash = 0.18;
    d.vx += dir[0] * 2;
    d.vz += dir[2] * 2;
    this.fx.sparks(d.x, d.y, d.z);
    if (d.hp > 0) {
      sfx.thud();
      return true;
    }
    this.down(d);
    return true;
  }

  // Shot down: scrap flying, points for it (more for a long shot).
  down(d) {
    const i = this.list.indexOf(d);
    if (i < 0) return;
    const [r, g, b] = [(d.def.color >> 16) / 255, ((d.def.color >> 8) & 255) / 255, (d.def.color & 255) / 255];
    this.fx.burst(d.x, d.y, d.z, [Math.min(1, r * 2), Math.min(1, g * 2), Math.min(1, b * 2)], 18, 6, 0.12, 1.1);
    this.fx.burst(d.x, d.y, d.z, [1, 0.62, 0.2], 10, 4, 0.08, 0.6);
    sfx.pop();
    sfx.hit();
    const s = this.s;
    if (!this.training) {
      s.downed++;
      s.score += d.def.score + Math.floor(Math.hypot(d.x - this.last.x, d.z - this.last.z));
    }
    if (this.hooks.onDown) this.hooks.onDown(d);
    this.remove(i);
  }

  // An arrow met a pane: it breaks, and the arrow flies on. Anything waiting behind that pane
  // knows it has been seen.
  smash(wall) {
    if (!this.enabled || !GLASSY.has(wall.id)) return false;
    if (!this.shatter(wall.x, wall.y, wall.z, wall.id)) return false;
    for (const d of this.list) {
      if (d.state === 'lurk' && d.exit && d.exit.bx === wall.x && d.exit.by === wall.y && d.exit.bz === wall.z) d.lurk = Math.min(d.lurk, 0.3);
    }
    return true;
  }

  // ---------------------------------------------------------------- sound, radar, scoreboard

  sound(eye, look, active) {
    if (!active || !this.list.length) return droneHum.set(0);
    let level = 0, near = null, nd = Infinity;
    for (const d of this.list) {
      if (d.cls === 'BIRD') continue; // birds do not whine
      const dist = Math.hypot(d.x - eye.x, d.y - eye.y, d.z - eye.z);
      const l = Math.max(0, 1 - dist / 120) * (d.state === 'lurk' ? 0.35 : 1); // muffled behind walls
      if (l > level) level = l;
      if (dist < nd) {
        nd = dist;
        near = d;
      }
    }
    if (!near) return droneHum.set(0);
    const [, side] = this.relative(near, eye, look);
    droneHum.set(level, near.def.pitch, side / Math.max(8, nd));
  }

  // The scoreboard and the radar. The radar shows what it is tracking (not what is hiding in a room,
  // not what is behind a building: those one only hears), through the radar's own faults: short range,
  // flicker and jitter when degraded, nothing but noise when jammed. In a training session the dots wear
  // the colour of the label the trainee gave them, and unlabelled ones are white.
  paint(eye, look) {
    const s = this.s;
    if (this.hud) {
      if (this.training) this.hud.innerHTML = this.training.hud();
      else {
        const gap = s.rest > 0 ? `<i>next wave in ${Math.ceil(s.rest)}</i>` : `<i>inbound ${s.toSpawn + this.list.length}</i>`;
        this.hud.innerHTML = `<b>WAVE ${Math.max(1, s.wave)}</b><span>DOWNED <em>${s.downed}</em></span><span class="leak">LEAKED <em>${s.leaked}</em></span><span>SCORE <em>${s.score.toLocaleString('en-US')}</em></span>${gap}`;
      }
    }
    const c = this.radar;
    if (!c) return;
    const S = 160, h = S / 2, k = (h - 6) / RADAR, mode = this.sensors.radar;
    c.clearRect(0, 0, S, S);
    c.fillStyle = 'rgba(6, 20, 12, 0.82)';
    c.beginPath();
    c.arc(h, h, h - 1, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = 'rgba(80, 255, 140, 0.35)';
    c.lineWidth = 1;
    for (const r of [RADAR / 3, (RADAR * 2) / 3, RADAR]) {
      c.beginPath();
      c.arc(h, h, r * k, 0, Math.PI * 2);
      c.stroke();
    }
    c.beginPath();
    c.moveTo(h, 4);
    c.lineTo(h, S - 4);
    c.moveTo(4, h);
    c.lineTo(S - 4, h);
    c.stroke();
    // the player's field of view, a wedge pointing up
    c.fillStyle = 'rgba(80, 255, 140, 0.10)';
    c.beginPath();
    c.moveTo(h, h);
    c.arc(h, h, h - 2, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55);
    c.closePath();
    c.fill();
    if (mode === 'jammed') {
      // nothing but noise
      c.fillStyle = 'rgba(180, 255, 200, 0.35)';
      for (let n = 0; n < 70; n++) c.fillRect(Math.random() * S, Math.random() * S, 2, 1);
      c.fillStyle = '#ff6b6b';
      c.font = 'bold 12px monospace';
      c.textAlign = 'center';
      c.fillText('JAMMED', h, h - 22);
    } else {
      const jit = (n, a) => (((Math.imul(n * 7919 + a * 104729 + Math.floor(this.clock * 2) * 31, 2654435761) >>> 0) % 9) - 4) * (mode === 'degraded' ? 1 : 0);
      const dots = [];
      for (const d of this.list) if (d.radar) dots.push({ d, x: d.x + jit(d.n, 1), z: d.z + jit(d.n, 2), color: this.training ? this.training.colorOf(d) : d.def.dot, big: d.def.span > 1 });
      for (const g of this.ghosts) dots.push({ g, x: g.x, z: g.z, color: this.training ? this.training.ghostColor(g) : '#e8e8e8', big: false });
      let danger = false;
      for (const o of dots) {
        let [fwd, side] = this.relative(o, eye, look);
        const dist = Math.hypot(fwd, side);
        if (o.d && o.d.cls === 'ATTACK' && dist < 30) danger = true;
        if (dist > RADAR) {
          fwd = (fwd / dist) * RADAR;
          side = (side / dist) * RADAR;
        }
        const px = h + side * k, py = h - fwd * k;
        c.fillStyle = o.color;
        c.beginPath();
        c.arc(px, py, o.big ? 4.5 : 3.2, 0, Math.PI * 2);
        c.fill();
        if (this.training && this.training.designated === (o.d || o.g)) {
          c.strokeStyle = '#fff';
          c.lineWidth = 1.5;
          c.beginPath();
          c.arc(px, py, 7, 0, Math.PI * 2);
          c.stroke();
        }
      }
      c.fillStyle = danger && Math.floor(this.clock * 4) % 2 ? '#ff4d4d' : '#9dffbe';
      c.beginPath();
      c.arc(h, h, 3, 0, Math.PI * 2);
      c.fill();
    }
  }
}
