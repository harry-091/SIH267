// A training session: launches a scenario's contacts on its timeline, takes the trainee's calls
// (T designates what is under the crosshair, 1-5 classify it), keeps a record of every contact
// for the scoring (scoring.js), then shows the after-action review and sends the session to the
// server for the dashboard.
//
// The drill, per contact:  spot it -> T (designate) -> 1..5 (classify) -> engage or hold fire.
import * as THREE from 'three';
import { CLASSES, CLASS_NAMES, ROE, scoreSession, coach } from './scoring.js';
import { api, queueSession } from './api.js';

const KEYS = { Digit1: 'ATTACK', Digit2: 'RECON', Digit3: 'FRIENDLY', Digit4: 'CIVILIAN', Digit5: 'BIRD', Numpad1: 'ATTACK', Numpad2: 'RECON', Numpad3: 'FRIENDLY', Numpad4: 'CIVILIAN', Numpad5: 'BIRD' };
const LABEL = { ATTACK: 'HOSTILE ATTACK', RECON: 'HOSTILE RECON', FRIENDLY: 'FRIENDLY', CIVILIAN: 'CIVILIAN', BIRD: 'BIRD / CLUTTER' };
const COLOR = { ATTACK: '#ff4d4d', RECON: '#ffb347', FRIENDLY: '#4dff88', CIVILIAN: '#6ab7ff', BIRD: '#9aa0a8' };
const BRIEF = 10; // seconds of briefing before the first contact
const NIGHT = { day: 0, dusk: 0.38, night: 0.72 };
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export class Training {
  // opts: drones, world, toast(text, ms), enable(), disable(), isDead(), onEnd(session, metrics)
  constructor(opts) {
    Object.assign(this, opts);
    this.running = false;
    this.designated = null;
    this.prompt = null;
    this.card = document.getElementById('trk-card');
    this.aar = document.getElementById('aar');
    this.night = document.getElementById('night');
    this.tags = document.getElementById('tags');
    this.ctx = this.tags ? this.tags.getContext('2d') : null;
    this.v = new THREE.Vector3();
    this.onKey = this.onKey.bind(this);
  }

  // ---------------------------------------------------------------- lifecycle

  start(scenario, player, eye, look) {
    const d = this.drones;
    this.end(true);
    this.enable(); // drone defence on: the bow, the flat arrows, the radar
    d.reset();
    this.sc = scenario;
    this.t = -BRIEF;
    this.next = 0;
    this.retry = new Map();
    this.skipped = 0;
    this.grpDir = {};
    this.contacts = [];
    this.events = [];
    this.shots = 0;
    this.hits = 0;
    this.falseAlarms = 0;
    this.finished = false;
    this.died = false;
    this.startedAt = new Date().toISOString();
    this.terrain = this.measureTerrain(player, eye);
    this.timeline = scenario.timeline.slice().sort((a, b) => a.t - b.t);
    d.sensors = { ...scenario.sensors };
    d.env = scenario.env;
    d.speedMul = scenario.speedMul || 1;
    d.ghosts = [];
    d.training = this;
    this.saved = {};
    for (const k of ['onSpawn', 'onObserve', 'onHit', 'onDown', 'onExpire', 'onStrike']) this.saved[k] = d.hooks[k];
    d.hooks.onSpawn = (c) => this.spawned(c);
    d.hooks.onObserve = (c) => this.observed(c);
    d.hooks.onHit = (c) => this.engaged(c);
    d.hooks.onDown = (c) => this.resolve(c, 'neutralized');
    d.hooks.onExpire = (c) => this.resolve(c, 'expired');
    d.hooks.onStrike = (n, dx, dz, c) => {
      this.resolve(c, 'leaked');
      if (this.saved.onStrike) this.saved.onStrike(n, dx, dz, c);
    };
    if (this.night) this.night.style.opacity = NIGHT[scenario.env];
    document.addEventListener('keydown', this.onKey, true);
    this.running = true;
    this.hideAar();
    const note = this.terrain === 'rural' && scenario.terrain === 'urban' ? ' This place has few buildings: ambushes launch from open sky instead.' : '';
    this.toast(`${scenario.name}: contacts in ${BRIEF}s. T designates, 1-5 classify, then engage or hold fire.${note}`, 7000);
  }

  // Stop without scoring (a new session starting, or the mode being switched off).
  end(silent = false) {
    if (!this.running && !silent) return;
    const d = this.drones;
    if (this.saved) for (const [k, v] of Object.entries(this.saved)) d.hooks[k] = v;
    this.saved = null;
    d.training = null;
    d.sensors = { radar: 'full', iff: 'ok' };
    d.env = 'day';
    d.speedMul = 1;
    d.ghosts = [];
    document.removeEventListener('keydown', this.onKey, true);
    this.running = false;
    this.designated = null;
    this.closePrompt();
    if (this.night) this.night.style.opacity = 0;
    if (this.ctx) this.ctx.clearRect(0, 0, this.tags.width, this.tags.height);
  }

  // Urban, suburban or rural, by how much of the ground around the player is built up.
  measureTerrain(player, eye) {
    const w = this.world;
    let tall = 0, n = 0;
    for (let a = 0; a < 24; a++) {
      for (let r = 20; r <= 80; r += 10) {
        const x = Math.floor(eye.x + Math.cos((a / 24) * 6.283) * r), z = Math.floor(eye.z + Math.sin((a / 24) * 6.283) * r);
        if (!w.isLoaded(x, z)) continue;
        n++;
        if (w.topY(x, z) > player.y + 7) tall++;
      }
    }
    const f = n ? tall / n : 0;
    return f > 0.25 ? 'urban' : f > 0.08 ? 'suburban' : 'rural';
  }

  // ---------------------------------------------------------------- per frame

  update(dt, player, eye, look, active) {
    if (!this.running || this.finished) return;
    if (this.isDead()) return this.finish('died');
    if (!active) return;
    this.t += dt;
    const d = this.drones;
    // launch what is due
    while (this.next < this.timeline.length && this.timeline[this.next].t <= this.t) {
      const e = this.timeline[this.next];
      const tries = this.retry.get(e) || 0;
      let dir = null;
      if (e.grp) {
        if (!this.grpDir[e.grp]) this.grpDir[e.grp] = d.bearing(look);
        dir = this.grpDir[e.grp];
      }
      const c = d.spawn(e.kind, e.origin || 'any', player, eye, look, { dir, spoof: e.spoof });
      if (!c) {
        // no room found on the map this time: try again shortly, then give up on that one
        if (tries < 4) {
          this.retry.set(e, tries + 1);
          e.t = this.t + 2;
          this.timeline.sort((a, b) => a.t - b.t);
          break;
        }
        this.skipped++;
      }
      this.next++;
    }
    // finished: everything launched, everything resolved
    if (this.next >= this.timeline.length && !d.list.length) return this.finish('complete');
    if (this.t > this.sc.limit) return this.finish('timeout');
    if (this.prompt && d.clock > this.prompt.until) this.closePrompt();
    if (this.designated && !d.list.includes(this.designated) && !d.ghosts.includes(this.designated)) {
      this.designated = null;
      this.closePrompt();
    }
  }

  log(type, c, extra = {}) {
    this.events.push({ t: Math.round(this.t * 10) / 10, type, id: c ? c.id : null, ...extra });
  }

  // ---------------------------------------------------------------- contact records (the drone hooks)

  spawned(c) {
    const speed = c.def.speed * (c.cls === 'ATTACK' ? this.drones.speedMul : 1);
    const eye = this.drones.last;
    const away = Math.hypot(c.x - eye.x, c.z - eye.z);
    c.rec = {
      id: c.id, kind: c.kind, truth: c.cls, origin: c.cls === 'ATTACK' ? c.origin : 'sky', spoof: c.spoof, tSpawn: this.t, tObs: null, tDes: null,
      guess: null, guessT: null, changes: 0, engaged: false, engageT: null, engageRange: null, guessAtEngage: null, outcome: null, outcomeT: null,
      eta: c.cls === 'ATTACK' ? Math.round((this.t + away / speed + 1) * 10) / 10 : null,
    };
    this.contacts.push(c.rec);
    this.log('launch', c, { truth: c.cls, origin: c.rec.origin });
  }

  observed(c) {
    if (!c.rec) return;
    c.rec.tObs = this.t;
    this.log('observable', c, { by: c.radar && c.visual ? 'radar+visual' : c.radar ? 'radar' : 'visual' });
  }

  engaged(c) {
    const r = c.rec;
    if (!r) return;
    this.hits++;
    if (r.engaged) return;
    r.engaged = true;
    r.engageT = this.t;
    r.engageRange = Math.round(c.dist || 0);
    r.guessAtEngage = r.guess;
    this.log('engaged', c, { guess: r.guess });
  }

  resolve(c, outcome) {
    const r = c.rec;
    if (!r || r.outcome) return;
    r.outcome = outcome;
    r.outcomeT = this.t;
    this.log(outcome, c);
    if (this.designated === c) {
      this.designated = null;
      this.closePrompt();
    }
  }

  fired() {
    if (this.running && this.t >= 0) this.shots++;
  }

  // ---------------------------------------------------------------- the trainee's calls

  // T: designate what is under the crosshair (or the nearest track to it).
  designate(player, eye, aim) {
    if (!this.running || this.finished || this.t < 0) return;
    const d = this.drones;
    let best = null, bestA = Infinity;
    for (const c of d.list) {
      if (!c.observable) continue;
      const lim = c.visual ? 0.2 : 0.35;
      if (c.angle < lim && c.angle < bestA) {
        best = c;
        bestA = c.angle;
      }
    }
    if (d.sensors.radar !== 'jammed') {
      const al = Math.hypot(aim[0], aim[1], aim[2]) || 1;
      for (const g of d.ghosts) {
        const vx = g.x - eye.x, vy = g.y - eye.y, vz = g.z - eye.z, vl = Math.hypot(vx, vy, vz) || 1;
        const ang = Math.acos(Math.max(-1, Math.min(1, (vx * aim[0] + vy * aim[1] + vz * aim[2]) / (vl * al))));
        if (ang < 0.3 && ang < bestA) {
          best = g;
          bestA = ang;
        }
      }
    }
    if (!best) return this.toast('No contact under the crosshair. Aim at a contact (or its radar track) and press T.', 2200);
    if (best.rec === undefined) {
      // a radar ghost: nothing there
      d.ghosts = d.ghosts.filter((g) => g !== best);
      this.falseAlarms++;
      this.log('false_alarm', null, { id: best.id });
      return this.toast(`${best.id}: no contact. That was a radar ghost.`, 2400);
    }
    this.designated = best;
    const r = best.rec;
    if (r.tDes == null) {
      r.tDes = this.t;
      this.log('designated', best);
    }
    this.openPrompt(best, player, eye);
  }

  openPrompt(c, player, eye) {
    const i = this.drones.trackInfo(c, eye, player);
    this.prompt = { c, until: this.drones.clock + 9 };
    if (!this.card) return;
    const data = i.noData
      ? `<span class="bad">NO TRACK DATA</span> visual only · range ~${i.range} m`
      : [`range ${i.range} m`, i.alt == null ? 'alt ??' : `alt ${i.alt} m`, `${i.speed} m/s ${i.closing ? 'closing' : 'opening'}`, `RCS ${i.rcs}`, `IFF ${i.iff}`].join(' · ');
    const cur = c.rec.guess;
    this.card.innerHTML = `<div class="trk-head"><b>${esc(i.id)}</b> ${data}</div><div class="trk-opts">${CLASSES.map((k, n) => `<span class="${cur === k ? 'cur' : ''}" style="--c:${COLOR[k]}"><kbd>${n + 1}</kbd> ${LABEL[k]}</span>`).join('')}</div><div class="trk-foot">Esc: cancel · classify, then engage or hold fire</div>`;
    this.card.classList.remove('hidden');
  }

  closePrompt() {
    this.prompt = null;
    if (this.card) this.card.classList.add('hidden');
  }

  classify(guess) {
    const c = this.prompt && this.prompt.c;
    if (!c || !c.rec) return;
    const r = c.rec;
    if (r.guess && r.guess !== guess) r.changes++;
    r.guess = guess;
    r.guessT = this.t;
    this.log('classified', c, { guess });
    this.closePrompt();
    this.toast(`${c.id} marked ${LABEL[guess]}`, 1400);
  }

  onKey(e) {
    if (!this.prompt) return;
    const guess = KEYS[e.code];
    if (guess || e.code === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation(); // not the hotbar, not the menu
      if (guess) this.classify(guess);
      else this.closePrompt();
    }
  }

  // ---------------------------------------------------------------- what the player sees

  colorOf(c) {
    return c.rec && c.rec.guess ? COLOR[c.rec.guess] : '#f2f2f2';
  }

  ghostColor() {
    return '#f2f2f2';
  }

  hud() {
    const sc = this.sc, d = this.drones;
    if (this.t < 0) return `<b>BRIEFING</b><span>${esc(sc.name)}</span><span>contacts in ${Math.ceil(-this.t)}s</span><i>T designate · 1-5 classify · engage hostiles, hold fire on the rest</i>`;
    const cond = [sc.env === 'day' ? '' : sc.env.toUpperCase(), d.sensors.radar === 'full' ? '' : `RADAR ${d.sensors.radar.toUpperCase()}`, d.sensors.iff === 'degraded' ? 'IFF DEGRADED' : ''].filter(Boolean).join(' · ');
    const leaked = this.contacts.filter((c) => c.outcome === 'leaked').length;
    return `<b>${esc(sc.id)} · ${fmt(this.t)}</b><span>CONTACTS <em>${this.contacts.length}/${this.timeline.length}</em></span><span class="leak">LEAKED <em>${leaked}</em></span>${cond ? `<i class="warn">${cond}</i>` : ''}`;
  }

  // Brackets on contacts the trainee has labelled, a ring on the designated one, and at dusk and
  // night the beacon lights that make a drone visible at all.
  drawOverlay(camera) {
    const c = this.ctx, cv = this.tags;
    if (!c) return;
    const W = window.innerWidth, H = window.innerHeight;
    if (cv.width !== W || cv.height !== H) {
      cv.width = W;
      cv.height = H;
    }
    c.clearRect(0, 0, W, H);
    const d = this.drones;
    if (!d.enabled) return;
    const dark = d.env !== 'day';
    for (const dr of d.list) {
      if (dr.state === 'lurk') continue;
      this.v.set(dr.x, dr.y, dr.z).project(camera);
      if (this.v.z > 1 || Math.abs(this.v.x) > 1.05 || Math.abs(this.v.y) > 1.05) continue;
      const x = (this.v.x * 0.5 + 0.5) * W, y = (-this.v.y * 0.5 + 0.5) * H;
      if (dark && dr.visual && dr.led && dr.led.visible) {
        const col = '#' + dr.def.led.toString(16).padStart(6, '0');
        c.shadowColor = col;
        c.shadowBlur = 14;
        c.fillStyle = col;
        c.beginPath();
        c.arc(x, y, 3.2, 0, 6.283);
        c.fill();
        c.shadowBlur = 0;
      }
      if (!this.running || !dr.observable) continue;
      const r = dr.rec;
      const mine = r && r.guess, sel = this.designated === dr;
      if (!mine && !sel) continue;
      const col = mine ? COLOR[r.guess] : '#fff', s = Math.max(12, Math.min(34, 280 / Math.max(6, dr.dist || 40)));
      c.strokeStyle = col;
      c.lineWidth = sel ? 2.5 : 1.5;
      c.beginPath();
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        c.moveTo(x + sx * s, y + sy * (s - 7));
        c.lineTo(x + sx * s, y + sy * s);
        c.lineTo(x + sx * (s - 7), y + sy * s);
      }
      c.stroke();
      c.fillStyle = col;
      c.font = '12px monospace';
      c.textAlign = 'left';
      c.fillText(`${dr.id}${mine ? ' ' + LABEL[r.guess] : ''}`, x + s + 4, y - s + 10);
    }
  }

  // ---------------------------------------------------------------- the end

  async finish(reason) {
    if (this.finished) return;
    this.finished = true;
    this.died = reason === 'died';
    this.closePrompt();
    // whatever is still in the air is settled as it would have ended
    for (const c of this.drones.list) if (c.rec && !c.rec.outcome) c.rec.outcome = c.cls === 'ATTACK' ? 'leaked' : 'expired';
    for (const r of this.contacts) if (!r.outcome) r.outcome = ROE[r.truth] === 'engage' && r.truth === 'ATTACK' ? 'leaked' : 'expired';
    const sc = this.sc;
    const session = {
      version: 1, scenarioId: sc.id, scenarioName: sc.name, procedural: !!sc.procedural, seed: sc.seed ?? null, signature: sc.signature || null,
      difficulty: sc.difficulty, env: sc.env, sensors: sc.sensors, terrain: this.terrain, startedAt: this.startedAt,
      duration: Math.round(Math.max(0, this.t)), reason, died: this.died, shots: this.shots, hits: this.hits, falseAlarms: this.falseAlarms,
      contacts: this.contacts, events: this.events, skipped: this.skipped,
    };
    const m = scoreSession(session);
    this.end();
    this.disable();
    this.showAar(session, m, null);
    // to the server (or the queue, when there is no server or no login)
    const res = await api('/api/sessions', { method: 'POST', body: { session } });
    let saved = res.ok ? 'saved' : res.status === 401 ? 'login' : 'offline';
    if (!res.ok) queueSession(session);
    this.showAar(session, m, saved, res.ok ? res.data : null);
    if (this.onEnd) this.onEnd(session, m);
  }

  hideAar() {
    if (this.aar) this.aar.classList.add('hidden');
  }

  showAar(session, m, saved) {
    if (!this.aar) return;
    document.exitPointerLock?.();
    const bar = (label, v) => `<div class="aar-bar"><span>${label}</span><i><u style="width:${v}%"></u></i><b>${v}</b></div>`;
    const rows = session.contacts
      .map((c, i) => {
        const p = m.perContact[i];
        const step = [
          c.tDes == null ? '<s>not designated</s>' : `designated ${p.detectTime}s after it appeared`,
          c.guess ? (c.guess === c.truth ? `called ${LABEL[c.guess]} ✔` : `called ${LABEL[c.guess]} ✘`) : '<s>not classified</s>',
          c.engaged ? 'engaged' : 'held fire',
          c.outcome === 'neutralized' ? 'NEUTRALISED' : c.outcome === 'leaked' ? '<em class="bad">REACHED YOU</em>' : 'left the area',
        ].join(' → ');
        const cls = p.total >= 70 ? 'good' : p.total >= 40 ? 'mid' : 'bad';
        return `<tr><td>${esc(c.id)}</td><td>${LABEL[c.truth]}${c.spoof ? ' <small>(IFF spoofed)</small>' : ''}<br><small>${c.truth === 'ATTACK' ? esc(c.origin) : ''}</small></td><td>${step}${p.violation ? `<br><em class="bad">${p.violation}</em>` : ''}</td><td class="${cls}"><b>${p.total}</b><br><small>${p.detect}+${p.classify}+${p.decide}${p.penalty ? '−' + p.penalty : ''}</small></td></tr>`;
      })
      .join('');
    const status = saved === 'saved' ? 'Saved to your record.' : saved === 'login' ? 'Not signed in: result kept on this device. <a href="/dashboard.html">Sign in</a> to upload it.' : saved === 'offline' ? 'Server unreachable: result kept on this device and uploaded next time.' : 'Saving…';
    this.aar.innerHTML = `<div class="aar-box"><h2>After-action review <small>${esc(session.scenarioName)}</small></h2>
      <div class="aar-top"><div class="aar-grade g${m.grade}"><b>${m.score}</b><span>${m.grade}${m.passed ? ' · PASS' : m.died ? ' · OVERRUN' : ' · below 70'}</span></div>
      <div class="aar-bars">${bar('Detection', m.skills.detect)}${bar('Classification', m.skills.classify)}${bar('Engagement decisions', m.skills.decide)}</div></div>
      <div class="aar-kpis"><span>Contacts <b>${m.contacts}</b></span><span>Mean time to designate <b>${m.meanDetect ?? '–'} s</b></span><span>Leaked <b>${m.leaks}</b></span><span>Fratricide <b>${m.fratricide}</b></span><span>Collateral <b>${m.collateral}</b></span><span>False alarms <b>${m.falseAlarms}</b></span><span>Arrow accuracy <b>${m.accuracy ?? '–'}${m.accuracy == null ? '' : '%'}</b></span>${m.triage != null ? `<span>Swarm triage <b>${m.triage}%</b></span>` : ''}</div>
      <ul class="aar-coach">${coach(m, session).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      <div class="aar-scroll"><table><thead><tr><th>ID</th><th>Was</th><th>Your decision path</th><th>Score</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="aar-status">${status}</p>
      <div class="aar-btns"><button id="aar-next" type="button">Next scenario</button><a href="/dashboard.html" target="_blank" rel="noopener">Open dashboard</a><button id="aar-close" type="button">Close</button></div></div>`;
    this.aar.classList.remove('hidden');
    document.getElementById('aar-close').onclick = () => this.hideAar();
    document.getElementById('aar-next').onclick = () => {
      this.hideAar();
      if (this.onNext) this.onNext();
    };
  }
}
