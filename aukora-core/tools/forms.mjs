// The core's form table, in plain JavaScript: the 38 forms, their fixed numbers, which ones can never be refused,
// and `formOf`, which reads a frame's bytes the way `Forms.formOf` in the Lean text does. This file is a COPY of the
// Lean table, kept honest by `tools/forms-test.mjs`, which reads the Lean source and fails on any difference.
export const FORMS = [
  ['say', 1], ['remember', 2], ['correct', 3], ['advise', 4], ['report', 5], ['spend', 6], ['read', 7], ['approval', 8],
  ['retract', 9], ['mandate', 10], ['budget', 11], ['pass', 12], ['revoke', 13], ['legacyKeyChange', 14], ['assessment', 15],
  ['threshold', 16], ['act', 17], ['timedApproval', 18], ['cancel', 19], ['correction', 20], ['install', 21],
  ['evidenceAssessment', 22], ['evidenceRead', 23], ['evidenceSource', 24], ['evidenceOutcome', 25], ['premise', 26],
  ['ceiling', 27], ['halt', 28], ['clear', 29], ['refusedAct', 30], ['keyChange', 31], ['cellReceipt', 32],
  ['cellAssessment', 33], ['stamp', 34], ['feed', 35], ['reset', 36], ['seal', 37], ['continuation', 38],
];
export const CODE = Object.fromEntries(FORMS), NAME = Object.fromEntries(FORMS.map(([n, c]) => [c, n]));
/** The owner's way back in: never refused, whatever a policy says (`Refusal.essential`, law `essentials_open`). */
export const ESSENTIAL = new Set(['halt', 'clear', 'keyChange', 'seal', 'continuation']);
/** What one plain sentence says each form does (for people reading a policy, not for the machine). */
export const PLAIN = {
  say: 'write a line', remember: 'record a claim', correct: 'correct a claim', advise: 'record advice', report: 'report an outcome',
  spend: 'spend from a budget', read: 'record a read', approval: 'OLD one-time approval that names no record',
  retract: 'owner retracts', mandate: 'owner gives a standing mandate', budget: 'owner sets a budget', pass: 'owner passes',
  revoke: 'owner revokes', legacyKeyChange: 'OLD key change that names no record', assessment: 'record an assessment',
  threshold: 'owner sets the danger threshold', act: 'act (spends an approval)', timedApproval: 'owner approval that signs this record\'s head',
  cancel: 'owner cancels an approval', correction: 'correct a report', install: 'install a new law set', evidenceAssessment: 'evidence: assessment',
  evidenceRead: 'evidence: read', evidenceSource: 'evidence: source', evidenceOutcome: 'evidence: outcome', premise: 'evidence: premise',
  ceiling: 'owner sets the evidence ceiling', halt: 'owner stops the record', clear: 'owner clears the stop', refusedAct: 'record a refused act',
  keyChange: 'owner key change that signs this record\'s head', cellReceipt: 'cell receipt', cellAssessment: 'cell assessment',
  stamp: 'a stamp beside the record', feed: 'stage bytes', reset: 'drop staged bytes', seal: 'seal the segment', continuation: 'continue after a seal',
};
const at = (w, i) => (i < w.length ? w[i] : 256);
/** The form a frame's bytes select, or null. Mirrors `Forms.formOf`. */
export function formOf(w) {
  switch (at(w, 0)) {
    case 0x00: return { 0x00: 'say', 0x01: 'remember', 0x02: 'correct', 0x06: 'advise', 0x05: 'report', 0x0d: 'spend', 0x10: 'read' }[at(w, 41)] ?? null;
    case 0x13: return { 0x03: 'approval', 0x09: 'retract', 0x0a: 'mandate', 0x0c: 'budget', 0x0e: 'pass', 0x0f: 'revoke' }[at(w, 3350)] ?? null;
    case 0x14: return 'legacyKeyChange'; case 0x15: return 'assessment'; case 0x16: return 'threshold'; case 0x17: return 'act';
    case 0x18: return 'timedApproval'; case 0x19: return 'cancel'; case 0x1a: return 'correction'; case 0x1b: return 'install';
    case 0xff: {
      const a = at(w, 1), b = at(w, 2);
      if (a === 0x02) {
        if (b === 0x29) return { 0x00: 'evidenceRead', 0x01: 'evidenceSource', 0x02: 'evidenceOutcome' }[at(w, 43)] ?? null;
        return { 0x28: 'evidenceAssessment', 0x2a: 'premise', 0x2b: 'ceiling', 0x32: 'halt', 0x33: 'clear', 0x34: 'refusedAct', 0x35: 'keyChange' }[b] ?? null;
      }
      if (a === 0x03) return { 0x01: 'cellReceipt', 0x02: 'cellAssessment' }[b] ?? null;
      return null;
    }
    default: return null;
  }
}
/** The form of an input on another channel. */
export const channelForm = op => ({ feed: 'feed', reset: 'reset', stamp: 'stamp', seal: 'seal', continueRecord: 'continuation' }[op] ?? null);
