# My mandate: working while the owner is away

**Status:** this page describes source behaviour. A scheduled wake step can spend a standing mandate only when a wish names it; with the owner's tab open, the owner's signed-in session stays the authority for everything. It has not been exercised against a live deployment (UNVERIFIED).

## What it is

One standing scope the owner gives me once, with his fingerprint, on the exact terms he reads on the card ("Let Auma work
while I am away"). It is the record my no-tab work will spend in a later step: every reversible thing I do inside it is
counted, and each count has a hard bound a day.

- He gives it on the Keys and trust card in Sovereignty, beside the night grant. One button asks his passkey for exactly
  the bytes he read; HEAD checks the approval inside the same write that stores the mandate, once.
- It lasts 1 day, 7 days (the default) or 30 days. Never longer than 30 days.
- One mandate at a time. A new one replaces the old one only through his own new fingerprint.
- He can stop it at any time with one click. Stopping needs no fingerprint, because it only takes authority away.
- Rules: `deploy/cloudflare/src/owner-mandate.mjs`. Storage and routes: `head-do.mjs` and `worker.mjs` (MANDATE1 blocks).
  The card: `packages/client/ui-layout/src/client/spatial/portal/MandateCell.tsx` and `aumlok/mandate.ts`. All three are
  frozen: my proposals cannot change them.

## What it can cover (a closed set)

`repo.read`, `repo.write.branch` (my own branches only), `exec.run`, `proposal.stage`, `linear.comment`, `relay.post`,
`model.call`. Any other word is refused when it is given (`MANDATE_SCOPE_UNKNOWN`).

## What it never covers

Merge, deploy, keys and secrets, deletes, domains, passkeys, promoting my head. These cannot even be written into a
mandate. Each stays one fingerprint each, every time.

## The day bounds (UTC day)

| Kind | Default | Hard ceiling |
|---|---|---|
| commits on my own branches | 24 | 48 |
| new branches | 8 | 16 |
| runner jobs | 24 | 48 |
| runner minutes | 240 | 600 |
| proposal cards | 12 | 24 |
| Linear comments | 24 | 48 |
| relay posts | 24 | 48 |

The count is kept in HEAD's own storage, not in memory, so a restart does not reset it. It starts again at UTC midnight.

## How one use is decided

`useOwnerMandate({ scope, kind, units, actionSha256 })` in HEAD, in ONE storage transaction: the mandate is there, not
expired, not stopped; the scope is granted; the kind belongs to that scope; today's count plus the units stays under the
bound. Then it writes one use receipt (`head:owner-mandate:use:<id>:<day>:<NNNN>`) and the new count together, or neither.
A runner job is ONE use: `useOwnerMandateExecJob({ minutes, actionSha256 })` checks both bounds (one of `execRuns`, `minutes`
of `execMinutes`) and writes both counts and one receipt in one transaction, or nothing; a refused job spends neither.
`repo.read` and `model.call` are not counted: `checkOwnerMandate({ scope })` only answers whether they are covered. For a
counted scope it always answers `MANDATE_USE_REQUIRED`, so it can never stand in for a use.

## Refusals (closed; a refusal writes nothing)

- `MANDATE_REQUIRED`: there is no mandate.
- `MANDATE_EXPIRED`: its end date has passed.
- `MANDATE_REVOKED`: the owner stopped it.
- `MANDATE_OUT_OF_SCOPE`: the scope is not granted, or the kind does not belong to it.
- `MANDATE_BOUND_REACHED` with `kind` and `retryAt` (the next UTC midnight): today's bound for that kind is spent.
- `MANDATE_USE_INVALID`: the units or the action hash are malformed.
- `MANDATE_STATE_INVALID` (503): today's stored count row, or the stored mandate record itself (any term field not well
  formed, for example `terms: {}`), is malformed. The caller must refuse the act; it is never treated as allowed, never
  counted from zero, and a malformed record is never read as active: state, use, runner-job use, check and read all
  answer this code, and `/_head/mandate` answers 503.
- `MANDATE_ID_MISMATCH`: a wake step named a different mandate than the one stored (the owner replaced it); nothing
  is spent. Make a new wish with the new mandate's id.
- `MANDATE_USE_REQUIRED` (from `checkOwnerMandate` only): the scope is counted; spend a use instead.

When it is given: `MANDATE_SCOPE_UNKNOWN`, `MANDATE_BOUND_REFUSED` (over a ceiling), `MANDATE_LIFETIME_REFUSED` (over 30
days), `MANDATE_EXPIRED`, `MANDATE_ISSUED_AT_REFUSED` (the card makes the terms at the tap, so this means the computer's clock is more than
10 minutes off HEAD's; the card says so in one line), `MANDATE_ID_REUSED`,
`MANDATE_TERMS_INVALID`, and `CLASS3_WEBAUTHN_REQUIRED` when the fingerprint did not approve these exact bytes.

## Who uses it now

My wake steps, and nothing else. Before each act a step calls `useOwnerMandate({ scope, kind, units: 1, actionSha256,
mandateId })` (or ONE `useOwnerMandateExecJob({ minutes, actionSha256, mandateId })` for a runner job) inside HEAD, under
the wake's own principal (`{ type: 'wake-mandate', mandateId }`), never a borrowed owner session. `mandateId` is the
wish's own: a use for another mandate is refused. A spent use is never refunded. After the act HEAD keeps an outcome row
beside the receipts (`head:wake-act-outcome:<id>:<day>:<NNNN>`); `GET /_head/mandate` also returns the newest 24
`outcomes`. The receipt format above is unchanged.
