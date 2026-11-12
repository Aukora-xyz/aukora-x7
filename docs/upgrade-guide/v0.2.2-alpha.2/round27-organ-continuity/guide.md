---
kind: upgrade-guide
description: "Organ reads accept bounded 256 KiB files, and receipt continuity remains distinct from unavailable signer policy."
---
# Organ reads and checkpoint continuity

English | [中文](guide.zh.md)

## Change

The body-map NORTH-STAR probe and allowlisted Cloudflare repository reads accept files up to 256 KiB rather than 64 KiB. Encoded read responses have separate bounded allowances; publication, general broker and private-path restrictions remain unchanged.

Receipt verification and ordinary append can continue through an unavailable authenticated checkpoint-policy reader after checkpoint 14. Hashes, signatures, signer checks, prefix links and Merkle roots still require verification. Successful verification reports `signerStatus: 'unanchored'`, `signerAnchored: false` and `checkpointPolicyError: 'CHECKPOINT_SIGNER_POLICY_UNAVAILABLE'`; this is chain consistency, not independent identity or owner consent. An append does not extend the signed checkpoint prefix.

Pearl targeted challenges require independently declared case authors and at least 24 trimmed characters of justification when candidate UTF-8 bytes grow more than 10% over the incumbent. These declarations do not authenticate authorship. Trial reads use the supplied VFS without fallback after failure. Changed inputs, restrictive ceilings and invalid or unsupported grant files refuse eligibility. No standing-grant verifier exists: `standingGrantEligible` stays false and `qualificationId` stays null. Without a grant, protected candidates may await host passkey review; `passkeyPromotionEligible` is not approval and `authorityVerified` stays false. Direct runtime admission is unchanged; these wrapper checks are not an unavoidable isolation boundary. Verdicts distinguish candidate wins (`retention-passes`), baseline wins (`baseline-retained`) and observed ties or incomplete comparisons (`inconclusive`); labels grant no authority.

Pearl now returns `PEARL_ARENA_UNAVAILABLE` without a verdict or receipt when either arm is missing, reports zero `total` or `totalCases`, lacks nonempty result arrays or fails grader controls. `unavailableArms` identifies affected arms; `trialErrors` exposes known codes or `TRIAL_ERROR_REDACTED`. Observed zero passes remain numeric outcomes; nonempty malformed rows retain `PEARL_COMPARISON_INCOMPLETE`.

## Migration

1. Keep decoded repository files at or below `256 * 1024` bytes and preserve existing path admission. Larger files still fail; this change does not enable private-file reads or larger publications.
2. Handle `checkpointPolicyError` separately from receipt integrity. Preserve receipts during a policy outage; do not convert an unanchored result into verified memory, an owner grant or permission to promote a head.
3. Restore the authenticated policy reader before requesting checkpoint 15 or later. Checkpoint creation remains refused without policy; malformed, expired, mismatched and unsupported hybrid policies remain refusals. No production signer or policy is created by this change.
4. Supply `candidateAuthor` distinct from every retained target case's `author`, and `sizeGrowthJustification` when growth exceeds 10%. Historical cases without author declarations now refuse targeted challenges; obtain reviewed case metadata rather than inventing authors or modifying the live suite automatically. Missing grant files do not authorize unattended changes. The host must separately verify owner approval before promotion. Handle `baseline-retained` as a baseline win, not candidate qualification; preserve historical receipts. Handle `PEARL_ARENA_UNAVAILABLE` as unavailable evidence, never a numeric tie.
5. Verify bounded reads, oversized-file refusal, unanchored append continuity, corrupt-chain refusal and unavailable-policy checkpoint refusal before deployment. Source tests do not establish which code a running browser has loaded.
