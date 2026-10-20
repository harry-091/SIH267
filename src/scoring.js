// Decision-tree scoring for a counter-drone training session. Pure functions, no DOM: the game
// builds a session record, the server re-scores it from the raw contact records (so a tampered
// client cannot hand itself a score), and the dashboard uses the same code for its coaching notes.
//
// Every contact walks the same tree:
//
//   DETECT   how long from the moment it could be seen (or tracked) until it was designated?
//     -> CLASSIFY   was it called what it really was?
//          -> DECIDE   engage or hold fire, by the rules of engagement for what it really was,
//                      and was that decision made *after* classifying it (not before)?
//               -> OUTCOME   neutralised / leaked through / left untouched / wrongly engaged
//
// Points per contact: detection 30 + classification 30 + engagement decision 40 = 100, minus a
// penalty for engaging something that was not hostile.

export const CLASSES = ['ATTACK', 'RECON', 'FRIENDLY', 'CIVILIAN', 'BIRD'];
export const CLASS_NAMES = { ATTACK: 'Hostile attack', RECON: 'Hostile recon', FRIENDLY: 'Friendly', CIVILIAN: 'Civilian', BIRD: 'Bird / clutter' };
// the rules of engagement: what to do about each kind of contact
export const ROE = { ATTACK: 'engage', RECON: 'engage', FRIENDLY: 'hold', CIVILIAN: 'hold', BIRD: 'hold' };
export const PENALTY = { FRIENDLY: 60, CIVILIAN: 50, BIRD: 10 }; // for engaging it
export const VIOLATION = { FRIENDLY: 'Fratricide', CIVILIAN: 'Collateral', BIRD: 'Wasted engagement' };
const WEIGHT = { ATTACK: 2, RECON: 1, FRIENDLY: 1, CIVILIAN: 1, BIRD: 1 };
const DETECT_FULL = 3; // seconds: designated this fast scores everything
const DETECT_ZERO = 15; // seconds: this slow scores nothing
export const PASS_MARK = 70;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const round = (v, n = 1) => (v == null ? null : Math.round(v * 10 ** n) / 10 ** n);

// One contact: the record the game keeps (see training.js) in, the walk through the tree out.
export function scoreContact(c) {
  const hostile = ROE[c.truth] === 'engage';
  const flags = [];

  // DETECT
  let detect = 0, detectTime = null;
  if (c.tDes != null) {
    detectTime = Math.max(0, c.tDes - (c.tObs ?? c.tDes));
    detect = 30 * clamp(1 - (detectTime - DETECT_FULL) / (DETECT_ZERO - DETECT_FULL), 0, 1);
  } else flags.push('never designated');

  // CLASSIFY
  const classify = c.guess === c.truth ? 30 : 0;
  if (c.guess && c.guess !== c.truth) flags.push(`called ${CLASS_NAMES[c.guess]}`);
  if (!c.guess && c.tDes != null) flags.push('designated, never classified');

  // DECIDE
  let decide = 0, penalty = 0, violation = null;
  const guessedHostile = c.guessAtEngage === 'ATTACK' || c.guessAtEngage === 'RECON';
  if (hostile) {
    if (c.outcome === 'neutralized') {
      decide = 40;
      if (!guessedHostile) {
        decide = 20; // right call, wrong procedure: engaged before it was classified hostile
        flags.push(c.guessAtEngage ? 'engaged against own classification' : 'engaged before classifying');
      }
    } else if (c.truth === 'RECON' && c.outcome === 'expired') {
      decide = 20; // it got away with what it saw, but nothing was lost
      flags.push('recon left untouched');
    } else if (c.outcome === 'leaked') flags.push('reached position');
  } else if (c.engaged) {
    penalty = PENALTY[c.truth];
    violation = VIOLATION[c.truth];
    flags.push(violation.toLowerCase());
  } else decide = 40;

  const total = clamp(detect + classify + decide - penalty, 0, 100);
  return { id: c.id, truth: c.truth, detect: round(detect), classify, decide, penalty, total: round(total), detectTime: round(detectTime), violation, flags };
}

