struct Grant {
    let grantID, ownerKey, clientKey, receiverID: String
    let scope: Scope
    let notAfter: Int64
}

struct Scope {
    let action, resource: String
}

struct Authority {
    let ownerKey, receiverID: String
    let epoch: Int64
    let grants: Set<String>
}

struct Proposal {
    let opID, grant: String
    let action: Action
    let createdAt: Int64
}

struct Action {
    let name, resource, text: String
}

struct Approval {
    let proposal, receiverID: String
    let epoch: Int64
    let decision: String
    let notAfter: Int64
}

struct Outcome {
    let receiverID, opID, proposal: String
    let approval: String?
    let epoch: Int64
    let status, reason: String
    let effect: Effect?
    let seq: Int64
    let prev: String
    let at: Int64
}

struct Effect {
    let resource, beforeSHA256, afterSHA256: String
}

enum Payload {
    case grant(Grant)
    case authority(Authority)
    case proposal(Proposal)
    case approval(Approval)
    case outcome(Outcome)
    case note
}

private func isLower(_ byte: UInt8) -> Bool { (97...122).contains(byte) }
private func isDigit(_ byte: UInt8) -> Bool { (48...57).contains(byte) }
private func isHexDigit(_ byte: UInt8) -> Bool { isDigit(byte) || (97...102).contains(byte) }

func isHex64(_ value: String) -> Bool {
    value.utf8.count == 64 && value.utf8.allSatisfy(isHexDigit)
}

private func isHex32(_ value: String) -> Bool {
    value.utf8.count == 32 && value.utf8.allSatisfy(isHexDigit)
}

func isReceiverID(_ value: String) -> Bool {
    (1...64).contains(value.utf8.count) &&
        value.utf8.allSatisfy { isLower($0) || isDigit($0) || $0 == 45 }
}

private func isActionName(_ value: String) -> Bool {
    (1...32).contains(value.utf8.count) &&
        value.utf8.allSatisfy { isLower($0) || $0 == 95 }
}

private func isResource(_ value: String) -> Bool {
    (1...128).contains(value.utf8.count) &&
        value.utf8.allSatisfy { isLower($0) || isDigit($0) || (45...47).contains($0) || $0 == 95 }
}

private func isCode(_ value: String) -> Bool {
    (1...40).contains(value.utf8.count) &&
        value.utf8.allSatisfy { (65...90).contains($0) || $0 == 95 }
}

private func isText(_ value: String, maxBytes: Int) -> Bool {
    (1...maxBytes).contains(value.utf8.count) && value.utf8.allSatisfy { $0 >= 32 && $0 != 127 }
}

// C7 allows null only as the direct value of outcome.approval or outcome.effect.
private func checkLiterals(_ value: JSONValue, nullableOutcomeField: Bool = false) throws {
    switch value {
    case .bool:
        throw CheckError.invalid("BAD_JSON")
    case .null:
        guard nullableOutcomeField else { throw CheckError.invalid("BAD_JSON") }
    case .object(let fields):
        for nested in fields.values { try checkLiterals(nested) }
    case .array(let entries):
        for nested in entries { try checkLiterals(nested) }
    default:
        break
    }
}

private struct Fields {
    let values: [String: JSONValue]

    func require(_ names: Set<String>) throws {
        guard Set(values.keys) == names else { throw CheckError.invalid("BAD_SCHEMA") }
    }

    func string(_ key: String, _ matches: (String) -> Bool = { _ in true }) throws -> String {
        guard case .string(let text)? = values[key], matches(text) else {
            throw CheckError.invalid("BAD_SCHEMA")
        }
        return text
    }

    func int(_ key: String, min: Int64 = 0) throws -> Int64 {
        guard case .integer(let num)? = values[key], num >= min else {
            throw CheckError.invalid("BAD_SCHEMA")
        }
        return num
    }

    func object(_ key: String, fields names: Set<String>) throws -> Fields {
        guard case .object(let values)? = values[key] else { throw CheckError.invalid("BAD_SCHEMA") }
        let fields = Fields(values: values)
        try fields.require(names)
        return fields
    }

    func grantHashes() throws -> Set<String> {
        guard case .array(let entries)? = values["grants"], entries.count <= 64 else {
            throw CheckError.invalid("BAD_SCHEMA")
        }
        var hashes = Set<String>()
        for entry in entries {
            guard case .string(let hash) = entry, isHex64(hash), hashes.insert(hash).inserted else {
                throw CheckError.invalid("BAD_SCHEMA")
            }
        }
        return hashes
    }

