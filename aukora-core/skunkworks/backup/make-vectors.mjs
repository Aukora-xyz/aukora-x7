import { writeFileSync } from 'node:fs';

const SEED = 0x6d2b79f5;
let state = SEED;

function next() {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}
function bytes(length) {
  return Array.from({ length }, () => (next() & 255).toString(16).padStart(2, '0')).join('');
}
function truth(seen, now) {
  if (now.length < seen.length) return 1;
  return seen.every((line, i) => line === now[i]) ? 0 : 2;
}
function changed(line) {
  return (parseInt(line.slice(0, 2), 16) ^ 1).toString(16).padStart(2, '0') + line.slice(2);
}
const cases = [];
function add(g, seen, now) {
  cases.push({ g, seen, now, verdict: truth(seen, now) });
}
for (let n = 0; n < 24; n++) {
  const g = bytes(32);
  const lines = Array.from({ length: 3 + n % 5 }, (_, i) =>
    i.toString(16).padStart(2, '0') + bytes(1 + next() % 4));
  const mid = Math.floor(lines.length / 2);
  add(g, lines, lines);
  for (let k = 1; k <= 5; k++) add(g, lines, [...lines, ...Array.from({ length: k }, () => bytes(2))]);
  add(g, lines, lines.slice(0, -1));
  add(g, lines, []);
  for (const at of [0, mid, lines.length - 1]) {
    const rewritten = lines.slice();
    rewritten[at] = changed(rewritten[at]);
    add(g, lines, rewritten);
  }
  const swap = lines.slice();
  [swap[mid], swap[mid - 1]] = [swap[mid - 1], swap[mid]];
  add(g, lines, swap);
  add(g, lines, [...lines.slice(1), 'ff']);
  add(g, lines, ['ff', ...lines]);
  add(g, lines, [...lines.slice(0, mid), 'ff', ...lines.slice(mid)]);
  add(g, ['6162', '63'], ['61', '6263']);
  add(g, ['', lines[0], ''], ['', lines[0], '', '']);
  add(g, [], lines);
}
add('00'.repeat(32), [], []);
add('01'.repeat(32), [''], ['']);
add('02'.repeat(32), ['61'], ['61', 'a5'.repeat(70000)]);

const output = process.argv[2] ?? new URL('./vectors.json', import.meta.url);
writeFileSync(output, '[\n' + cases.map(row => JSON.stringify(row)).join(',\n') + '\n]\n', 'utf8');
