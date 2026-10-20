// The training dashboard: sign in / create an account, launch scenarios, and follow performance
// over repeated sessions: a trainee's own record, and (for instructors) their whole unit.
import { api, pending, flushQueue } from '../api.js';
import { CLASSES, CLASS_NAMES, PASS_MARK } from '../scoring.js';
import { generate } from '../scenario.js';
import { h, clear, mean, r1, fmtDate } from './dom.js';
import { lineChart, sparkline, timeline } from './charts.js';

const app = document.getElementById('app');
const state = { user: null };
const SKILL = { detect: 'Detection', classify: 'Classification', decide: 'Engagement decisions' };
const COLORS = { score: '#4dff88', detect: '#ffd23f', classify: '#6ab7ff', decide: '#ff9a3d', diff: '#6b7f73' };
const short = { ATTACK: 'Attack', RECON: 'Recon', FRIENDLY: 'Friendly', CIVILIAN: 'Civilian', BIRD: 'Bird', NONE: 'No call' };

// ---------------------------------------------------------------- small pieces

const kpi = (label, value, sub, tone) => h('div', { class: `kpi ${tone || ''}` }, h('b', null, value ?? '–'), h('span', null, label), sub ? h('small', null, sub) : null);
const section = (title, ...body) => h('section', { class: 'card' }, h('h3', null, title), ...body);
const gradeChip = (g) => h('span', { class: `grade g${g}` }, g);
const bar = (label, v, extra) => h('div', { class: 'hbar' }, h('span', null, label), h('i', null, h('u', { style: { width: `${Math.max(0, Math.min(100, v ?? 0))}%` } })), h('b', null, v == null ? '–' : v), extra ? h('small', null, extra) : null);

function showError(el, res) {
  el.textContent = res.status === 0 ? 'Cannot reach the training server. Is it running?' : res.data?.error || 'Something went wrong.';
}

function merge(sessions) {
  const out = {};
  for (const t of CLASSES) {
    out[t] = {};
    for (const g of [...CLASSES, 'NONE']) out[t][g] = 0;
  }
  for (const s of sessions) for (const t of CLASSES) for (const g of Object.keys(out[t])) out[t][g] += s.confusion?.[t]?.[g] || 0;
  return out;
}

function conditions(sessions) {
  const group = (key) => {
    const o = {};
    for (const s of sessions) (o[key(s)] = o[key(s)] || []).push(s.score);
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { n: v.length, avg: r1(mean(v)) }]));
  };
  const orig = {};
  for (const s of sessions) for (const [k, v] of Object.entries(s.byOrigin || {})) if (v.meanDetect != null) (orig[k] = orig[k] || []).push(v.meanDetect);
  return { env: group((s) => s.env), radar: group((s) => s.radar), terrain: group((s) => s.terrain), detectByOrigin: Object.fromEntries(Object.entries(orig).map(([k, v]) => [k, { n: v.length, avg: r1(mean(v)) }])) };
}

function aggregate(s) {
  if (!s.length) return null;
  const last5 = s.slice(-5);
  return {
    n: s.length, avg5: r1(mean(last5.map((x) => x.score))), best: Math.max(...s.map((x) => x.score)), pass: Math.round((s.filter((x) => x.passed).length / s.length) * 100),
    meanDetect: r1(mean(s.filter((x) => x.meanDetect != null).map((x) => x.meanDetect))), classAcc: r1(mean(s.map((x) => x.classAccuracy))), engageAcc: r1(mean(s.map((x) => x.engageAccuracy))),
    leaks: s.reduce((a, x) => a + x.leaks, 0), violations: s.reduce((a, x) => a + x.fratricide + x.collateral, 0), falseAlarms: s.reduce((a, x) => a + x.falseAlarms, 0),
    conf: merge(s), cond: conditions(s),
  };
}

function confusionTable(conf) {
  const cols = [...CLASSES, 'NONE'];
  return h('table', { class: 'conf' },
    h('thead', null, h('tr', null, h('th', null, 'Truth ↓ / your call →'), cols.map((c) => h('th', null, short[c])))),
    h('tbody', null, CLASSES.map((t) => {
      const total = cols.reduce((s, g) => s + conf[t][g], 0);
      return h('tr', null, h('th', null, `${CLASS_NAMES[t]}${total ? ` (${total})` : ''}`), cols.map((g) => {
        const n = conf[t][g], f = total ? n / total : 0;
        const bg = !n ? 'transparent' : g === t ? `rgba(77,255,136,${0.15 + 0.6 * f})` : `rgba(255,107,107,${0.15 + 0.7 * f})`;
        return h('td', { style: { background: bg } }, n || '');
      }));
    })));
}

