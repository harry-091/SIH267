// Threat scenarios: a scripted library, a seeded procedural generator, and the rule that picks
// the next difficulty from how a trainee has been doing. Pure functions (no DOM), shared by the
// game, the server and the dashboard.
//
// A scenario is a timeline of contacts the game launches:
//   { t, kind, origin, grp?, spoof? }
//   kind:   scout | quad | heavy (hostile attack), recon (hostile surveillance),
//           friendly | civil | bird (not hostile: hold fire)
//   origin: inside | behind | sky | any   (hostile attack drones; the rest are always in open air)
//   grp:    contacts sharing a group come from the same direction (a swarm)
//   spoof:  an attack drone that answers IFF as friendly
// plus the conditions: env (day | dusk | night), sensors { radar: full | degraded | jammed,
// iff: ok | degraded }, speedMul (how fast the hostile drones fly), limit (seconds).

export const KINDS = {
  scout: { cls: 'ATTACK' }, quad: { cls: 'ATTACK' }, heavy: { cls: 'ATTACK' },
  recon: { cls: 'RECON' }, friendly: { cls: 'FRIENDLY' }, civil: { cls: 'CIVILIAN' }, bird: { cls: 'BIRD' },
};

// mulberry32: a small seeded generator, so a seed always rebuilds the same scenario
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FULL = { radar: 'full', iff: 'ok' };

export const SCRIPTED = [
  {
    id: 'S1', name: 'First contact', difficulty: 1, env: 'day', sensors: FULL, terrain: 'any', speedMul: 0.9, limit: 150,
    summary: 'One attack quad from open sky, a civilian drone passing, then a scout from behind a building. Learn the drill: designate (T), classify (1-5), engage.',
    timeline: [{ t: 10, kind: 'quad', origin: 'sky' }, { t: 28, kind: 'civil' }, { t: 48, kind: 'scout', origin: 'behind' }],
  },
  {
    id: 'S2', name: 'Roofline ambush', difficulty: 2, env: 'day', sensors: FULL, terrain: 'urban', speedMul: 1, limit: 170,
    summary: 'Three quads launched from behind buildings, with a friendly patrol crossing in between. They appear over the rooftops.',
    timeline: [{ t: 10, kind: 'quad', origin: 'behind' }, { t: 26, kind: 'friendly' }, { t: 34, kind: 'quad', origin: 'behind' }, { t: 52, kind: 'quad', origin: 'behind' }],
  },
  {
    id: 'S3', name: 'Through the glass', difficulty: 3, env: 'day', sensors: FULL, terrain: 'urban', speedMul: 1, limit: 170,
    summary: 'Drones waiting inside buildings smash out through the windows. Listen for the whine. A bird crosses to test your calls.',
    timeline: [{ t: 12, kind: 'quad', origin: 'inside' }, { t: 28, kind: 'bird' }, { t: 36, kind: 'scout', origin: 'inside' }, { t: 58, kind: 'quad', origin: 'inside' }],
  },
  {
    id: 'S4', name: 'Swarm: six scouts', difficulty: 4, env: 'day', sensors: FULL, terrain: 'any', speedMul: 1, limit: 160,
    summary: 'Six scouts arrive together from one direction, with a friendly overflight. Triage: engage the one that will reach you first.',
    timeline: [
      ...[0, 1, 2, 3, 4, 5].map((i) => ({ t: 12 + i * 1.4, kind: 'scout', origin: i % 2 ? 'sky' : 'behind', grp: 'A' })),
      { t: 40, kind: 'friendly' },
    ],
  },
  {
    id: 'S5', name: 'Night watch', difficulty: 5, env: 'night', sensors: FULL, terrain: 'any', speedMul: 1, limit: 200,
    summary: 'After dark, only beacon lights show. A hostile recon drone orbits; later an attack quad, a civilian and a friendly come through.',
    timeline: [{ t: 6, kind: 'recon' }, { t: 40, kind: 'quad', origin: 'behind' }, { t: 62, kind: 'civil' }, { t: 80, kind: 'friendly' }, { t: 96, kind: 'bird' }],
  },
  {
    id: 'S6', name: 'Degraded radar', difficulty: 6, env: 'dusk', sensors: { radar: 'degraded', iff: 'ok' }, terrain: 'urban', speedMul: 1.1, limit: 210,
    summary: 'Radar is short-ranged, flickering and throws false tracks. Confirm by eye. Mixed hostile and friendly traffic at dusk.',
    timeline: [
      { t: 10, kind: 'quad', origin: 'behind' }, { t: 24, kind: 'civil' }, { t: 34, kind: 'scout', origin: 'inside' }, { t: 50, kind: 'friendly' },
      { t: 62, kind: 'quad', origin: 'behind' }, { t: 74, kind: 'bird' }, { t: 88, kind: 'heavy', origin: 'sky' }, { t: 100, kind: 'recon' },
    ],
  },
  {
    id: 'S7', name: 'Jammed: eyes only', difficulty: 7, env: 'dusk', sensors: { radar: 'jammed', iff: 'degraded' }, terrain: 'any', speedMul: 1.1, limit: 220,
    summary: 'Radar is jammed and IFF is unreliable: visual search only. A four-drone swarm and a recon drone, with decoy traffic.',
    timeline: [
      { t: 10, kind: 'recon' }, { t: 30, kind: 'friendly' },
      ...[0, 1, 2, 3].map((i) => ({ t: 50 + i * 1.6, kind: 'quad', origin: i % 2 ? 'behind' : 'sky', grp: 'A' })),
      { t: 78, kind: 'civil' }, { t: 90, kind: 'bird' },
    ],
  },
  {
    id: 'S8', name: 'Spoofed IFF', difficulty: 8, env: 'day', sensors: FULL, terrain: 'any', speedMul: 1.15, limit: 220,
    summary: 'One hostile drone answers IFF as friendly. Two real friendlies, a heavy and a swarm of scouts as well. Do not trust IFF alone.',
    timeline: [
      { t: 10, kind: 'friendly' }, { t: 22, kind: 'quad', origin: 'sky', spoof: true }, { t: 40, kind: 'friendly' },
      { t: 55, kind: 'heavy', origin: 'behind' },
      ...[0, 1, 2, 3, 4].map((i) => ({ t: 78 + i * 1.3, kind: 'scout', origin: i % 2 ? 'inside' : 'behind', grp: 'B' })),
    ],
  },
];

