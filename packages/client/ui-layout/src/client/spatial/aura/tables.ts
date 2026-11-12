// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * GENERATED, then trimmed once by hand (see the end of this note); do not edit otherwise. The Pentora figure's fixed
 * tables, generated from the Pentora and canon sources, which are not part of this repository.
 * Organ i owns cube i; a cube's 18 private cells (12 edge midpoints, 6 face centres) are its private checks in
 * ascending global-index order; its 8 corners are shared, each with one other organ. Coordinates are a+b*phi over sqrt(3),
 * rounded to 1e-6 (display only). The geometry table says of itself: "PROPOSED geometry adapter; NOT M1-approved".
 * One generated table was removed by hand: CHECKS, the registry text of the 90 private checks, which only the
 * health map (now gone, never fed here) listed. A fresh generation would bring it back with nothing reading it.
 */

/** Global cell index -> [x, y, z]; 111 points, 55 is the centre (no cell). */
export const POINTS: Readonly<Record<number, readonly [number, number, number]>> = {
  0: [-0.934172, 0.0, -0.356822],
  1: [-0.934172, 0.0, 0.356822],
  2: [-0.755761, -0.288675, -0.110264],
  3: [-0.755761, -0.288675, 0.110264],
  4: [-0.755761, 0.288675, -0.110264],
  5: [-0.755761, 0.288675, 0.110264],
  6: [-0.645497, -0.467086, -0.178411],
  7: [-0.645497, -0.467086, 0.178411],
  8: [-0.645497, 0.467086, -0.178411],
  9: [-0.645497, 0.467086, 0.178411],
  10: [-0.57735, -0.57735, -0.57735],
  11: [-0.57735, -0.57735, 0.0],
  12: [-0.57735, -0.57735, 0.57735],
  13: [-0.57735, 0.0, -0.57735],
  14: [-0.57735, 0.0, 0.0],
  15: [-0.57735, 0.0, 0.57735],
  16: [-0.57735, 0.57735, -0.57735],
  17: [-0.57735, 0.57735, 0.0],
  18: [-0.57735, 0.57735, 0.57735],
  19: [-0.467086, -0.178411, -0.645497],
  20: [-0.467086, -0.178411, -0.288675],
  21: [-0.467086, -0.178411, 0.288675],
  22: [-0.467086, -0.178411, 0.645497],
  23: [-0.467086, 0.178411, -0.645497],
  24: [-0.467086, 0.178411, -0.288675],
  25: [-0.467086, 0.178411, 0.288675],
  26: [-0.467086, 0.178411, 0.645497],
  27: [-0.356822, -0.934172, 0.0],
  28: [-0.356822, 0.934172, 0.0],
  29: [-0.288675, -0.467086, -0.178411],
  30: [-0.288675, -0.467086, 0.178411],
  31: [-0.288675, -0.110264, -0.755761],
  32: [-0.288675, -0.110264, 0.755761],
  33: [-0.288675, 0.110264, -0.755761],
  34: [-0.288675, 0.110264, 0.755761],
  35: [-0.288675, 0.467086, -0.178411],
  36: [-0.288675, 0.467086, 0.178411],
  37: [-0.178411, -0.645497, -0.467086],
  38: [-0.178411, -0.645497, 0.467086],
  39: [-0.178411, -0.288675, -0.467086],
  40: [-0.178411, -0.288675, 0.467086],
  41: [-0.178411, 0.288675, -0.467086],
  42: [-0.178411, 0.288675, 0.467086],
  43: [-0.178411, 0.645497, -0.467086],
  44: [-0.178411, 0.645497, 0.467086],
  45: [-0.110264, -0.755761, -0.288675],
  46: [-0.110264, -0.755761, 0.288675],
  47: [-0.110264, 0.755761, -0.288675],
  48: [-0.110264, 0.755761, 0.288675],
  49: [0.0, -0.57735, -0.57735],
  50: [0.0, -0.57735, 0.0],
  51: [0.0, -0.57735, 0.57735],
  52: [0.0, -0.356822, -0.934172],
  53: [0.0, -0.356822, 0.934172],
  54: [0.0, 0.0, -0.57735],
  55: [0.0, 0.0, 0.0],
  56: [0.0, 0.0, 0.57735],
  57: [0.0, 0.356822, -0.934172],
  58: [0.0, 0.356822, 0.934172],
  59: [0.0, 0.57735, -0.57735],
  60: [0.0, 0.57735, 0.0],
  61: [0.0, 0.57735, 0.57735],
  62: [0.110264, -0.755761, -0.288675],
  63: [0.110264, -0.755761, 0.288675],
  64: [0.110264, 0.755761, -0.288675],
  65: [0.110264, 0.755761, 0.288675],
  66: [0.178411, -0.645497, -0.467086],
  67: [0.178411, -0.645497, 0.467086],
  68: [0.178411, -0.288675, -0.467086],
  69: [0.178411, -0.288675, 0.467086],
  70: [0.178411, 0.288675, -0.467086],
  71: [0.178411, 0.288675, 0.467086],
  72: [0.178411, 0.645497, -0.467086],
  73: [0.178411, 0.645497, 0.467086],
  74: [0.288675, -0.467086, -0.178411],
  75: [0.288675, -0.467086, 0.178411],
  76: [0.288675, -0.110264, -0.755761],
  77: [0.288675, -0.110264, 0.755761],
  78: [0.288675, 0.110264, -0.755761],
  79: [0.288675, 0.110264, 0.755761],
  80: [0.288675, 0.467086, -0.178411],
  81: [0.288675, 0.467086, 0.178411],
  82: [0.356822, -0.934172, 0.0],
  83: [0.356822, 0.934172, 0.0],
  84: [0.467086, -0.178411, -0.645497],
  85: [0.467086, -0.178411, -0.288675],
  86: [0.467086, -0.178411, 0.288675],
  87: [0.467086, -0.178411, 0.645497],
  88: [0.467086, 0.178411, -0.645497],
  89: [0.467086, 0.178411, -0.288675],
  90: [0.467086, 0.178411, 0.288675],
  91: [0.467086, 0.178411, 0.645497],
  92: [0.57735, -0.57735, -0.57735],
  93: [0.57735, -0.57735, 0.0],
  94: [0.57735, -0.57735, 0.57735],
  95: [0.57735, 0.0, -0.57735],
  96: [0.57735, 0.0, 0.0],
  97: [0.57735, 0.0, 0.57735],
  98: [0.57735, 0.57735, -0.57735],
  99: [0.57735, 0.57735, 0.0],
  100: [0.57735, 0.57735, 0.57735],
  101: [0.645497, -0.467086, -0.178411],
  102: [0.645497, -0.467086, 0.178411],
  103: [0.645497, 0.467086, -0.178411],
  104: [0.645497, 0.467086, 0.178411],
  105: [0.755761, -0.288675, -0.110264],
  106: [0.755761, -0.288675, 0.110264],
  107: [0.755761, 0.288675, -0.110264],
  108: [0.755761, 0.288675, 0.110264],
  109: [0.934172, 0.0, -0.356822],
  110: [0.934172, 0.0, 0.356822],
}