function condBars(cond) {
  const rows = [];
  const add = (title, map, unit = '') => {
    const keys = Object.keys(map);
    if (!keys.length) return;
    rows.push(h('h4', null, title));
    for (const k of keys) rows.push(bar(k, unit ? Math.min(100, Math.round(map[k].avg * 5)) : map[k].avg, unit ? `${map[k].avg}${unit} · n=${map[k].n}` : `n=${map[k].n}`));
  };
  add('Score by light', cond.env);
  add('Score by radar state', cond.radar);
  add('Score by terrain', cond.terrain);
  add('Time to designate, by where it launched from', cond.detectByOrigin, ' s');
  return h('div', null, rows.length ? rows : h('p', { class: 'muted' }, 'Not enough sessions yet.'));
}

function sessionTable(sessions, { onOpen, names } = {}) {
  if (!sessions.length) return h('p', { class: 'muted' }, 'No sessions yet.');
  return h('div', { class: 'scroll' }, h('table', { class: 'tbl' },
    h('thead', null, h('tr', null, [names ? 'Trainee' : null, 'Date', 'Scenario', 'D', 'Conditions', 'Score', '', 'Detect s', 'Class %', 'Engage %', 'Leaks', 'ROE', ''].map((t) => (t === null ? null : h('th', null, t))))),
    h('tbody', null, sessions.slice().reverse().map((s) => h('tr', { class: 'click', onclick: () => onOpen(s) },
      names ? h('td', null, names[s.userId] || '') : null,
      h('td', null, fmtDate(s.at)), h('td', null, s.scenarioName), h('td', null, s.difficulty),
      h('td', null, `${s.env} · radar ${s.radar}${s.iff === 'degraded' ? ' · IFF deg.' : ''} · ${s.terrain}`),
      h('td', null, h('b', null, s.score)), h('td', null, gradeChip(s.grade)), h('td', null, s.meanDetect ?? '–'), h('td', null, s.classAccuracy), h('td', null, s.engageAccuracy),
      h('td', { class: s.leaks ? 'neg' : '' }, s.leaks), h('td', { class: s.fratricide + s.collateral ? 'neg' : '' }, s.fratricide + s.collateral), h('td', null, h('span', { class: 'link' }, 'AAR →')))))));
}

// ---------------------------------------------------------------- the after-action review

