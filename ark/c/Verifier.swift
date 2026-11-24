import CryptoKit
import Foundation

enum CheckError: Error {
    case invalid(String)
}

private let payloadType = "application/vnd.aukora.ark.v0.1+json"

private func digestHex(_ data: Data) -> String {
    let alphabet = Array("0123456789abcdef".utf8)
    var result = [UInt8]()
    result.reserveCapacity(64)
    for byte in SHA256.hash(data: data) {
        result.append(alphabet[Int(byte >> 4)])
        result.append(alphabet[Int(byte & 15)])
    }
    return String(decoding: result, as: UTF8.self)
}

// Only called with already schema-checked, lowercase hex64 public keys.
private func rawKey(_ hexKey: String) -> Data {
    var data = Data(capacity: 32)
    var high: UInt8?
    for byte in hexKey.utf8 {
        let nibble = byte <= 57 ? byte - 48 : byte - 87
        if let highNibble = high {
            data.append((highNibble << 4) | nibble)
            high = nil
        } else {
            high = nibble
        }
    }
    return data
}

func keyID(of hexKey: String) -> String {
    digestHex(rawKey(hexKey))
}

private func decodeBase64URL(_ text: String) throws -> Data {
    let length = text.utf8.count
    guard length % 4 != 1, text.utf8.allSatisfy({
        (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0)
            || $0 == 45 || $0 == 95
    }) else { throw CheckError.invalid("BAD_ENCODING") }

    let standard = text.replacingOccurrences(of: "-", with: "+")
        .replacingOccurrences(of: "_", with: "/")
    let padded = standard + String(repeating: "=", count: (4 - length % 4) % 4)
    guard let data = Data(base64Encoded: padded), data.base64EncodedString() == padded else {
        throw CheckError.invalid("BAD_ENCODING")
    }
    return data
}

struct Pins {
    let ownerKey: String
    let receiverKey: String
    let receiverID: String
    let suppliedBy: String

    init?(_ data: Data) {
        guard let object = try? parseJSON(data), object.count == 5,
              case .string("0.1") = object["v"],
              case let .string(owner) = object["owner_key"], isHex64(owner),
              case let .string(receiver) = object["receiver_key"], isHex64(receiver),
              owner != receiver,
              case let .string(rid) = object["receiver_id"], isReceiverID(rid),
              case let .string(source) = object["supplied_by"], (1...200).contains(source.utf8.count)
        else { return nil }
        ownerKey = owner
        receiverKey = receiver
        receiverID = rid
        suppliedBy = source
    }
}

struct BundleFile {
    let coverage: String
    let items: [JSONValue]

    init?(_ data: Data) {
        guard let object = try? parseJSON(data), object.count == 3,
              case .string("0.1") = object["v"],
              case let .string(sentence) = object["coverage"], (1...500).contains(sentence.utf8.count),
              case let .array(items) = object["items"], (1...10000).contains(items.count)
        else { return nil }
        self.coverage = sentence
        self.items = items
    }
}

struct SignedItem {
    let hash: String
    let keyID: String
    let payload: Payload
}

private struct Envelope {
    let item: SignedItem
    let signature: Data
    let bytes: Data

    init(_ value: JSONValue) throws {
        guard case let .object(object) = value, object.count == 3,
              case let .string(type) = object["payloadType"],
              case let .string(encoded) = object["payload"],
              case let .array(signatures) = object["signatures"], signatures.count == 1,
              case let .object(signer) = signatures[0], signer.count == 2,
              case let .string(keyID) = signer["keyid"], isHex64(keyID),
              case let .string(encodedSignature) = signer["sig"]
        else { throw CheckError.invalid("BAD_ENVELOPE") }
        guard type == payloadType else { throw CheckError.invalid("BAD_PAYLOAD_TYPE") }

        signature = try decodeBase64URL(encodedSignature)
        guard signature.count == 64 else { throw CheckError.invalid("BAD_ENCODING") }
        bytes = try decodeBase64URL(encoded)
        guard bytes.count <= 65536 else { throw CheckError.invalid("BAD_SCHEMA") }
        guard let fields = try? parseJSON(bytes) else { throw CheckError.invalid("BAD_JSON") }
        let payload = try readPayload(fields)
        item = SignedItem(hash: digestHex(bytes), keyID: keyID, payload: payload)
    }

    func verify(key: String, role: SignerRole) throws {
        var pae = Data("DSSEv1 \(payloadType.utf8.count) \(payloadType) \(bytes.count) ".utf8)
        pae.append(bytes)
        guard let publicKey = try? Curve25519.Signing.PublicKey(rawRepresentation: rawKey(key)),
              publicKey.isValidSignature(signature, for: pae)
        else { throw CheckError.invalid("BAD_SIGNATURE") }

        switch (role, item.payload) {
        case (_, .note), (.owner, .grant), (.owner, .authority), (.owner, .approval),
             (.receiver, .outcome), (.client, .proposal):
            return
        default:
            throw CheckError.invalid("WRONG_SIGNER")
        }
    }
}

private enum SignerRole {
    case owner, receiver, client
}

enum BundleCheck {
    case ok([SignedItem])
    case invalid(reason: String, index: Int)
    case untrusted(index: Int)
}

func checkItems(_ values: [JSONValue], pins: Pins) throws -> BundleCheck {
    let ownerID = keyID(of: pins.ownerKey)
    let receiverID = keyID(of: pins.receiverKey)
    var verified = [SignedItem]()
    var clients = [String: String]()
    var pending = [(Int, Envelope)]()
    var firstInvalid: (reason: String, index: Int)?
    var firstUntrusted: Int?

    // E1–E5 and S1 depend only on the pins and this envelope.
    for (index, value) in values.enumerated() {
        do {
            let envelope = try Envelope(value)
            let item = envelope.item
            switch item.keyID {
            case ownerID:
                try envelope.verify(key: pins.ownerKey, role: .owner)
                if case let .grant(grant) = item.payload {
                    clients[keyID(of: grant.clientKey)] = grant.clientKey
                }
            case receiverID:
                try envelope.verify(key: pins.receiverKey, role: .receiver)
            default:
                pending.append((index, envelope))
                continue
            }
            verified.append(item)
        } catch let CheckError.invalid(reason) {
            if firstInvalid == nil { firstInvalid = (reason, index) }
        }
    }

    // S2/S3 see every owner-signed grant, including ones after this item.
    for (index, envelope) in pending {
        let item = envelope.item
        if let clientKey = clients[item.keyID] {
            do {
                try envelope.verify(key: clientKey, role: .client)
                verified.append(item)
            } catch let CheckError.invalid(reason) {
                if firstInvalid == nil || index < firstInvalid!.index {
                    firstInvalid = (reason, index)
                }
            }
        } else if case .note = item.payload {
            continue // S3. An unresolved note is OK and can never affect an op.
        } else if firstUntrusted == nil {
            firstUntrusted = index
        }
    }
    if let failure = firstInvalid { return .invalid(reason: failure.reason, index: failure.index) }
    if let index = firstUntrusted { return .untrusted(index: index) }
    return .ok(verified)
}
