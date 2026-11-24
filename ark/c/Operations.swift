private struct SignedProposal {
    let proposal: Proposal
    var signerIDs: Set<String> = []
}

private struct OperationIndex {
    var ids: Set<String> = []
    var outcomes: [String: [String: Outcome]] = [:] // op_id, then item hash
    var proposals: [String: SignedProposal] = [:]
    var grants: [String: Grant] = [:]
    var approvals: [String: Approval] = [:]
    var authorizedGrants: [Int64: Set<String>] = [:]

    init(_ items: [SignedItem], pins: Pins) {
        for item in items {
            switch item.payload {
            case .grant(let grant):
                grants[item.hash] = grant
            case .authority(let authority):
                if authority.receiverID == pins.receiverID && authority.ownerKey == pins.ownerKey {
                    authorizedGrants[authority.epoch, default: []].formUnion(authority.grants)
                }
            case .proposal(let proposal):
                ids.insert(proposal.opID)
                proposals[item.hash, default: SignedProposal(proposal: proposal)].signerIDs.insert(item.keyID)
            case .approval(let approval):
                approvals[item.hash] = approval
            case .outcome(let outcome):
                ids.insert(outcome.opID)
                outcomes[outcome.opID, default: [:]][item.hash] = outcome
            case .note:
                break
            }
        }
    }

    func verdict(for id: String, pins: Pins) -> String {
        guard let records = outcomes[id], let outcome = records.values.first else { return "UNKNOWN" }
        guard records.count == 1 else { return "INVALID CONFLICTING_OUTCOMES" }
        guard outcome.receiverID == pins.receiverID else { return "INVALID WRONG_RECEIVER" }
        guard let signedProposal = proposals[outcome.proposal], signedProposal.proposal.opID == id else {
            return "INVALID PROPOSAL_MISSING"
        }
        if outcome.status == "REFUSED" {
            guard outcome.effect == nil else { return "INVALID BAD_OUTCOME" }
            return "REFUSED"
        }
        guard let effect = outcome.effect else { return "INVALID BAD_OUTCOME" }

        // Sections D1–D14 are ordered. Compare expiry with the signed decision time.
        guard let approvalHash = outcome.approval, let approval = approvals[approvalHash] else {
            return "INVALID NO_APPROVAL"
        }
        guard approval.decision == "approve" else { return "INVALID APPROVAL_NOT_APPROVE" }
        guard approval.proposal == outcome.proposal else { return "INVALID APPROVAL_MISMATCH" }
        guard approval.receiverID == pins.receiverID else { return "INVALID WRONG_RECEIVER" }
        guard approval.epoch == outcome.epoch else { return "INVALID STALE_EPOCH" }
        guard approval.notAfter >= outcome.at else { return "INVALID APPROVAL_EXPIRED" }

        let proposal = signedProposal.proposal
        guard let grant = grants[proposal.grant] else { return "INVALID GRANT_MISSING" }
        guard grant.ownerKey == pins.ownerKey else { return "INVALID WRONG_OWNER" }
        guard grant.receiverID == pins.receiverID else { return "INVALID WRONG_RECEIVER" }
        guard signedProposal.signerIDs.contains(keyID(of: grant.clientKey)) else { return "INVALID WRONG_CLIENT" }
        guard grant.scope.action == proposal.action.name, grant.scope.resource == proposal.action.resource else {
            return "INVALID SCOPE_MISMATCH"
        }
        guard grant.notAfter >= outcome.at else { return "INVALID GRANT_EXPIRED" }
        guard authorizedGrants[outcome.epoch]?.contains(proposal.grant) == true else {
            return "INVALID GRANT_NOT_IN_AUTHORITY"
        }
        guard effect.resource == proposal.action.resource else { return "INVALID EFFECT_MISMATCH" }
        return "DONE"
    }
}

func operationVerdicts(_ items: [SignedItem], pins: Pins) -> [(id: String, verdict: String)] {
    let index = OperationIndex(items, pins: pins)
    return index.ids.sorted().map { ($0, index.verdict(for: $0, pins: pins)) }
}
