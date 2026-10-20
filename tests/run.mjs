// npm test: runs every suite in its own process and totals the PASS / FAIL lines.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const suites = ['scoring', 'drones', 'training', 'server', 'dashboard'];
let pass = 0, fail = 0;
for (const name of suites) {
  const r = spawnSync(process.execPath, [path.join(dir, `${name}.test.mjs`)], { encoding: 'utf8', timeout: 180000 });
  const lines = (r.stdout || '').split('\n');
  const p = lines.filter((l) => l.startsWith('PASS')).length, f = lines.filter((l) => l.startsWith('FAIL'));
  pass += p;
  fail += f.length + (r.status !== 0 && !f.length ? 1 : 0);
  console.log(`${f.length || r.status ? 'FAIL' : ' ok '}  ${name.padEnd(10)} ${p} passed${f.length ? `, ${f.length} failed` : ''}`);
  f.forEach((l) => console.log('        ' + l));
  if (r.status !== 0 && !f.length) console.log('        exited with', r.status, (r.stderr || '').split('\n').slice(0, 6).join('\n        '));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