const pick = (r, items, weights) => {
  const sum = weights.reduce((a, b) => a + b, 0);
  let x = r() * sum;
  for (let i = 0; i < items.length; i++) if ((x -= weights[i]) < 0) return items[i];
  return items[items.length - 1];
};

// Same shape as a scripted scenario, built from a seed. difficulty 1..10. opts can pin parts of it
// (env, radar, swarm: true/false) and name a class to drill (focus). avoid: signatures of recent
// scenarios to not repeat.
export function generate({ seed, difficulty = 3, env, radar, swarm, focus, avoid = [] } = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const sc = build((seed + attempt * 7919) >>> 0, difficulty, env, radar, swarm, focus);
    if (!avoid.includes(sc.signature) || attempt === 5) return sc;
  }
}

function build(seed, d, env, radar, swarm, focus) {
  d = Math.max(1, Math.min(10, Math.round(d)));
  const r = rng(seed);
  const e = env || pick(r, ['day', 'dusk', 'night'], [Math.max(1, 6 - d / 2), 1 + d / 5, d >= 3 ? d / 3 : 0.2]);
  const rad = radar || pick(r, ['full', 'degraded', 'jammed'], [Math.max(1, 8 - d), d >= 3 ? d / 2 : 0, d >= 6 ? d / 3 : 0]);
  const iff = d >= 5 && r() < 0.4 ? 'degraded' : 'ok';
  const tl = [];
  let t = 8 + r() * 5;
  const gap = Math.max(4, 22 - 1.6 * d);
  const origins = ['inside', 'behind', 'sky'], ow = [0.3, 0.4, 0.3];
  const hostileKinds = d < 3 ? ['quad', 'scout'] : d < 6 ? ['quad', 'scout', 'heavy'] : ['quad', 'scout', 'heavy', 'heavy'];
  const nAttack = 2 + Math.floor(d * 0.9);
  const nDistract = Math.round(nAttack * (0.3 + 0.04 * d));
  const dKinds = ['friendly', 'civil', 'bird', 'recon'];
  const dw = dKinds.map((k) => (KINDS[k].cls === focus ? 3 : 1));
  const spoofs = d >= 8 ? 2 : d >= 6 && r() < 0.5 ? 1 : 0;
  const swarmOn = swarm != null ? swarm : d >= 4;
  const swarmSize = swarmOn ? Math.min(8, 3 + Math.floor(d / 2)) : 0;
  const singles = Math.max(1, nAttack - swarmSize);
  const events = [];
  for (let i = 0; i < singles; i++) events.push({ kind: pick(r, hostileKinds, hostileKinds.map(() => 1)), origin: pick(r, origins, ow), spoof: i < spoofs });
  for (let i = 0; i < nDistract; i++) events.push({ kind: pick(r, dKinds, dw) });
  // shuffle the singles and distractors, then lay them along the clock
  for (let i = events.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [events[i], events[j]] = [events[j], events[i]];
  }
  const swarmAt = swarmSize ? Math.floor(r() * (events.length + 1)) : -1;
  events.forEach((ev, i) => {
    if (i === swarmAt) {
      for (let k = 0; k < swarmSize; k++) tl.push({ t: round(t + k * 1.3), kind: 'scout', origin: k % 2 ? 'sky' : 'behind', grp: 'S' });
      t += swarmSize * 1.3 + gap * 0.6;
    }
    tl.push({ t: round(t), ...ev });
    t += gap * (0.6 + r() * 0.8);
  });
  if (swarmAt === events.length && swarmSize) for (let k = 0; k < swarmSize; k++) tl.push({ t: round(t + k * 1.3), kind: 'scout', origin: k % 2 ? 'sky' : 'behind', grp: 'S' });
  tl.sort((a, b) => a.t - b.t);
  const last = tl[tl.length - 1].t;
  const sc = {
    id: `P${seed.toString(36).toUpperCase()}`,
    name: `Procedural D${d}: ${e}, radar ${rad}${swarmSize ? ', swarm' : ''}`,
    procedural: true, seed, difficulty: d, env: e, sensors: { radar: rad, iff }, terrain: 'any',
    speedMul: round(0.85 + 0.06 * d, 2), limit: Math.round(last + 80), focus: focus || null,
    summary: `${tl.length} contacts (${tl.filter((c) => KINDS[c.kind].cls === 'ATTACK').length} hostile attack${swarmSize ? `, including a swarm of ${swarmSize}` : ''}).`,
    timeline: tl,
  };
  sc.signature = signature(sc);
  return sc;
}