async function openAar(id) {
  const modal = h('div', { class: 'modal' }, h('div', { class: 'modal-box' }, h('p', { class: 'muted' }, 'Loading…')));
  const close = () => {
    document.removeEventListener('keydown', onKey);
    modal.remove();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  modal.addEventListener('click', (e) => e.target === modal && close());
  document.body.appendChild(modal);
  const r = await api(`/api/sessions/${id}`);
  const box = clear(modal.firstChild);
  if (!r.ok) {
    box.appendChild(h('p', { class: 'error' }, r.data?.error || 'Could not load.'));
    box.appendChild(h('button', { class: 'btn', onclick: close }, 'Close'));
    return;
  }
  const { summary: s, metrics: m, session, coach, owner } = r.data;
  box.appendChild(h('div', { class: 'aar-head' },
    h('div', null, h('h2', null, 'After-action review'), h('p', { class: 'muted' }, `${owner?.name || ''} · ${s.scenarioName} · ${fmtDate(s.at)} · ${session.reason === 'died' ? 'position overrun' : session.reason === 'timeout' ? 'time limit' : 'complete'}`),
      h('p', { class: 'muted' }, `Difficulty ${s.difficulty} · ${s.env} · radar ${s.radar} · IFF ${s.iff} · terrain ${s.terrain} · ${session.duration}s${session.procedural ? ` · seed ${session.seed}` : ''}`)),
    h('div', { class: `bigscore g${s.grade}` }, h('b', null, s.score), h('span', null, `${s.grade}${s.passed ? ' · PASS' : s.died ? ' · OVERRUN' : ` · below ${PASS_MARK}`}`))));
  box.appendChild(h('div', { class: 'cols' },
    h('div', null, ...Object.entries(SKILL).map(([k, label]) => bar(label, s.skills[k]))),
    h('div', { class: 'kpis small' }, kpi('Contacts', s.contacts), kpi('Mean time to designate', s.meanDetect == null ? '–' : `${s.meanDetect}s`), kpi('Leaked', s.leaks, null, s.leaks ? 'neg' : ''), kpi('Fratricide / collateral', `${s.fratricide} / ${s.collateral}`, null, s.fratricide + s.collateral ? 'neg' : ''), kpi('False alarms', s.falseAlarms), kpi('Arrow accuracy', s.accuracy == null ? '–' : `${s.accuracy}%`), s.triage != null ? kpi('Swarm triage', `${s.triage}%`) : null)));
  box.appendChild(h('h3', null, 'Coaching'));
  box.appendChild(h('ul', { class: 'coach' }, coach.map((t) => h('li', null, t))));
  box.appendChild(h('h3', null, 'Timeline'));
  box.appendChild(timeline(session.contacts, session.duration));
  box.appendChild(h('h3', null, 'Decision path per contact'));
  box.appendChild(h('div', { class: 'scroll' }, h('table', { class: 'tbl' },
    h('thead', null, h('tr', null, ['ID', 'Was', 'Launched', 'Detect', 'Your call', 'Engagement', 'Outcome', 'Points', 'Notes'].map((t) => h('th', null, t)))),
    h('tbody', null, session.contacts.map((c, i) => {
      const p = m.perContact[i];
      return h('tr', null, h('td', null, c.id), h('td', null, CLASS_NAMES[c.truth], c.spoof ? ' (IFF spoofed)' : ''), h('td', null, c.truth === 'ATTACK' ? c.origin : '–'),
        h('td', null, p.detectTime == null ? 'never' : `${p.detectTime}s → ${p.detect}`),
        h('td', { class: c.guess === c.truth ? 'pos' : 'neg' }, c.guess ? `${CLASS_NAMES[c.guess]} → ${p.classify}` : 'none → 0'),
        h('td', null, c.engaged ? `engaged (${c.guessAtEngage ? 'called ' + short[c.guessAtEngage] : 'uncalled'}) → ${p.decide}` : `held fire → ${p.decide}`),
        h('td', { class: c.outcome === 'leaked' ? 'neg' : '' }, c.outcome === 'neutralized' ? 'neutralised' : c.outcome === 'leaked' ? 'reached position' : 'left area'),
        h('td', null, h('b', null, p.total), p.penalty ? ` (−${p.penalty})` : ''), h('td', { class: 'small' }, p.violation ? h('b', { class: 'neg' }, p.violation + '. ') : '', p.flags.join('; ')));
    })))));
  box.appendChild(h('details', null, h('summary', null, `Event log (${session.events.length})`),
    h('div', { class: 'scroll' }, h('table', { class: 'tbl small' }, h('tbody', null, session.events.map((e) => h('tr', null, h('td', null, `${e.t}s`), h('td', null, e.type), h('td', null, e.id || ''), h('td', null, [e.truth, e.origin, e.guess, e.by].filter(Boolean).join(' · ')))))))));
  box.appendChild(h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => window.print() }, 'Print / save as PDF'), h('button', { class: 'btn ghost', onclick: close }, 'Close')));
}

// ---------------------------------------------------------------- performance (one person)

function performance(sessions, { names } = {}) {
  const a = aggregate(sessions);
  if (!a) return h('section', { class: 'card' }, h('p', { class: 'muted' }, 'No sessions yet. Launch one from the Train tab.'));
  const labels = sessions.map((s) => String(sessions.indexOf(s) + 1));
  const nodes = [
    h('div', { class: 'kpis' },
      kpi('Sessions', a.n), kpi('Average, last 5', a.avg5, `pass mark ${PASS_MARK}`, a.avg5 >= PASS_MARK ? 'pos' : 'neg'), kpi('Best', a.best), kpi('Pass rate', `${a.pass}%`),
      kpi('Mean time to designate', a.meanDetect == null ? '–' : `${a.meanDetect}s`), kpi('Classification', `${a.classAcc}%`), kpi('Engagement decisions', `${a.engageAcc}%`),
      kpi('Leaks', a.leaks, null, a.leaks ? 'neg' : ''), kpi('ROE violations', a.violations, 'friendly / civilian engaged', a.violations ? 'neg' : ''), kpi('False alarms', a.falseAlarms)),
    section('Score over sessions', lineChart([{ label: 'Score', color: COLORS.score, values: sessions.map((s) => s.score) }, { label: 'Difficulty (×10)', color: COLORS.diff, dashed: true, values: sessions.map((s) => s.difficulty * 10) }], { refLine: PASS_MARK, labels })),
    section('Skills over sessions', lineChart(Object.entries(SKILL).map(([k, label]) => ({ label, color: COLORS[k], values: sessions.map((s) => s.skills[k]) })), { labels })),
    h('div', { class: 'cols' },
      section('Confusion matrix: what each contact really was vs what you called it', confusionTable(a.conf)),
      section('Performance by conditions', condBars(a.cond))),
  ];
  return h('div', null, nodes);
}