// Kendall-style check on a swarm: of the hostile contacts that were alive together, how often
// was the one that would have arrived first engaged first? (0..100, or null with too few.)
export function triage(contacts) {
  const h = contacts.filter((c) => ROE[c.truth] === 'engage' && c.engageT != null && c.eta != null);
  let good = 0, all = 0;
  for (let i = 0; i < h.length; i++) {
    for (let j = i + 1; j < h.length; j++) {
      const a = h[i], b = h[j];
      if (a.tSpawn > b.engageT || b.tSpawn > a.engageT) continue; // not alive together
      if (a.eta === b.eta) continue;
      all++;
      if (a.eta < b.eta === a.engageT < b.engageT) good++;
    }
  }
  return all >= 1 ? round((good / all) * 100, 0) : null;
}

// A whole session. s: { contacts: [...], falseAlarms, died, shots, hits, duration, env, sensors,
// difficulty, ... }. Returns the numbers the dashboard charts.
export function scoreSession(s) {
  const contacts = s.contacts || [];
  const per = contacts.map(scoreContact);
  let wsum = 0, tsum = 0;
  per.forEach((p) => {
    const w = WEIGHT[p.truth] || 1;
    wsum += w;
    tsum += w * p.total;
  });
  const falseAlarms = s.falseAlarms || 0;
  let score = wsum ? tsum / wsum - Math.min(15, 5 * falseAlarms) : 0;
  const died = !!s.died;
  if (died) score = Math.min(score, 59); // the position was overrun: cannot pass
  score = Math.round(clamp(score, 0, 100));

  const designated = per.filter((p) => p.detectTime != null);
  const hostile = contacts.filter((c) => ROE[c.truth] === 'engage');
  const correctDecision = contacts.filter((c) => (ROE[c.truth] === 'engage' ? c.outcome === 'neutralized' : !c.engaged));
  const confusion = {};
  for (const t of CLASSES) {
    confusion[t] = {};
    for (const g of [...CLASSES, 'NONE']) confusion[t][g] = 0;
  }
  for (const c of contacts) confusion[c.truth][c.guess || 'NONE']++;
  const byOrigin = {};
  contacts.forEach((c, i) => {
    const o = (byOrigin[c.origin] = byOrigin[c.origin] || { n: 0, det: [] });
    o.n++;
    if (per[i].detectTime != null) o.det.push(per[i].detectTime);
  });
  for (const o of Object.values(byOrigin)) {
    o.meanDetect = round(mean(o.det));
    delete o.det;
  }
  const shots = s.shots || 0, hits = s.hits || 0;
  return {
    score,
    grade: grade(score, died),
    passed: score >= PASS_MARK && !died,
    died,
    contacts: contacts.length,
    attackContacts: hostile.length,
    meanDetect: round(mean(designated.map((p) => p.detectTime))),
    skills: {
      detect: round(mean(per.map((p) => (p.detect / 30) * 100)), 0) ?? 0,
      classify: round(mean(per.map((p) => (p.classify / 30) * 100)), 0) ?? 0,
      decide: round(mean(per.map((p) => (p.decide / 40) * 100)), 0) ?? 0,
    },
    classAccuracy: contacts.length ? round((contacts.filter((c) => c.guess === c.truth).length / contacts.length) * 100, 0) : 0,
    engageAccuracy: contacts.length ? round((correctDecision.length / contacts.length) * 100, 0) : 0,
    leaks: contacts.filter((c) => ROE[c.truth] === 'engage' && c.outcome === 'leaked' && c.truth === 'ATTACK').length,
    fratricide: contacts.filter((c) => c.truth === 'FRIENDLY' && c.engaged).length,
    collateral: contacts.filter((c) => c.truth === 'CIVILIAN' && c.engaged).length,
    wasted: contacts.filter((c) => c.truth === 'BIRD' && c.engaged).length,
    falseAlarms,
    shots,
    hits,
    accuracy: shots ? round((hits / shots) * 100, 0) : null,
    triage: triage(contacts),
    confusion,
    byOrigin,
    perContact: per,
  };
}

