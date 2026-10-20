// The training server: accounts, training results, the dashboard's data, and the built game.
// No dependencies (Node 18+): http, crypto and fs only, so it runs on any unit laptop, offline.
//
//   npm run build && npm run server        -> http://localhost:3001  (game at /, dashboard at /dashboard.html)
//
// Accounts: trainees register (optionally with a unit's join code); instructors register with the
// instructor code (CUAS_INSTRUCTOR_CODE, or one generated on first run and printed here), and either
// create a unit or join an existing one. An instructor sees the trainees of their own unit only.
// Passwords are hashed with scrypt, sessions are random tokens in HttpOnly SameSite=Strict cookies
// (only their hashes are stored), logins are rate limited, and every training result is re-scored
// here from its raw contact records, so a modified client cannot award itself marks.
// Data: one JSON file (server/data/db.json), written atomically. Fine for a unit of a few hundred
// trainees; swap the Db class for SQLite beyond that.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { scoreSession, coach, CLASSES } from '../src/scoring.js';
import { recommend, SCRIPTED, KINDS } from '../src/scenario.js';

const scrypt = promisify(crypto.scrypt);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSION_TTL = 12 * 3600 * 1000;
const MAX_BODY = 600 * 1024;
const ENVS = ['day', 'dusk', 'night'], RADARS = ['full', 'degraded', 'jammed'], IFFS = ['ok', 'degraded'];
const ORIGINS = ['inside', 'behind', 'sky'], OUTCOMES = ['neutralized', 'leaked', 'expired'];
const EVENT_TYPES = ['launch', 'observable', 'designated', 'classified', 'engaged', 'neutralized', 'leaked', 'expired', 'false_alarm'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json' };

// ---------------------------------------------------------------- storage

class Db {
  constructor(file) {
    this.file = file;
    this.d = { users: {}, units: {}, sessions: [], auth: {} };
    try {
      this.d = { ...this.d, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    this.timer = null;
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 150);
  }

  flush() {
    clearTimeout(this.timer);
    const tmp = this.file + '.tmp';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.d));
    fs.renameSync(tmp, this.file); // atomic: a crash never leaves half a file
  }
}

const id = (n = 9) => crypto.randomBytes(n).toString('base64url');
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const joinCode = () => Array.from(crypto.randomBytes(6), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function checkPassword(pw, stored) {
  const [alg, salt, key] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const want = Buffer.from(key, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), want.length);
  return crypto.timingSafeEqual(got, want);
}

// ---------------------------------------------------------------- validation

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (m) => new HttpError(400, m);
const num = (v, lo, hi, dflt = null) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
const oneOf = (v, list, dflt = null) => (list.includes(v) ? v : dflt);
const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