// ---------------------------------------------------------------- Train: launch a scenario

function launchUrl(rec) {
  if (rec.scripted) return `/?train=${rec.scripted}`;
  const p = new URLSearchParams({ train: 'P', seed: String((Math.random() * 2 ** 32) >>> 0), d: String(rec.difficulty) });
  for (const k of ['env', 'radar', 'focus']) if (rec[k]) p.set(k, rec[k]);
  if (rec.swarm != null) p.set('swarm', rec.swarm ? '1' : '0');
  if (rec.avoid && rec.avoid.length) p.set('avoid', rec.avoid.join(','));
  return `/?${p}`;
}

async function trainTab(el) {
  const [next, scen] = await Promise.all([api('/api/next'), api('/api/scenarios')]);
  const out = [];
  const queued = pending().length;
  if (queued) {
    const note = h('p', { class: 'muted' });
    out.push(section('Saved on this device', h('p', null, `${queued} training result${queued > 1 ? 's' : ''} from this computer ${queued > 1 ? 'are' : 'is'} waiting to be uploaded.`), h('button', { class: 'btn', onclick: async () => { note.textContent = 'Uploading…'; const n = await flushQueue(); note.textContent = `${n} uploaded.`; setTimeout(() => show('train'), 800); } }, 'Upload now'), note));
  }
  if (next.ok) {
    const r = next.data;
    out.push(section('Recommended next', h('p', null, h('b', null, r.scripted ? `Scripted ${r.scripted}` : `Procedural, difficulty ${r.difficulty}`), r.focus ? ` · drilling ${CLASS_NAMES[r.focus].toLowerCase()} contacts` : ''), h('p', { class: 'muted' }, r.reason), h('p', { class: 'muted small' }, 'Every launch is a new randomisation: contacts, directions and timings differ each time, so it cannot be learned by rote.'),
      h('a', { class: 'btn', href: launchUrl(r) }, 'Launch recommended scenario →')));
  }
  if (scen.ok) {
    out.push(section('Scripted scenarios', h('div', { class: 'grid' }, scen.data.scenarios.map((s) => h('div', { class: 'scn' },
      h('h4', null, `${s.id} · ${s.name}`), h('p', { class: 'pips' }, '●'.repeat(s.difficulty) + '○'.repeat(10 - s.difficulty)),
      h('p', { class: 'small muted' }, `${s.env} · radar ${s.sensors.radar} · IFF ${s.sensors.iff} · ${s.terrain === 'urban' ? 'best in a built-up place' : 'any terrain'} · ${s.contacts} contacts`),
      h('p', null, s.summary), h('a', { class: 'btn ghost', href: launchUrl({ scripted: s.id }) }, 'Launch'))))));
  }
  out.push(customBuilder());
  clear(el).append(...out);
}

