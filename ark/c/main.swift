import Foundation

private func diagnostic(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

private func headerValue(_ string: String) -> String {
    var result = ""
    for scalar in string.unicodeScalars {
        switch scalar.value {
        case 0x09: result += "\\t"
        case 0x0a: result += "\\n"
        case 0x0d: result += "\\r"
        case 0x00...0x1f, 0x7f: result += String(format: "\\u%04x", scalar.value)
        default: result.unicodeScalars.append(scalar)
        }
    }
    return result
}

private func run() throws -> Int32 {
    let args = CommandLine.arguments
    guard args.count == 3 else {
        diagnostic("usage: verifier BUNDLE PINS")
        return 2
    }

    let pinData = try Data(contentsOf: URL(fileURLWithPath: args[2]))
    guard let pins = Pins(pinData) else {
        diagnostic("malformed pins file")
        return 2
    }
    let data = try Data(contentsOf: URL(fileURLWithPath: args[1]))
    let bundle = BundleFile(data)
    if let bundle { print("coverage: \(headerValue(bundle.coverage))") }
    print("pins supplied by: \(headerValue(pins.suppliedBy))")
    print("integrity only; freshness and completeness not shown")
    guard let bundle else {
        print("BUNDLE INVALID BAD_BUNDLE")
        return 4
    }
    switch try checkItems(bundle.items, pins: pins) {
    case let .invalid(reason, index):
        print("BUNDLE INVALID \(reason) item=\(index)")
        return 4
    case let .untrusted(index):
        print("BUNDLE UNTRUSTED_KEY item=\(index)")
        return 5
    case let .ok(items):
        print("BUNDLE OK")
        var status: Int32 = 0
        for (id, verdict) in operationVerdicts(items, pins: pins) {
            print("OP \(id) \(verdict)")
            if verdict.hasPrefix("INVALID ") { status = 4 }
            if verdict == "UNKNOWN" && status == 0 { status = 3 }
        }
        return status
    }
}

do {
    exit(try run())
} catch {
    diagnostic(String(describing: error))
    exit(2)
}