export function grade(score, died = false) {
  if (died) return 'F';
  return score >= 90 ? 'A' : score >= 80 ? 'B' : score >= PASS_MARK ? 'C' : score >= 50 ? 'D' : 'F';
}

// After-action coaching: plain sentences about what to work on, from the session's own numbers.
export function coach(m, s = {}) {
  const out = [];
  const contacts = s.contacts || [];
  if (m.died) out.push('The position was overrun. Prioritise the hostile contact with the shortest time to impact, and engage it as soon as it is classified.');
  if (m.leaks) {
    const never = contacts.filter((c) => c.truth === 'ATTACK' && c.outcome === 'leaked' && c.tDes == null).length;
    out.push(`${m.leaks} attack drone${m.leaks > 1 ? 's' : ''} reached your position${never ? `; ${never} of them never designated. Designate (T) as soon as a contact appears so there is time to classify and engage` : ''}.`);
  }
  if (m.fratricide) out.push(`${m.fratricide} friendly drone${m.fratricide > 1 ? 's were' : ' was'} engaged. Check IFF and flight behaviour before firing: a friendly flies a steady pattern and does not close on you.`);
  if (m.collateral) out.push(`${m.collateral} civilian drone${m.collateral > 1 ? 's were' : ' was'} engaged. Slow, drifting, passing contacts with no IFF are usually civilian: track and report, do not engage.`);
  if (m.wasted) out.push('Arrows were spent on birds. Erratic, small, fast-changing tracks with no lights are clutter.');
  if (m.meanDetect != null && m.meanDetect > 8) out.push(`Average time to designate was ${m.meanDetect}s. Scan in sectors, and watch the radar for contacts outside your field of view.`);
  const slow = Object.entries(m.byOrigin || {}).filter(([, o]) => o.meanDetect != null && o.meanDetect > 9 && o.n >= 2).sort((a, b) => b[1].meanDetect - a[1].meanDetect)[0];
  if (slow) out.push(`Contacts launched ${slow[0] === 'inside' ? 'from inside buildings' : slow[0] === 'behind' ? 'from behind buildings' : 'from open sky'} took longest to spot (${slow[1].meanDetect}s). ${slow[0] === 'inside' ? 'Listen for the rotor whine and watch windows.' : slow[0] === 'behind' ? 'Watch rooflines: they appear over them.' : 'Sweep the horizon.'}`);
  let worst = null;
  for (const t of CLASSES) {
    for (const g of CLASSES) if (t !== g && m.confusion[t][g] >= 1 && (!worst || m.confusion[t][g] > worst.n)) worst = { t, g, n: m.confusion[t][g] };
  }
  if (worst) out.push(`${CLASS_NAMES[worst.t]} was called ${CLASS_NAMES[worst.g]} ${worst.n > 1 ? worst.n + ' times' : 'once'}. Compare speed, altitude, heading and lights for those two.`);
  const spoofed = contacts.filter((c) => c.spoof && c.guess === 'FRIENDLY').length;
  if (spoofed) out.push('A hostile drone with a spoofed friendly IFF was classified Friendly. IFF alone is not proof: a "friendly" that dives at your position is not friendly.');
  const early = contacts.filter((c) => ROE[c.truth] === 'engage' && c.outcome === 'neutralized' && c.guessAtEngage !== 'ATTACK' && c.guessAtEngage !== 'RECON').length;
  if (early >= 1) out.push(`${early} engagement${early > 1 ? 's were' : ' was'} made before the contact was classified hostile. Classify first, then engage: that is the drill.`);
  if (m.falseAlarms) out.push(`${m.falseAlarms} false alarm${m.falseAlarms > 1 ? 's' : ''}: designated a radar ghost. With degraded radar, confirm by eye or wait for the track to persist.`);
  if (m.accuracy != null && m.shots >= 6 && m.accuracy < 25) out.push(`Only ${m.accuracy}% of arrows hit. Lead moving targets and hold the draw for a full pull.`);
  if (!out.length) out.push(m.score >= 85 ? 'Clean session: fast detection, correct calls and disciplined engagements.' : 'No major faults recorded. Raise the difficulty to keep improving.');
  return out;
}