function customBuilder() {
  const sel = (opts) => h('select', null, opts.map(([v, t]) => h('option', { value: v }, t)));
  const diff = h('input', { type: 'range', min: 1, max: 10, value: 4 });
  const diffOut = h('b', null, '4');
  const env = sel([['', 'Random'], ['day', 'Day'], ['dusk', 'Dusk'], ['night', 'Night']]);
  const radar = sel([['', 'Random'], ['full', 'Full'], ['degraded', 'Degraded'], ['jammed', 'Jammed']]);
  const swarm = sel([['', 'By difficulty'], ['1', 'Include a swarm'], ['0', 'No swarm']]);
  const focus = sel([['', 'None'], ...CLASSES.map((c) => [c, CLASS_NAMES[c]])]);
  const preview = h('p', { class: 'muted small' });
  const go = h('a', { class: 'btn', href: '#' }, 'Generate & launch →');
  const read = () => ({ difficulty: +diff.value, env: env.value || undefined, radar: radar.value || undefined, swarm: swarm.value === '' ? undefined : swarm.value === '1', focus: focus.value || undefined });
  const update = () => {
    diffOut.textContent = diff.value;
    const o = read();
    const sc = generate({ seed: 1, ...o });
    const hostile = sc.timeline.filter((c) => ['quad', 'scout', 'heavy'].includes(c.kind)).length;
    preview.textContent = `Example at these settings: ${sc.timeline.length} contacts (${hostile} hostile attack drones, ${sc.timeline.length - hostile} others), hostile speed ×${sc.speedMul}. The real run is generated from a fresh random seed.`;
    go.setAttribute('href', launchUrl(o));
  };
  for (const e of [diff, env, radar, swarm, focus]) e.addEventListener('input', update);
  go.addEventListener('click', update); // a fresh seed every launch
  update();
  return section('Build a procedural scenario', h('div', { class: 'form-grid' },
    h('label', null, 'Difficulty ', diffOut, diff), h('label', null, 'Light', env), h('label', null, 'Radar', radar), h('label', null, 'Swarm', swarm), h('label', null, 'Drill a class', focus)), preview, go);
}

// ---------------------------------------------------------------- Unit (instructor)

function flagsOf(r) {
  const f = [];
  if (!r.sessions) return ['no sessions yet'];
  if (r.avgLast5 < 60) f.push('below standard');
  if (r.trend != null && r.trend <= -8) f.push('declining');
  if (r.violations > 0) f.push('ROE violations');
  if (r.leaks >= 3) f.push('many leaks');
  if (Date.now() - Date.parse(r.lastAt) > 14 * 86400000) f.push('inactive 14d+');
  return f;
}

async function unitTab(el) {
  const r = await api('/api/unit');
  if (!r.ok) return clear(el).appendChild(h('p', { class: 'error' }, r.data?.error || 'Could not load the unit.'));
  const u = r.data;
  const codeOut = h('b', { class: 'code' }, u.unit.joinCode);
  const rotate = h('button', { class: 'btn ghost', onclick: async () => { const x = await api('/api/unit/rotate-code', { method: 'POST', body: {} }); if (x.ok) codeOut.textContent = x.data.joinCode; } }, 'New code');
  const copy = h('button', { class: 'btn ghost', onclick: () => navigator.clipboard?.writeText(codeOut.textContent) }, 'Copy');
  const t = u.totals;
  const attention = u.roster.map((x) => [x, flagsOf(x)]).filter(([, f]) => f.length);
  const roster = h('div', { class: 'scroll' }, h('table', { class: 'tbl' },
    h('thead', null, h('tr', null, ['Trainee', 'Sessions', 'Last', 'Avg (last 5)', 'Trend', 'Last 12', 'Detect', 'Class', 'Decide', 'Weakest', 'Leaks', 'ROE', 'Pass', 'Flags'].map((x) => h('th', null, x)))),
    h('tbody', null, u.roster.length ? u.roster.map((x) => h('tr', { class: 'click', onclick: () => trainee(el, x) },
      h('td', null, h('b', null, x.name), h('br'), h('small', { class: 'muted' }, x.username)), h('td', null, x.sessions), h('td', null, x.lastAt ? fmtDate(x.lastAt).slice(0, 10) : '–'),
      h('td', null, h('b', null, x.avgLast5 ?? '–')), h('td', { class: x.trend > 0 ? 'pos' : x.trend < 0 ? 'neg' : '' }, x.trend == null ? '–' : (x.trend > 0 ? '▲ ' : x.trend < 0 ? '▼ ' : '') + Math.abs(x.trend)),
      h('td', null, sparkline(x.spark)), ...['detect', 'classify', 'decide'].map((k) => h('td', null, x.skills ? x.skills[k] : '–')),
      h('td', null, x.weakest ? SKILL[x.weakest] : '–'), h('td', { class: x.leaks ? 'neg' : '' }, x.sessions ? x.leaks : '–'), h('td', { class: x.violations ? 'neg' : '' }, x.sessions ? x.violations : '–'),
      h('td', null, x.passRate == null ? '–' : `${x.passRate}%`), h('td', null, flagsOf(x).map((f) => h('span', { class: 'chip' }, f))))) : h('tr', null, h('td', { colspan: 14, class: 'muted' }, 'No trainees yet. Give them the unit join code when they create their accounts.')))));
  clear(el).append(
    h('section', { class: 'card' }, h('div', { class: 'row spread' },
      h('div', null, h('h3', null, u.unit.name), h('p', { class: 'muted' }, 'Trainees join with this code when they create an account: ', codeOut, ' ', copy, rotate)),
      h('a', { class: 'btn ghost', href: '/api/unit/export.csv', download: true }, 'Export CSV'))),
    h('div', { class: 'kpis' }, kpi('Trainees', t.trainees), kpi('Sessions', t.sessions), kpi('Average score', t.avgScore ?? '–'), kpi('Pass rate', t.passRate == null ? '–' : `${t.passRate}%`), kpi('Mean time to designate', t.meanDetect == null ? '–' : `${t.meanDetect}s`), kpi('Leaks', t.leaks, null, t.leaks ? 'neg' : ''), kpi('ROE violations', t.violations, null, t.violations ? 'neg' : '')),
    attention.length ? section('Needs attention', h('div', null, attention.map(([x, f]) => h('p', null, h('a', { class: 'link', href: '#', onclick: (e) => { e.preventDefault(); trainee(el, x); } }, x.name), ' · ', f.map((y) => h('span', { class: 'chip' }, y)))))) : null,
    section('Roster', roster),
    t.sessions ? section('Unit trend by day', lineChart([{ label: 'Score', color: COLORS.score, values: u.series.map((d) => d.score) }, ...Object.entries(SKILL).map(([k, label]) => ({ label, color: COLORS[k], values: u.series.map((d) => d[k]) }))], { labels: u.series.map((d) => d.day.slice(5)), refLine: PASS_MARK })) : null,
    t.sessions ? h('div', { class: 'cols' }, section('Unit confusion matrix', confusionTable(u.confusion)), section('Unit performance by conditions', condBars(u.conditions))) : null);
}