    func outcomeApproval() throws -> String? {
        if case .null? = values["approval"] { return nil }
        return try string("approval", isHex64)
    }

    func outcomeEffect() throws -> Effect? {
        if case .null? = values["effect"] { return nil }
        let effect = try object("effect", fields: ["resource", "before_sha256", "after_sha256"])
        return try Effect(resource: effect.string("resource", isResource),
                          beforeSHA256: effect.string("before_sha256", isHex64),
                          afterSHA256: effect.string("after_sha256", isHex64))
    }
}

func readPayload(_ object: [String: JSONValue]) throws -> Payload {
    var isOutcome = false
    if case .string("outcome")? = object["type"] { isOutcome = true }
    for (key, value) in object {
        try checkLiterals(value, nullableOutcomeField: isOutcome && (key == "approval" || key == "effect"))
    }

    let fields = Fields(values: object)
    guard try fields.string("v") == "0.1" else { throw CheckError.invalid("BAD_SCHEMA") }
    switch try fields.string("type") {
    case "grant":
        try fields.require(["v", "type", "grant_id", "owner_key", "client_key", "receiver_id", "scope", "not_after"])
        let scope = try fields.object("scope", fields: ["action", "resource"])
        return try .grant(Grant(grantID: fields.string("grant_id", isHex32),
                                ownerKey: fields.string("owner_key", isHex64),
                                clientKey: fields.string("client_key", isHex64),
                                receiverID: fields.string("receiver_id", isReceiverID),
                                scope: Scope(action: scope.string("action", isActionName),
                                             resource: scope.string("resource", isResource)),
                                notAfter: fields.int("not_after")))
    case "authority":
        try fields.require(["v", "type", "owner_key", "receiver_id", "epoch", "grants"])
        return try .authority(Authority(ownerKey: fields.string("owner_key", isHex64),
                                        receiverID: fields.string("receiver_id", isReceiverID),
                                        epoch: fields.int("epoch", min: 1),
                                        grants: fields.grantHashes()))
    case "proposal":
        try fields.require(["v", "type", "op_id", "grant", "action", "created_at"])
        let action = try fields.object("action", fields: ["name", "resource", "text"])
        return try .proposal(Proposal(opID: fields.string("op_id", isHex32),
                                      grant: fields.string("grant", isHex64),
                                      action: Action(name: action.string("name", isActionName),
                                                     resource: action.string("resource", isResource),
                                                     text: action.string("text") { isText($0, maxBytes: 200) }),
                                      createdAt: fields.int("created_at")))
    case "approval":
        try fields.require(["v", "type", "proposal", "receiver_id", "epoch", "decision", "not_after"])
        return try .approval(Approval(proposal: fields.string("proposal", isHex64),
                                      receiverID: fields.string("receiver_id", isReceiverID),
                                      epoch: fields.int("epoch", min: 1),
                                      decision: fields.string("decision") { $0 == "approve" || $0 == "refuse" },
                                      notAfter: fields.int("not_after")))
    case "outcome":
        try fields.require(["v", "type", "receiver_id", "op_id", "proposal", "approval", "epoch",
                            "status", "reason", "effect", "seq", "prev", "at"])
        let status = try fields.string("status") { $0 == "DONE" || $0 == "REFUSED" }
        let reason = try fields.string("reason", isCode)
        guard status != "DONE" || reason == "OK" else { throw CheckError.invalid("BAD_SCHEMA") }
        return try .outcome(Outcome(receiverID: fields.string("receiver_id", isReceiverID),
                                    opID: fields.string("op_id", isHex32),
                                    proposal: fields.string("proposal", isHex64),
                                    approval: fields.outcomeApproval(),
                                    epoch: fields.int("epoch"), status: status, reason: reason,
                                    effect: fields.outcomeEffect(), seq: fields.int("seq", min: 1),
                                    prev: fields.string("prev", isHex64), at: fields.int("at")))
    case "note":
        try fields.require(["v", "type", "about", "label", "grants", "text"])
        _ = try fields.string("about", isHex64)
        _ = try fields.string("label") { $0 == "assessment" || $0 == "summary" }
        _ = try fields.string("grants") { $0 == "none" }
        _ = try fields.string("text") { isText($0, maxBytes: 1000) }
        return .note
    default:
        throw CheckError.invalid("BAD_SCHEMA")
    }
}
