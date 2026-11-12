// Needles are assembled so the source text does not contain the path literal.
export const HOME_PREFIX = String.fromCharCode(47, 85, 115, 101, 114, 115, 47);
// The machine account name the scrub gate refuses. Set AUKORA_SCRUB_MACHINE_USER to the operator's own account name.
export const MACHINE_USER = String(globalThis.process?.env?.AUKORA_SCRUB_MACHINE_USER || ['unset', 'machine', 'user'].join('-')).toLowerCase();

export function forbiddenHit(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.includes(HOME_PREFIX)) return 'home-prefix';
  if (text.toLowerCase().includes(MACHINE_USER)) return 'machine-user';
  return null;
}