// A training result from the game, reduced to exactly the fields the scorer reads, each clamped.
function cleanSession(raw) {
  if (!raw || typeof raw !== 'object') throw bad('No session.');
  if (!Array.isArray(raw.contacts) || !raw.contacts.length || raw.contacts.length > 60) throw bad('A session has 1 to 60 contacts.');
  const contacts = raw.contacts.map((c, i) => {
    if (!c || typeof c !== 'object') throw bad('Bad contact.');
    const truth = oneOf(c.truth, CLASSES);
    if (!truth) throw bad('Bad contact class.');
    const tSpawn = num(c.tSpawn, 0, 3600, 0);
    const tObs = num(c.tObs, 0, 3600);
    let tDes = num(c.tDes, 0, 3600);
    if (tDes != null && tObs != null && tDes < tObs) tDes = tObs; // designating cannot precede being able to
    const engaged = c.engaged === true;
    return {
      id: text(c.id, 8) || `T${i}`, kind: oneOf(c.kind, Object.keys(KINDS), 'quad'), truth, origin: oneOf(c.origin, ORIGINS, 'sky'), spoof: c.spoof === true,
      tSpawn, tObs, tDes, guess: oneOf(c.guess, CLASSES), guessT: num(c.guessT, 0, 3600), changes: num(c.changes, 0, 50, 0),
      engaged, engageT: engaged ? num(c.engageT, 0, 3600) : null, engageRange: engaged ? num(c.engageRange, 0, 500) : null,
      guessAtEngage: engaged ? oneOf(c.guessAtEngage, CLASSES) : null, outcome: oneOf(c.outcome, OUTCOMES, 'expired'), outcomeT: num(c.outcomeT, 0, 3600),
      eta: num(c.eta, 0, 3600),
    };
  });
  const shots = Math.round(num(raw.shots, 0, 2000, 0));
  const sensors = raw.sensors || {};
  const events = (Array.isArray(raw.events) ? raw.events : []).slice(0, 500).flatMap((e) => {
    const type = e && oneOf(e.type, EVENT_TYPES);
    if (!type) return [];
    return [{ t: num(e.t, -20, 3600, 0), type, id: text(e.id, 8) || null, ...(e.guess ? { guess: oneOf(e.guess, CLASSES) } : {}), ...(e.truth ? { truth: oneOf(e.truth, CLASSES) } : {}), ...(e.origin ? { origin: oneOf(e.origin, ORIGINS) } : {}), ...(e.by ? { by: text(e.by, 16) } : {}) }];
  });
  return {
    version: 1, scenarioId: text(raw.scenarioId, 16) || '?', scenarioName: text(raw.scenarioName, 80) || 'Scenario', procedural: raw.procedural === true,
    seed: num(raw.seed, 0, 4294967295), signature: text(raw.signature, 16) || null, difficulty: Math.round(num(raw.difficulty, 1, 10, 1)),
    env: oneOf(raw.env, ENVS, 'day'), sensors: { radar: oneOf(sensors.radar, RADARS, 'full'), iff: oneOf(sensors.iff, IFFS, 'ok') },
    terrain: oneOf(raw.terrain, ['urban', 'suburban', 'rural'], 'rural'), startedAt: new Date(Date.parse(raw.startedAt) || Date.now()).toISOString(),
    duration: Math.round(num(raw.duration, 0, 3600, 0)), reason: oneOf(raw.reason, ['complete', 'timeout', 'died'], 'complete'), died: raw.died === true,
    shots, hits: Math.round(num(raw.hits, 0, shots, 0)), falseAlarms: Math.round(num(raw.falseAlarms, 0, 50, 0)), contacts, events,
  };
}

// ---------------------------------------------------------------- summaries the dashboard charts

function summary(rec) {
  const m = rec.m;
  return {
    id: rec.id, userId: rec.userId, at: rec.session.startedAt, scenarioId: rec.session.scenarioId, scenarioName: rec.session.scenarioName, procedural: rec.session.procedural,
    difficulty: rec.session.difficulty, env: rec.session.env, radar: rec.session.sensors.radar, iff: rec.session.sensors.iff, terrain: rec.session.terrain,
    duration: rec.session.duration, signature: rec.session.signature, score: m.score, grade: m.grade, passed: m.passed, died: m.died, contacts: m.contacts,
    meanDetect: m.meanDetect, skills: m.skills, classAccuracy: m.classAccuracy, engageAccuracy: m.engageAccuracy, leaks: m.leaks, fratricide: m.fratricide,
    collateral: m.collateral, wasted: m.wasted, falseAlarms: m.falseAlarms, accuracy: m.accuracy, triage: m.triage, confusion: m.confusion, byOrigin: m.byOrigin,
  };
}

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

function weakest(skills) {
  const e = Object.entries(skills).sort((a, b) => a[1] - b[1])[0];
  return e ? e[0] : null;
}

function rosterRow(user, sums) {
  const last5 = sums.slice(-5), prev = sums.slice(-8, -3);
  const sk = (k) => r1(mean(last5.map((s) => s.skills[k])));
  const skills = { detect: sk('detect'), classify: sk('classify'), decide: sk('decide') };
  return {
    id: user.id, name: user.name, username: user.username, sessions: sums.length, lastAt: sums.length ? sums[sums.length - 1].at : null,
    avgLast5: r1(mean(last5.map((s) => s.score))), best: sums.length ? Math.max(...sums.map((s) => s.score)) : null,
    trend: sums.length >= 4 ? r1(mean(last5.map((s) => s.score)) - mean(prev.map((s) => s.score))) : null,
    skills: sums.length ? skills : null, weakest: sums.length ? weakest(skills) : null,
    leaks: last5.reduce((s, x) => s + x.leaks, 0), violations: last5.reduce((s, x) => s + x.fratricide + x.collateral, 0), passRate: sums.length ? Math.round((sums.filter((s) => s.passed).length / sums.length) * 100) : null,
    difficulty: sums.length ? sums[sums.length - 1].difficulty : null, spark: sums.slice(-12).map((s) => s.score),
  };
}