/** One cube of the compound: its edges, their midpoints, its face centres, and its 18 private cells. */
export interface PentoraCube {
  readonly edges: readonly (readonly [number, number])[]
  readonly edgeMidpoints: readonly number[]
  readonly faceCentres: readonly number[]
  readonly private: readonly number[]
  readonly corners: readonly number[]
}

/** The five cubes, organ order (aumlok, gate-aura, kira, network, body). */
export const CUBES: readonly PentoraCube[] = [
  {
    edges: [[10, 12], [10, 16], [10, 92], [12, 18], [12, 94], [16, 18], [16, 98], [18, 100], [92, 94], [92, 98], [94, 100], [98, 100]],
    edgeMidpoints: [11, 13, 49, 15, 51, 17, 59, 61, 93, 95, 97, 99],
    faceCentres: [14, 50, 54, 56, 60, 96],
    private: [11, 13, 14, 15, 17, 49, 50, 51, 54, 56, 59, 60, 61, 93, 95, 96, 97, 99],
    corners: [10, 12, 16, 18, 92, 94, 98, 100],
  },
  {
    edges: [[10, 57], [10, 1], [10, 82], [100, 53], [100, 109], [100, 28], [53, 1], [53, 82], [57, 109], [57, 28], [109, 82], [1, 28]],
    edgeMidpoints: [31, 2, 45, 79, 108, 65, 22, 67, 88, 43, 101, 9],
    faceCentres: [24, 30, 42, 68, 80, 86],
    private: [2, 9, 22, 24, 30, 31, 42, 43, 45, 65, 67, 68, 79, 80, 86, 88, 101, 108],
    corners: [1, 10, 28, 53, 57, 82, 100, 109],
  },
  {
    edges: [[12, 58], [12, 0], [12, 82], [98, 52], [98, 110], [98, 28], [52, 0], [52, 82], [58, 110], [58, 28], [0, 28], [110, 82]],
    edgeMidpoints: [32, 3, 46, 78, 107, 64, 19, 66, 91, 44, 8, 102],
    faceCentres: [25, 29, 41, 69, 81, 85],
    private: [3, 8, 19, 25, 29, 32, 41, 44, 46, 64, 66, 69, 78, 81, 85, 91, 102, 107],
    corners: [0, 12, 28, 52, 58, 82, 98, 110],
  },
  {
    edges: [[16, 52], [16, 1], [16, 83], [94, 58], [94, 109], [94, 27], [52, 109], [52, 27], [58, 1], [58, 83], [109, 83], [1, 27]],
    edgeMidpoints: [33, 4, 47, 77, 106, 63, 84, 37, 26, 73, 103, 7],
    faceCentres: [20, 36, 40, 70, 74, 90],
    private: [4, 7, 20, 26, 33, 36, 37, 40, 47, 63, 70, 73, 74, 77, 84, 90, 103, 106],
    corners: [1, 16, 27, 52, 58, 83, 94, 109],
  },
  {
    edges: [[18, 53], [18, 0], [18, 83], [92, 57], [92, 110], [92, 27], [53, 110], [53, 27], [57, 0], [57, 83], [0, 27], [110, 83]],
    edgeMidpoints: [34, 5, 48, 76, 105, 62, 87, 38, 23, 72, 6, 104],
    faceCentres: [21, 35, 39, 71, 75, 89],
    private: [5, 6, 21, 23, 34, 35, 38, 39, 48, 62, 71, 72, 75, 76, 87, 89, 104, 105],
    corners: [0, 18, 27, 53, 57, 83, 92, 110],
  },
]