async function trainee(el, row) {
  const r = await api(`/api/unit/users/${row.id}/sessions`);
  const back = h('a', { class: 'link', href: '#', onclick: (e) => { e.preventDefault(); unitTab(el); } }, '← Unit');
  if (!r.ok) return clear(el).append(back, h('p', { class: 'error' }, r.data?.error || 'Could not load.'));
  clear(el).append(back, h('h2', null, `${r.data.user.name} `, h('small', { class: 'muted' }, r.data.user.username)), performance(r.data.sessions),
    section('Sessions', sessionTable(r.data.sessions, { onOpen: (s) => openAar(s.id) })));
}

// ---------------------------------------------------------------- the signed-in page

async function show(tab) {
  const body = document.getElementById('tab-body');
  if (!body) return;
  state.tab = tab;
  for (const b of document.querySelectorAll ? document.querySelectorAll('nav button') : []) b.classList.toggle('on', b.dataset.tab === tab);
  clear(body).appendChild(h('p', { class: 'muted' }, 'Loading…'));
  if (tab === 'train') return trainTab(body);
  if (tab === 'unit') return unitTab(body);
  const r = await api('/api/sessions');
  if (!r.ok) return clear(body).appendChild(h('p', { class: 'error' }, r.data?.error || 'Could not load.'));
  if (tab === 'performance') clear(body).append(performance(r.data.sessions));
  else clear(body).append(section('My sessions', sessionTable(r.data.sessions, { onOpen: (s) => openAar(s.id) })));
}

function shell() {
  const u = state.user;
  const tabs = u.role === 'instructor' ? [['unit', 'Unit'], ['train', 'Train'], ['performance', 'My performance'], ['sessions', 'My sessions']] : [['train', 'Train'], ['performance', 'Performance'], ['sessions', 'Sessions']];
  const nav = h('nav', null, tabs.map(([k, label]) => h('button', { 'data-tab': k, class: state.tab === k ? 'on' : '', onclick: () => show(k) }, label)));
  clear(app).append(
    h('header', null, h('div', { class: 'brand' }, h('b', null, 'COUNTER-UAS TRAINER'), h('span', null, 'Detect · Classify · Engage')),
      h('div', { class: 'who' }, h('span', null, `${u.name} · ${u.role}${u.unit ? ' · ' + u.unit.name : ''}`),
        h('a', { class: 'btn ghost', href: '/' }, 'Open simulator'), h('button', { class: 'btn ghost', onclick: async () => { await api('/api/logout', { method: 'POST', body: {} }); state.user = null; authView(); } }, 'Sign out'))),
    nav, h('main', { id: 'tab-body' }));
  if (!u.unit && u.role === 'trainee') {
    const err = h('span', { class: 'error' });
    const code = h('input', { placeholder: 'Unit join code', maxlength: 12 });
    document.getElementById('tab-body').before(h('div', { class: 'banner' }, 'You are not in a unit, so instructors cannot see your results. ', code,
      h('button', { class: 'btn ghost', onclick: async () => { const r = await api('/api/me/unit', { method: 'POST', body: { joinCode: code.value } }); if (r.ok) { state.user = r.data.user; shell(); show(state.tab); } else showError(err, r); } }, 'Join'), err));
  }
  show(state.tab || tabs[0][0]);
}