function mergeConfusion(sums) {
  const out = {};
  for (const t of CLASSES) {
    out[t] = {};
    for (const g of [...CLASSES, 'NONE']) out[t][g] = 0;
  }
  for (const s of sums) for (const t of CLASSES) for (const g of Object.keys(out[t])) out[t][g] += s.confusion?.[t]?.[g] || 0;
  return out;
}

function conditions(sums) {
  const group = (key) => {
    const o = {};
    for (const s of sums) {
      const k = key(s);
      (o[k] = o[k] || []).push(s.score);
    }
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { n: v.length, avg: r1(mean(v)) }]));
  };
  const orig = {};
  for (const s of sums) for (const [k, v] of Object.entries(s.byOrigin || {})) if (v.meanDetect != null) (orig[k] = orig[k] || []).push(v.meanDetect);
  return {
    env: group((s) => s.env), radar: group((s) => s.radar), terrain: group((s) => s.terrain), swarm: group((s) => (s.scenarioName.includes('warm') ? 'swarm' : 'single/mixed')),
    detectByOrigin: Object.fromEntries(Object.entries(orig).map(([k, v]) => [k, { n: v.length, avg: r1(mean(v)) }])),
  };
}

function daily(sums) {
  const days = {};
  for (const s of sums) (days[s.at.slice(0, 10)] = days[s.at.slice(0, 10)] || []).push(s);
  return Object.entries(days).sort().map(([day, v]) => ({ day, n: v.length, score: r1(mean(v.map((s) => s.score))), detect: r1(mean(v.map((s) => s.skills.detect))), classify: r1(mean(v.map((s) => s.skills.classify))), decide: r1(mean(v.map((s) => s.skills.decide))) }));
}

