/**
 * THE ONE LIST of tools whose successful results the cloud wake may record as checkpoint evidence (an independent
 * review). HEAD's wake (head-do.mjs `executeCloudWakeStep`) records evidence from these tools and MIRROR's
 * checkpoint append (mirror-do.mjs `appendMirrorWakeCheckpoint`) accepts exactly these names; both read this list, so a
 * new wake tool cannot be recorded by one and refused by the other. `appendWakeCheckpoint` itself is never evidence.
 * @module wake-evidence
 */
export const CLOUD_WAKE_EVIDENCE_TOOLS = Object.freeze(['readMirrorText', 'inspectHeadWish', 'readRepoFile', 'searchRepository', 'recentCommits'])
