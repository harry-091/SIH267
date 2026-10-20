import { scoreContact, scoreSession, coach, triage } from '../src/scoring.js';
import { generate, SCRIPTED, recommend, signature } from '../src/scenario.js';
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);

// --- scoring: the decision tree
const base = { truth: 'ATTACK', origin: 'behind', tSpawn: 0, tObs: 5, tDes: 7, guess: 'ATTACK', guessAtEngage: 'ATTACK', engaged: true, engageT: 10, outcome: 'neutralized', eta: 14 };
let s = scoreContact(base);
ok(s.detect === 30 && s.classify === 30 && s.decide === 40 && s.total === 100, `perfect attack = 100 (${s.total})`);
s = scoreContact({ ...base, tDes: 5 + 9 });
ok(s.detect > 14 && s.detect < 16, `9 s to designate gives half detection points (${s.detect})`);
s = scoreContact({ ...base, guess: 'CIVILIAN', guessAtEngage: 'CIVILIAN' });
ok(s.classify === 0 && s.decide === 20, `engaging what you called civilian: class 0, decide halved (${s.classify}/${s.decide})`);
s = scoreContact({ ...base, tDes: null, guess: null, guessAtEngage: null });
ok(s.detect === 0 && s.classify === 0 && s.decide === 20 && s.total === 20, `shooting an undesignated attack drone = 20 (${s.total})`);
s = scoreContact({ ...base, engaged: false, outcome: 'leaked' });
ok(s.decide === 0 && s.total === 60, `leak keeps detect+classify only (${s.total})`);
s = scoreContact({ truth: 'FRIENDLY', origin: 'sky', tObs: 2, tDes: 4, guess: 'FRIENDLY', engaged: true, guessAtEngage: 'FRIENDLY', outcome: 'neutralized' });
ok(s.violation === 'Fratricide' && s.total === 0 && s.penalty === 60, `fratricide: ${s.violation}, total ${s.total}`);
s = scoreContact({ truth: 'CIVILIAN', origin: 'sky', tObs: 2, tDes: 4, guess: 'CIVILIAN', engaged: false, outcome: 'expired' });
ok(s.total === 100, `civilian classified and left alone = 100 (${s.total})`);
s = scoreContact({ truth: 'RECON', origin: 'sky', tObs: 1, tDes: 3, guess: 'RECON', engaged: false, outcome: 'expired' });
ok(s.decide === 20, 'recon left untouched = half decision points');

// --- session
const m = scoreSession({ contacts: [base, { ...base, id: 2, outcome: 'leaked', engaged: false, truth: 'ATTACK' }], falseAlarms: 2, shots: 10, hits: 4 });
console.log('session:', m.score, m.grade, 'leaks', m.leaks, 'fa', m.falseAlarms, 'acc', m.accuracy, 'skills', m.skills);
ok(m.leaks === 1 && m.falseAlarms === 2, 'leak and false alarms counted');
ok(scoreSession({ contacts: [base], died: true }).score <= 59, 'a session where the position fell cannot pass');
console.log(coach(m, { contacts: [base] }).slice(0, 3));
ok(triage([{ truth: 'ATTACK', tSpawn: 0, engageT: 5, eta: 8 }, { truth: 'ATTACK', tSpawn: 0, engageT: 9, eta: 12 }]) === 100, 'triage: nearest-first = 100');
ok(triage([{ truth: 'ATTACK', tSpawn: 0, engageT: 9, eta: 8 }, { truth: 'ATTACK', tSpawn: 0, engageT: 5, eta: 12 }]) === 0, 'triage: wrong order = 0');

// --- scenarios
const a = generate({ seed: 1234, difficulty: 6 }), b = generate({ seed: 1234, difficulty: 6 });
ok(JSON.stringify(a) === JSON.stringify(b), 'same seed -> identical scenario');
const sigs = new Set(); for (let i = 1; i <= 40; i++) sigs.add(generate({ seed: i * 101, difficulty: 5 }).signature);
ok(sigs.size >= 35, `40 seeds -> ${sigs.size} distinct scenarios`);
const prev = generate({ seed: 9, difficulty: 5 });
const again = generate({ seed: 9, difficulty: 5, avoid: [prev.signature] });
ok(again.signature !== prev.signature, 'avoid list forces a different scenario');
const easy = generate({ seed: 5, difficulty: 1 }), hard = generate({ seed: 5, difficulty: 10 });
const nAtk = (x) => x.timeline.filter((c) => ['quad','scout','heavy'].includes(c.kind)).length;
ok(nAtk(hard) > nAtk(easy) + 5, `difficulty scales contacts (${nAtk(easy)} -> ${nAtk(hard)} hostile)`);
ok(hard.timeline.some((c) => c.spoof), 'difficulty 10 includes IFF spoofing');
ok(SCRIPTED.every((x) => x.timeline.length && x.signature === undefined), 'scripted scenarios well-formed');
console.log('d10:', hard.name, '|', hard.summary);

// --- adaptive difficulty
const H = (score, difficulty, extra = {}) => ({ score, difficulty, ...extra });
ok(recommend([]).difficulty === 1, 'new trainee starts at 1');
ok(recommend([H(90,3),H(88,3),H(92,3)]).difficulty === 5, 'three strong -> +2');
ok(recommend([H(60,3),H(55,3),H(45,3)]).difficulty === 3, 'mid average holds');
ok(recommend([H(30,4),H(35,4),H(40,4)]).difficulty === 3, 'weak steps down');
ok(recommend([H(80,4,{died:true})]).difficulty === 3, 'overrun steps down');
const conf = { CIVILIAN: { CIVILIAN: 1, RECON: 5, ATTACK: 0, FRIENDLY: 0, BIRD: 0, NONE: 0 } };
console.log('focus:', recommend([H(70,4,{confusion:conf}), H(72,4,{confusion:conf})]));