/** Corner k (1..20) sits at this global cell. */
export const CORNER_CELLS: readonly number[] = [10, 100, 12, 98, 16, 94, 18, 92, 28, 82, 1, 109, 53, 57, 52, 58, 0, 110, 27, 83]

export type OrganWire = 'aumlok' | 'gate-aura' | 'kira' | 'network' | 'body'

/** One canon corner: two organs that must agree on one fact. */
export interface PentoraCorner {
  readonly index: number
  readonly pair: string
  readonly owners: readonly [OrganWire, OrganWire]
  readonly invariant: string
  readonly sources: readonly [string, string]
  readonly freshness_ms: number
}

/** canon CORNERS: 20, two per organ pair. */
export const CORNERS: readonly PentoraCorner[] = [
  {
    index: 1, pair: 'AUMLOK × Gate & Aura', owners: ['aumlok', 'gate-aura'],
    invariant: 'The owner credential epoch in AUMLOK equals the epoch Aura recorded',
    sources: ['aumlok.credential-epoch', 'aura.owner-epoch'], freshness_ms: 5000,
  },
  {
    index: 2, pair: 'AUMLOK × Gate & Aura', owners: ['aumlok', 'gate-aura'],
    invariant: 'Every passkey AUMLOK accepts has its enrolment in Aura',
    sources: ['aumlok.credential-bindings', 'aura.enrolment-rows'], freshness_ms: 5000,
  },
  {
    index: 3, pair: 'AUMLOK × Kira', owners: ['aumlok', 'kira'],
    invariant: "Kira's key is wrapped under AUMLOK's current root epoch",
    sources: ['aumlok.root-epoch', 'kira.key-envelope'], freshness_ms: 30000,
  },
  {
    index: 4, pair: 'AUMLOK × Kira', owners: ['aumlok', 'kira'],
    invariant: 'Every Kira permission change carries an owner signature AUMLOK verifies',
    sources: ['aumlok.permission-signatures', 'kira.permission-records'], freshness_ms: 5000,
  },
  {
    index: 5, pair: 'AUMLOK × Network', owners: ['aumlok', 'network'],
    invariant: 'The node and agent Nostr keys are the ones AUMLOK delegated',
    sources: ['aumlok.nostr-delegations', 'network.active-identities'], freshness_ms: 30000,
  },
  {
    index: 6, pair: 'AUMLOK × Network', owners: ['aumlok', 'network'],
    invariant: 'Every approved contact and paired device carries an approval AUMLOK verifies',
    sources: ['aumlok.relationship-signatures', 'network.relationship-bindings'], freshness_ms: 5000,
  },
  {
    index: 7, pair: 'AUMLOK × Body', owners: ['aumlok', 'body'],
    invariant: "The frontdoor's relying party and accepted top origin equal AUMLOK's enrolment",
    sources: ['aumlok.enrolled-origins', 'body.frontdoor-origins'], freshness_ms: 5000,
  },
  {
    index: 8, pair: 'AUMLOK × Body', owners: ['aumlok', 'body'],
    invariant: "The frontdoor's unlock limits match AUMLOK's per-principal counters",
    sources: ['aumlok.unlock-counters', 'body.frontdoor-unlock-limits'], freshness_ms: 5000,
  },
  {
    index: 9, pair: 'Gate & Aura × Kira', owners: ['gate-aura', 'kira'],
    invariant: "Kira's verified head is anchored in Aura",
    sources: ['aura.kira-anchor', 'kira.chain-head'], freshness_ms: 5000,
  },
  {
    index: 10, pair: 'Gate & Aura × Kira', owners: ['gate-aura', 'kira'],
    invariant: "Kira's demotion and quarantine counts agree with Aura",
    sources: ['aura.kira-action-counts', 'kira.demotion-quarantine-counts'], freshness_ms: 5000,
  },
  {
    index: 11, pair: 'Gate & Aura × Network', owners: ['gate-aura', 'network'],
    invariant: 'The latest head witness on the relays equals the local head',
    sources: ['aura.chain-head', 'network.head-witnesses'], freshness_ms: 60000,
  },
  {
    index: 12, pair: 'Gate & Aura × Network', owners: ['gate-aura', 'network'],
    invariant: 'Every contact and send has its consumed card in Aura',
    sources: ['aura.relationship-consumptions', 'network.contact-send-receipts'], freshness_ms: 5000,
  },
  {
    index: 13, pair: 'Gate & Aura × Body', owners: ['gate-aura', 'body'],
    invariant: "The running binary's digest equals the approved release",
    sources: ['aura.approved-release', 'body.running-release'], freshness_ms: 5000,
  },
  {
    index: 14, pair: 'Gate & Aura × Body', owners: ['gate-aura', 'body'],
    invariant: 'The antibody corpus root equals the release fact',
    sources: ['aura.release-corpus-fact', 'body.antibody-root'], freshness_ms: 30000,
  },
  {
    index: 15, pair: 'Kira × Network', owners: ['kira', 'network'],
    invariant: "The memory backup's commitment on the relays equals Kira's head (0 until backups exist)",
    sources: ['kira.backup-head', 'network.memory-backup-commitment'], freshness_ms: 60000,
  },
  {
    index: 16, pair: 'Kira × Network', owners: ['kira', 'network'],
    invariant: 'Every memory disclosed in a message has a Kira permission',
    sources: ['kira.disclosure-permissions', 'network.memory-disclosures'], freshness_ms: 5000,
  },
  {
    index: 17, pair: 'Kira × Body', owners: ['kira', 'body'],
    invariant: "The OpenViking index pin matches Kira's head",
    sources: ['kira.chain-head', 'body.openviking-index-pin'], freshness_ms: 5000,
  },
  {
    index: 18, pair: 'Kira × Body', owners: ['kira', 'body'],
    invariant: "The guest's memory calls on FD 3 match Kira's recall receipts",
    sources: ['kira.recall-receipts', 'body.fd3-memory-calls'], freshness_ms: 5000,
  },
  {
    index: 19, pair: 'Network × Body', owners: ['network', 'body'],
    invariant: "The host's egress allowlist equals the relay set Network uses",
    sources: ['network.relay-set', 'body.egress-allowlist'], freshness_ms: 30000,
  },
  {
    index: 20, pair: 'Network × Body', owners: ['network', 'body'],
    invariant: "The node's address and TLS identity match what Network publishes",
    sources: ['network.published-address', 'body.address-tls-identity'], freshness_ms: 30000,
  },
]