function csvCell(v) {
  let t = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // a name like =HYPERLINK(...) must not run in a spreadsheet
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

// ---------------------------------------------------------------- the server

export function createServer({ dataDir = path.join(HERE, 'data'), distDir = path.join(HERE, '..', 'dist'), instructorCode, secureCookie = false } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Db(path.join(dataDir, 'db.json'));
  const cfgFile = path.join(dataDir, 'config.json');
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  } catch (e) {
    // first run
  }
  const code = instructorCode || process.env.CUAS_INSTRUCTOR_CODE || cfg.instructorCode || id(6);
  if (!instructorCode && !process.env.CUAS_INSTRUCTOR_CODE && cfg.instructorCode !== code) fs.writeFileSync(cfgFile, JSON.stringify({ instructorCode: code }));
  const attempts = new Map(); // ip -> times of recent login/register attempts
  const locks = new Map(); // username -> { fails, until }

  const D = db.d;
  // Default trainer credentials
const DEFAULT_TRAINER_USERNAME = 'trainer';
const DEFAULT_TRAINER_PASSWORD = 'Trainer@123';
  const userByName = (u) => Object.values(D.users).find((x) => x.username === u);
  async function ensureDefaultTrainer() {
  let trainer = userByName(DEFAULT_TRAINER_USERNAME);

  // Create the account only if it doesn't exist.
  if (!trainer) {
    const unit = {
      id: id(6),
      name: 'Default Training Unit',
      joinCode: joinCode(),
      createdAt: new Date().toISOString(),
    };

    D.units[unit.id] = unit;

    trainer = {
      id: id(6),
      username: DEFAULT_TRAINER_USERNAME,
      name: 'Default Trainer',
      role: 'instructor',
      unitId: unit.id,
      pw: await hashPassword(DEFAULT_TRAINER_PASSWORD),
      createdAt: new Date().toISOString(),
    };

    D.users[trainer.id] = trainer;
    db.flush();

    console.log('Default trainer account created.');
    console.log('Username: trainer');
    console.log('Password: Trainer@123');
  }
}
  const sessionsOf = (uid) => D.sessions.filter((s) => s.userId === uid);
  const sums = (uid) => sessionsOf(uid).map(summary).sort((a, b) => a.at.localeCompare(b.at));

  // Per address, over five minutes. kind 'fail': only wrong passwords count (a classroom shares one
  // address, so honest logins must never add up); kind 'reg': enrolling, with a generous allowance.
  function tooMany(ip, kind, max, add = true) {
    const now = Date.now(), k = kind + ip;
    const list = (attempts.get(k) || []).filter((t) => now - t < 300000);
    if (add) list.push(now);
    attempts.set(k, list);
    return list.length > max;
  }

  const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, unit: u.unitId ? { id: u.unitId, name: D.units[u.unitId].name, ...(u.role === 'instructor' ? { joinCode: D.units[u.unitId].joinCode } : {}) } : null });

  function authUser(req) {
    const m = /(?:^|;\s*)cuas_sid=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '');
    if (!m) return null;
    const h = sha(m[1]), a = D.auth[h];
    if (!a || a.exp < Date.now()) {
      if (a) delete D.auth[h];
      return null;
    }
    return D.users[a.uid] || null;
  }

  function login(res, user) {
    const token = id(32);
    D.auth[sha(token)] = { uid: user.id, exp: Date.now() + SESSION_TTL };
    for (const [h, a] of Object.entries(D.auth)) if (a.exp < Date.now()) delete D.auth[h];
    db.save();
    res.setHeader('Set-Cookie', `cuas_sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}${secureCookie ? '; Secure' : ''}`);
  }

  const need = (user, role) => {
    if (!user) throw new HttpError(401, 'Sign in first.');
    if (role && user.role !== role) throw new HttpError(403, 'Instructors only.');
    return user;
  };

  // can `user` look at sessions that belong to `ownerId`?
  const canSee = (user, ownerId) => user.id === ownerId || (user.role === 'instructor' && user.unitId && D.users[ownerId]?.unitId === user.unitId);

  // ---- the routes: [method, pattern, handler(ctx)]
  const routes = [];
  const route = (method, pattern, fn) => routes.push([method, new RegExp(`^${pattern}$`), fn]);

  route('GET', '/api/health', () => ({ ok: true }));

  route('POST', '/api/register', async ({ body, res, ip }) => {
    if (tooMany(ip, 'reg', 40)) throw new HttpError(429, 'Too many accounts created from this address. Wait a few minutes.');
    const username = text(body.username, 32).toLowerCase(), name = text(body.name, 60), password = typeof body.password === 'string' ? body.password : '';
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw bad('Username: 3-32 letters, digits, . _ -');
    if (!name) throw bad('Enter your name (rank and name).');
    if (password.length < 8 || password.length > 128) throw bad('Password: 8 to 128 characters.');
    if (password.toLowerCase() === username) throw bad('The password cannot be the username.');
    if (userByName(username)) throw new HttpError(409, 'That username is taken.');
    const role = body.role === 'instructor' ? 'instructor' : 'trainee';
    let unit = null;
    const jc = text(body.joinCode, 12).toUpperCase();
    if (role === 'instructor') {
      const given = Buffer.from(typeof body.instructorCode === 'string' ? body.instructorCode : ''), want = Buffer.from(code);
      if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) throw new HttpError(403, 'Wrong instructor code.');
      if (jc) {
        unit = Object.values(D.units).find((u) => u.joinCode === jc);
        if (!unit) throw bad('No unit has that join code.');
      } else {
        const unitName = text(body.unitName, 60);
        if (unitName.length < 2) throw bad('Name the unit to create (or give a join code to join one).');
        unit = { id: id(6), name: unitName, joinCode: joinCode(), createdAt: new Date().toISOString() };
        D.units[unit.id] = unit;
      }
    } else if (jc) {
      unit = Object.values(D.units).find((u) => u.joinCode === jc);
      if (!unit) throw bad('No unit has that join code.');
    }
    const user = { id: id(6), username, name, role, unitId: unit ? unit.id : null, pw: await hashPassword(password), createdAt: new Date().toISOString() };
    D.users[user.id] = user;
    login(res, user);
    return { user: publicUser(user) };
  });

  route('POST', '/api/login', async ({ body, res, ip }) => {
    if (tooMany(ip, 'fail', 25, false)) throw new HttpError(429, 'Too many failed sign-ins from this address. Wait a few minutes.');
    const username = text(body.username, 32).toLowerCase();
    const lock = locks.get(username);
    if (lock && lock.until > Date.now()) throw new HttpError(429, 'Account locked for a few minutes after repeated failures.');
    const user = userByName(username);
    const ok = user ? await checkPassword(typeof body.password === 'string' ? body.password : '', user.pw) : (await checkPassword('x', 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64')), false);
    if (!ok) {
      tooMany(ip, 'fail', 25);
      const l = lock || { fails: 0, until: 0 };
      l.fails++;
      if (l.fails >= 8) {
        l.until = Date.now() + 300000;
        l.fails = 0;
      }
      locks.set(username, l);
      throw new HttpError(401, 'Wrong username or password.');
    }
    locks.delete(username);
    login(res, user);
    return { user: publicUser(user) };
  });

  route('POST', '/api/logout', ({ req, res }) => {
    const m = /(?:^|;\s*)cuas_sid=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '');
    if (m) delete D.auth[sha(m[1])];
    db.save();
    res.setHeader('Set-Cookie', 'cuas_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return { ok: true };
  });

  route('GET', '/api/me', ({ user }) => ({ user: publicUser(need(user)) }));

  route('POST', '/api/me/unit', ({ user, body }) => {
    need(user);
    const unit = Object.values(D.units).find((u) => u.joinCode === text(body.joinCode, 12).toUpperCase());
    if (!unit) throw bad('No unit has that join code.');
    user.unitId = unit.id;
    db.save();
    return { user: publicUser(user) };
  });

  route('GET', '/api/scenarios', ({ user }) => {
    need(user);
    return { scenarios: SCRIPTED.map(({ timeline, ...s }) => ({ ...s, contacts: timeline.length })) };
  });

  route('POST', '/api/sessions', ({ user, body }) => {
    need(user);
    const session = cleanSession(body.session);
    const dupe = sessionsOf(user.id).find((s) => s.session.startedAt === session.startedAt && s.session.scenarioId === session.scenarioId);
    if (dupe) return { id: dupe.id, duplicate: true, summary: summary(dupe) };
    const m = scoreSession(session); // the server's own marks: the client's are never trusted
    const rec = { id: id(8), userId: user.id, unitId: user.unitId, session, m };
    D.sessions.push(rec);
    db.save();
    return { id: rec.id, summary: summary(rec), next: recommend(sums(user.id)) };
  });

  route('GET', '/api/sessions', ({ user }) => {
    need(user);
    return { sessions: sums(user.id) };
  });

  route('GET', '/api/sessions/([A-Za-z0-9_-]+)', ({ user, params }) => {
    need(user);
    const rec = D.sessions.find((s) => s.id === params[0]);
    if (!rec || !canSee(user, rec.userId)) throw new HttpError(404, 'No such session.');
    return { summary: summary(rec), metrics: rec.m, session: rec.session, coach: coach(rec.m, rec.session), owner: { id: rec.userId, name: D.users[rec.userId]?.name } };
  });

  route('GET', '/api/next', ({ user }) => {
    need(user);
    return recommend(sums(user.id));
  });

  // ---- the instructor's view of their own unit
  const unitOf = (user) => {
    need(user, 'instructor');
    if (!user.unitId) throw bad('You are not attached to a unit.');
    return D.units[user.unitId];
  };

  route('GET', '/api/unit', ({ user }) => {
    const unit = unitOf(user);
    const trainees = Object.values(D.users).filter((u) => u.unitId === unit.id && u.role === 'trainee');
    const all = [];
    const roster = trainees.map((t) => {
      const s = sums(t.id);
      all.push(...s);
      return rosterRow(t, s);
    });
    all.sort((a, b) => a.at.localeCompare(b.at));
    return {
      unit: { id: unit.id, name: unit.name, joinCode: unit.joinCode },
      instructors: Object.values(D.users).filter((u) => u.unitId === unit.id && u.role === 'instructor').map((u) => ({ id: u.id, name: u.name })),
      roster,
      totals: {
        trainees: trainees.length, sessions: all.length, avgScore: r1(mean(all.map((s) => s.score))), passRate: all.length ? Math.round((all.filter((s) => s.passed).length / all.length) * 100) : null,
        leaks: all.reduce((s, x) => s + x.leaks, 0), violations: all.reduce((s, x) => s + x.fratricide + x.collateral, 0), meanDetect: r1(mean(all.filter((s) => s.meanDetect != null).map((s) => s.meanDetect))),
        skills: all.length ? { detect: r1(mean(all.map((s) => s.skills.detect))), classify: r1(mean(all.map((s) => s.skills.classify))), decide: r1(mean(all.map((s) => s.skills.decide))) } : null,
      },
      series: daily(all),
      confusion: mergeConfusion(all),
      conditions: conditions(all),
    };
  });

  route('GET', '/api/unit/users/([A-Za-z0-9_-]+)/sessions', ({ user, params }) => {
    const unit = unitOf(user);
    const t = D.users[params[0]];
    if (!t || t.unitId !== unit.id) throw new HttpError(404, 'No such trainee in your unit.');
    return { user: { id: t.id, name: t.name, username: t.username }, sessions: sums(t.id) };
  });

  route('POST', '/api/unit/rotate-code', ({ user }) => {
    const unit = unitOf(user);
    unit.joinCode = joinCode();
    db.save();
    return { joinCode: unit.joinCode };
  });

  route('GET', '/api/unit/export.csv', ({ user }) => {
    const unit = unitOf(user);
    const head = ['date', 'name', 'username', 'scenario', 'difficulty', 'env', 'radar', 'terrain', 'score', 'grade', 'passed', 'mean_detect_s', 'class_acc_pct', 'engage_acc_pct', 'leaks', 'fratricide', 'collateral', 'false_alarms'];
    const rows = [head.join(',')];
    for (const t of Object.values(D.users).filter((u) => u.unitId === unit.id && u.role === 'trainee')) {
      for (const s of sums(t.id)) rows.push([s.at, t.name, t.username, s.scenarioName, s.difficulty, s.env, s.radar, s.terrain, s.score, s.grade, s.passed, s.meanDetect, s.classAccuracy, s.engageAccuracy, s.leaks, s.fratricide, s.collateral, s.falseAlarms].map(csvCell).join(','));
    }
    return { csv: rows.join('\n') + '\n', filename: `${unit.name.replace(/[^A-Za-z0-9]+/g, '_')}_training.csv` };
  });

  // ---- request plumbing
  async function readBody(req) {
    const chunks = [];
    let n = 0;
    for await (const c of req) {
      n += c.length;
      if (n > MAX_BODY) throw new HttpError(413, 'Too large.');
      chunks.push(c);
    }
    if (!n) return {};
    if (!/^application\/json/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'JSON only.');
    try {
      const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return b && typeof b === 'object' ? b : {};
    } catch (e) {
      throw bad('Malformed JSON.');
    }
  }

  const SEC = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' };

  function send(res, status, data, extra = {}) {
    const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
    // an upload refused half-way leaves the connection unusable: tell the client not to reuse it
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC, ...(status === 413 ? { Connection: 'close' } : {}), ...extra });
    res.end(body);
  }

  function serveStatic(req, res, pathname) {
    if (!fs.existsSync(distDir)) return send(res, 200, 'No build found. Run: npm run build\n', { 'Content-Type': 'text/plain; charset=utf-8' });
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch (e) {
      return send(res, 400, { error: 'Bad path' });
    }
    if (rel === '/' || rel === '') rel = '/index.html';
    if (rel === '/dashboard') rel = '/dashboard.html';
    const file = path.normalize(path.join(distDir, rel));
    if (!file.startsWith(path.normalize(distDir + path.sep))) return send(res, 403, { error: 'Forbidden' });
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, { error: 'Not found' });
      const ext = path.extname(file).toLowerCase();
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, ...SEC, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' };
      if (rel === '/dashboard.html') headers['Content-Security-Policy'] = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";
      res.writeHead(200, headers);
      fs.createReadStream(file).pipe(res);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
        return serveStatic(req, res, url.pathname);
      }
      if (req.method === 'POST') {
        // a cross-site form post carries a foreign Origin: refuse (the cookie is SameSite=Strict as well)
        const origin = req.headers.origin;
        let host = null;
        try {
          if (origin) host = new URL(origin).host;
        } catch (e) {
          host = '?'; // "null" and other junk origins
        }
        if (origin && host !== req.headers.host) throw new HttpError(403, 'Cross-origin request refused.');
      }
      for (const [method, re, fn] of routes) {
        const m = re.exec(url.pathname);
        if (method !== req.method || !m) continue;
        const ctx = { req, res, user: authUser(req), params: m.slice(1), body: req.method === 'POST' ? await readBody(req) : {}, ip: req.socket.remoteAddress || '?' };
        const out = await fn(ctx);
        if (out && out.csv) return send(res, 200, out.csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${out.filename}"` });
        return send(res, 200, out);
      }
      throw new HttpError(404, 'No such endpoint.');
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      send(res, 500, { error: 'Server error.' });
    }
  });
  server.instructorCode = code;
  server.db = db;
  server.on('close', () => db.flush());
server.ensureDefaultTrainer = ensureDefaultTrainer;
return server;
}

// run directly: node server/server.js
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = +process.env.PORT || 3001;

  const server = createServer({
    secureCookie: process.env.SECURE_COOKIE === '1',
  });

  server.ensureDefaultTrainer()
    .then(() => {
      server.listen(port, process.env.HOST || '0.0.0.0', () => {
        console.log(`Training server running on port ${port}`);
        console.log('Default trainer username: trainer');
      });
    })
    .catch((err) => {
      console.error('Failed to initialize default trainer:', err);
      process.exit(1);
    });

  const stop = () => {
    server.db.flush();
    process.exit(0);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
