// Emit the Lean witness table for the stated Cauchy coordinates. The Lean kernel
// independently checks both products using the reduction polynomial in Ark.lean.
function mul(a, b) {
  let z = 0;
  while (b) {
    if (b & 1) z ^= a;
    b >>= 1;
    a <<= 1;
    if (a & 256) a ^= 0x11d;
  }
  return z;
}
function inv(a) {
  for (let b = 1; b < 256; b++) if (mul(a,b) === 1) return b;
  throw new Error('zero has no inverse');
}
function coeff(r,j) { return r < 4 ? Number(r === j) : inv((r-4) ^ (j+6)); }
function certificate(rows) {
  const aug = rows.map((r,i) => Array.from({length:8}, (_,j) =>
    j < 4 ? coeff(r,j) : Number(i === j-4)));
  for (let pivot = 0; pivot < 4; pivot++) {
    const row = aug.findIndex((v,i) => i >= pivot && v[pivot] !== 0);
    if (row < 0) throw new Error('singular minor');
    [aug[pivot],aug[row]] = [aug[row],aug[pivot]];
    const scale = inv(aug[pivot][pivot]);
    aug[pivot] = aug[pivot].map(x => mul(x,scale));
    for (let i = 0; i < 4; i++) {
      if (i === pivot) continue;
      const k = aug[i][pivot];
      aug[i] = aug[i].map((x,j) => x ^ mul(k,aug[pivot][j]));
    }
  }
  let packed = 0n;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    packed |= BigInt(aug[i][4+j]) << BigInt(8*(10*i + rows[j]));
  }
  return packed;
}
const values = Array.from({length:1024}, (_,mask) => {
  const rows = Array.from({length:10}, (_,r) => r).filter(r => mask & (1<<r));
  return rows.length === 4 ? '0x'+certificate(rows).toString(16) : '0';
});
console.log('def packed : Array Nat := #[');
for (let i = 0; i < values.length; i += 8) {
  console.log('  '+values.slice(i,i+8).join(', ')+(i+8 === values.length ? ']' : ','));
}
