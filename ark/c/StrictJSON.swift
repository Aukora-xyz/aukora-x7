import Foundation

enum JSONValue {
    case object([String: JSONValue])
    case array([JSONValue])
    case string(String)
    case integer(Int64)
    case null
    case bool(Bool)
}

private enum JSONError: Error {
    case invalid
}

func parseJSON(_ data: Data) throws -> [String: JSONValue] {
    var reader = JSONReader(bytes: Array(data))
    return try reader.document()
}

private struct JSONReader {
    let bytes: [UInt8]
    var position = 0

    mutating func document() throws -> [String: JSONValue] {
        // The grammar accepts no BOM. Only JSON whitespace may surround the object.
        guard case .object(let fields) = try readValue(depth: 0) else {
            throw JSONError.invalid
        }
        skipWhitespace()
        guard position == bytes.count else { throw JSONError.invalid }
        return fields
    }

    private mutating func skipWhitespace() {
        while position < bytes.count {
            switch bytes[position] {
            case 0x20, 0x09, 0x0a, 0x0d: position += 1
            default: return
            }
        }
    }

    private mutating func consume(_ byte: UInt8) -> Bool {
        guard position < bytes.count, bytes[position] == byte else { return false }
        position += 1
        return true
    }

    private mutating func literal(_ word: String) throws {
        guard bytes[position...].starts(with: word.utf8) else { throw JSONError.invalid }
        position += word.utf8.count
    }

    private mutating func readValue(depth: Int) throws -> JSONValue {
        skipWhitespace()
        guard position < bytes.count else { throw JSONError.invalid }
        switch bytes[position] {
        case 0x7b: // {
            guard depth < 8 else { throw JSONError.invalid }
            position += 1
            return try readObject(depth: depth + 1)
        case 0x5b: // [
            guard depth < 8 else { throw JSONError.invalid }
            position += 1
            return try readArray(depth: depth + 1)
        case 0x22: return .string(try readString())
        case 0x30...0x39: return .integer(try readInteger())
        case 0x74:
            try literal("true")
            return .bool(true)
        case 0x66:
            try literal("false")
            return .bool(false)
        case 0x6e:
            try literal("null")
            return .null
        default: throw JSONError.invalid
        }
    }

    private mutating func readObject(depth: Int) throws -> JSONValue {
        var fields: [String: JSONValue] = [:]
        skipWhitespace()
        if consume(0x7d) { return .object(fields) }
        while true {
            let name = try readString()
            // Swift String equality normalizes Unicode. JSON names compare by
            // decoded code units. All schema names are ASCII, so give every
            // non-ASCII name a distinct internal key outside that namespace.
            let key = name.utf8.allSatisfy { $0 < 0x80 }
                ? name : "\u{80}" + Data(name.utf8).base64EncodedString()
            guard fields[key] == nil else { throw JSONError.invalid }
            skipWhitespace()
            guard consume(0x3a) else { throw JSONError.invalid } // :
            fields[key] = try readValue(depth: depth)
            skipWhitespace()
            if consume(0x7d) { return .object(fields) }
            guard consume(0x2c) else { throw JSONError.invalid } // ,
            skipWhitespace()
        }
    }

    private mutating func readArray(depth: Int) throws -> JSONValue {
        var elements: [JSONValue] = []
        skipWhitespace()
        if consume(0x5d) { return .array(elements) }
        while true {
            elements.append(try readValue(depth: depth))
            skipWhitespace()
            if consume(0x5d) { return .array(elements) }
            guard consume(0x2c) else { throw JSONError.invalid }
        }
    }

    private mutating func readInteger() throws -> Int64 {
        if consume(0x30) { return 0 } // A following digit cannot start another token here.
        var number: Int64 = 0
        while position < bytes.count, (0x30...0x39).contains(bytes[position]) {
            number = number * 10 + Int64(bytes[position] - 0x30)
            guard number <= 9_007_199_254_740_991 else { throw JSONError.invalid }
            position += 1
        }
        return number
    }

    private func decodeString(_ utf8: ArraySlice<UInt8>) throws -> String {
        let value = String(decoding: utf8, as: UTF8.self)
        // A repaired UTF-8 sequence cannot round-trip. A literal U+FFFD can.
        guard value.utf8.elementsEqual(utf8) else { throw JSONError.invalid }
        return value
    }

    private mutating func readString() throws -> String {
        guard consume(0x22) else { throw JSONError.invalid }
        var rawStart = position
        var decoded: [UInt8] = []
        while position < bytes.count {
            let index = position
            let byte = bytes[index]
            position += 1
            switch byte {
            case 0x00...0x1f:
                throw JSONError.invalid
            case 0x22: // "
                if decoded.isEmpty { return try decodeString(bytes[rawStart..<index]) }
                decoded.append(contentsOf: bytes[rawStart..<index])
                return try decodeString(decoded[...])
            case 0x5c: // backslash
                decoded.append(contentsOf: bytes[rawStart..<index])
                try appendEscape(to: &decoded)
                rawStart = position
            default: continue
            }
        }
        throw JSONError.invalid
    }

    private mutating func appendEscape(to decoded: inout [UInt8]) throws {
        guard position < bytes.count else { throw JSONError.invalid }
        let escaped = bytes[position]
        position += 1
        switch escaped {
        case 0x22, 0x5c, 0x2f: decoded.append(escaped)
        case 0x62: decoded.append(0x08) // b
        case 0x66: decoded.append(0x0c) // f
        case 0x6e: decoded.append(0x0a) // n
        case 0x72: decoded.append(0x0d) // r
        case 0x74: decoded.append(0x09) // t
        case 0x75: // u
            var code = try readHexQuad()
            if (0xd800...0xdbff).contains(code) {
                guard consume(0x5c), consume(0x75) else { throw JSONError.invalid }
                let low = try readHexQuad()
                guard (0xdc00...0xdfff).contains(low) else { throw JSONError.invalid }
                code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
            }
            guard let scalar = Unicode.Scalar(code) else { throw JSONError.invalid }
            decoded.append(contentsOf: scalar.utf8)
        default: throw JSONError.invalid
        }
    }

    private mutating func readHexQuad() throws -> UInt32 {
        guard bytes.count - position >= 4 else { throw JSONError.invalid }
        var code: UInt32 = 0
        for _ in 0..<4 {
            let byte = bytes[position]
            position += 1
            let digit: UInt8
            switch byte {
            case 0x30...0x39: digit = byte - 0x30
            case 0x41...0x46: digit = byte - 0x41 + 10
            case 0x61...0x66: digit = byte - 0x61 + 10
            default: throw JSONError.invalid
            }
            code = (code << 4) | UInt32(digit)
        }
        return code
    }
}
