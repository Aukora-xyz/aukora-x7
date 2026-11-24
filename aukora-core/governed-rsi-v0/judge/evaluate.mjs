// The EXECUTED evaluator and scorer. Part of the JUDGE: a proposer may not change it.
// Same integer arithmetic as judge/Organ.lean. Largest magnitude reachable: |hidden| <= 127*15+128, |score| <= 127*4*2033+128 < 2^21.
export const s8 = b => (b < 128 ? b : b - 256);
const relu = x => (x < 0 ? 0 : x);
const get = (w, i) => s8(w[i] ?? 0);
const hidden = (w, j, r, o, h) => relu(get(w, 4 * j) * r + get(w, 4 * j + 1) * o + get(w, 4 * j + 2) * h + get(w, 4 * j + 3));
const score = (w, k, r, o, h) => [0, 1, 2, 3].reduce((s, j) => s + get(w, 16 + 5 * k + j) * hidden(w, j, r, o, h), get(w, 16 + 5 * k + 4));
export function decision(w, r, o, h) { const a = score(w, 0, r, o, h), b = score(w, 1, r, o, h), c = score(w, 2, r, o, h); return a <= c && b <= c ? 2 : a <= b ? 1 : 0; }
export function table(w) { let s = ''; for (let r = 0; r < 8; r++) for (let o = 0; o < 2; o++) for (let h = 0; h < 8; h++) s += decision(w, r, o, h); return s; }
export const points = corpus => corpus.cases;                       // [{r,o,h,label}]
export const scoreOn = (w, corpus) => corpus.cases.filter(c => decision(w, c.r, c.o, c.h) === c.label).length;