// ---------------------------------------------------------------- sign in / create account

function authView(mode = new URLSearchParams(location.search).has('register') ? 'register' : 'login') {
  const err = h('p', { class: 'error' });
  const f = {};
  const field = (name, label, attrs = {}) => (f[name] = h('input', { name, 'aria-label': label, placeholder: label, autocomplete: attrs.autocomplete || 'off', ...attrs }));
  let role = 'trainee', iMode = 'create';
  const render = () => {
    const regs = mode === 'register';
    const kids = [h('h2', null, regs ? 'Create account' : 'Sign in')];
    if (regs) {
      kids.push(h('div', { class: 'seg' }, ['trainee', 'instructor'].map((r) => h('button', { type: 'button', class: role === r ? 'on' : '', onclick: () => { role = r; render(); } }, r === 'trainee' ? 'Trainee' : 'Instructor'))),
        field('name', 'Rank and name', { maxlength: 60, autocomplete: 'name' }));
    }
    kids.push(field('username', 'Username', { maxlength: 32, autocomplete: 'username' }), field('password', regs ? 'Password (8+ characters)' : 'Password', { type: 'password', autocomplete: regs ? 'new-password' : 'current-password', maxlength: 128 }));
    if (regs && role === 'trainee') kids.push(field('joinCode', 'Unit join code (from your instructor)', { maxlength: 12 }));
    if (regs && role === 'instructor') {
      kids.push(field('instructorCode', 'Instructor registration code', { type: 'password' }),
        h('div', { class: 'seg' }, [['create', 'Create a unit'], ['join', 'Join a unit']].map(([k, t]) => h('button', { type: 'button', class: iMode === k ? 'on' : '', onclick: () => { iMode = k; render(); } }, t))),
        iMode === 'create' ? field('unitName', 'Unit name', { maxlength: 60 }) : field('joinCode', 'Unit join code', { maxlength: 12 }));
    }
    kids.push(err, h('button', { class: 'btn wide', type: 'submit' }, regs ? 'Create account' : 'Sign in'),
      h('p', { class: 'muted center' }, regs ? 'Already have an account? ' : 'New here? ', h('a', { class: 'link', href: '#', onclick: (e) => { e.preventDefault(); mode = regs ? 'login' : 'register'; render(); } }, regs ? 'Sign in' : 'Create an account')));
    const form = h('form', { class: 'auth', novalidate: true, onsubmit: submit }, kids);
    clear(app).append(h('div', { class: 'authwrap' }, h('div', { class: 'brand big' }, h('b', null, 'COUNTER-UAS TRAINER'), h('span', null, 'Recognise · classify · respond: drone and swarm threat training')), form));
  };
  async function submit(e) {
    e.preventDefault();
    err.textContent = '';
    const v = (k) => (f[k] ? f[k].value : '');
    const regs = mode === 'register';
    const body = regs ? { role, name: v('name'), username: v('username'), password: v('password'), joinCode: v('joinCode'), instructorCode: v('instructorCode'), unitName: iMode === 'create' ? v('unitName') : '' } : { username: v('username'), password: v('password') };
    const r = await api(regs ? '/api/register' : '/api/login', { method: 'POST', body });
    if (!r.ok) return showError(err, r);
    state.user = r.data.user;
    state.tab = null;
    flushQueue();
    shell();
  }
  render();
}

(async function boot() {
  const me = await api('/api/me');
  if (me.ok) {
    state.user = me.data.user;
    shell();
  } else if (me.status === 0) {
    clear(app).append(h('div', { class: 'authwrap' }, h('p', { class: 'error' }, 'Cannot reach the training server. Start it with "npm run server" and reload.')));
  } else authView();
})();