const round = (v, n = 1) => Math.round(v * 10 ** n) / 10 ** n;

// what makes two scenarios feel the same: the conditions and the order of what comes from where
export function signature(sc) {
  const s = `${sc.env}|${sc.sensors.radar}|${sc.timeline.map((c) => `${c.kind[0]}${c.origin ? c.origin[0] : ''}${c.spoof ? '!' : ''}`).join('')}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function scriptedById(id) {
  return SCRIPTED.find((s) => s.id === id) || null;
}

// The next scenario to recommend, from a trainee's past sessions (newest last):
// [{ score, difficulty, died, skills: {detect, classify, decide}, confusion, signature }]
export function recommend(history) {
  const h = history || [];
  if (!h.length) return { difficulty: 1, reason: 'First session: start with the basics.', scripted: 'S1', focus: null, avoid: [] };
  const last = h[h.length - 1];
  const recent = h.slice(-3);
  const avg = recent.reduce((s, x) => s + x.score, 0) / recent.length;
  const allHigh = recent.length === 3 && recent.every((x) => x.score >= 85 && !x.died);
  let d = last.difficulty || 1, reason;
  if (last.died) {
    d = Math.max(1, d - 1);
    reason = 'The last position was overrun: stepping the difficulty down.';
  } else if (allHigh) {
    d = Math.min(10, d + 2);
    reason = 'Three strong sessions in a row: stepping the difficulty up by two.';
  } else if (avg >= 80) {
    d = Math.min(10, d + 1);
    reason = `Average ${Math.round(avg)} over the last ${recent.length}: stepping the difficulty up.`;
  } else if (avg < 50) {
    d = Math.max(1, d - 1);
    reason = `Average ${Math.round(avg)} over the last ${recent.length}: stepping the difficulty down.`;
  } else reason = `Average ${Math.round(avg)} over the last ${recent.length}: holding the difficulty.`;
  // what to drill: the class they most often get wrong, from the last ten sessions
  const miss = {}, seen = {};
  for (const x of h.slice(-10)) {
    for (const [t, row] of Object.entries(x.confusion || {})) {
      for (const [g, n] of Object.entries(row)) {
        seen[t] = (seen[t] || 0) + n;
        if (g !== t) miss[t] = (miss[t] || 0) + n;
      }
    }
  }
  let focus = null, worst = 0;
  for (const t of Object.keys(seen)) {
    const rate = (miss[t] || 0) / seen[t];
    if (seen[t] >= 4 && rate > worst && rate >= 0.25) {
      worst = rate;
      focus = t;
    }
  }
  if (focus) reason += ` Focus: ${focus.toLowerCase()} contacts are being misjudged most.`;
  const scripted = h.length < 4 ? SCRIPTED.find((s) => s.difficulty >= d)?.id || null : null;
  return { difficulty: d, reason, scripted, focus, avoid: h.slice(-4).map((x) => x.signature).filter(Boolean) };
}
