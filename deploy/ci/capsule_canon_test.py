#!/usr/bin/env python3
"""Plain test script (no framework) for the independent Python canon,
under contract draft 7.

python3 -I deploy/ci/capsule_canon_test.py
Runs: the vectors (and the act rows' shapes); the two round-trip properties on
20,000 seeded random values and 20,000 seeded random byte strings; every
section 3.2 limit at and one past its bound, for parse and for encode; the
encoder's host-value rows for every class and its order; the digest rules;
the record fixture with one mutation per rule of section 4; the act and gate
shapes (6.2 to 6.5a, section 8's two calls, the act-door codes of section 16)
with one mutation per rule; each draft 7 ruling by its rule name
(run_rulings_7). Prints PYTHON pass=<n> fail=<n>; exits 1 on
any failure.
"""

import sys

# A run must leave no __pycache__ in the tree (a .pyc holds this machine's path).
sys.dont_write_bytecode = True

import copy  # noqa: E402
import random  # noqa: E402

HERE = __file__.rpartition("/")[0] or "."
sys.path.insert(0, HERE)
import capsule_canon as canon  # noqa: E402
import capsule_record_check as record  # noqa: E402
import capsule_act_shapes as act  # noqa: E402

SEED = 20261113
RESULTS = {"pass": 0, "fail": 0}
FAILURES = []
VECTORS_PATH = HERE + "/capsule_canon_vectors_py.json"
MAX_VECTOR_FILE_BYTES = 200000


def check(ok, label):
    if ok:
        RESULTS["pass"] += 1
    else:
        RESULTS["fail"] += 1
        if len(FAILURES) < 60:
            FAILURES.append(label)


def same(a, b):
    """Equality that also tells bool from int and list from dict."""
    if type(a) is not type(b):
        return False
    if type(a) is dict:
        return set(a) == set(b) and all(same(a[k], b[k]) for k in a)
    if type(a) is list:
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    return a == b


def verdict(data):
    try:
        return ("ok", canon.parse(data))
    except canon.Refused as refusal:
        return ("no", refusal)


def encode_verdict(value):
    try:
        return ("ok", canon.encode(value))
    except canon.Refused as refusal:
        return ("no", refusal)


def encode_class(value):
    kind, got = encode_verdict(value)
    return "ok" if kind == "ok" else got.code


def shape_code(fn, *args):
    try:
        fn(*args)
        return "ok"
    except act.ShapeRefused as refusal:
        return refusal.code


# ---------------------------------------------------------------- vectors
SHAPE_CHECKS = {
    "command": act.check_command,
    "envelope": act.check_envelope,
    "request": act.check_request_bytes,
    "policy": act.check_policy,
    "verdict": act.check_verdict,
    "chain": act.check_chain,
    "row": act.check_row,
    "answer": act.check_answer,
    "read": act.check_read,
    "status": act.check_status,
    "rowread": act.check_row_read,
}
ROW_SHAPES = ("command", "envelope", "policy", "verdict", "chain", "row", "answer", "read", "status", "rowread")


def act_row(row):
    data = canon.row_input(row)
    shape = row["shape"]
    if shape in ROW_SHAPES:
        got = shape_code(SHAPE_CHECKS[shape], canon.parse(data))
        check(got == row["shapeVerdict"], "act row %s shape: %s" % (row["name"], got))
    if shape == "gate-inputs":
        got = shape_code(act.check_gate_inputs, canon.parse(data), row["gateCall"])
        check(got == row["shapeVerdict"], "act row %s gate inputs (%s): %s" % (row["name"], row["gateCall"], got))
    if shape == "request":
        got = shape_code(act.check_request_bytes, data)
        check(got == row["shapeVerdict"], "act row %s request: %s" % (row["name"], got))
    if shape == "command" and "statedIdHex" in row:
        got = "match" if act.command_id(data) == row["statedIdHex"] else "CAPSULE_ACTION_ID_MISMATCH"
        check(got == row["idCheck"], "act row %s stated id: %s" % (row["name"], got))
    elif shape == "command":
        check(act.command_id(data) == row["expectHex"], "act row %s command id" % row["name"])
    if shape == "envelope":
        check(act.envelope_digest(data) == row["expectHex"], "act row %s envelope digest" % row["name"])
        message = act.envelope_signing_message(data)
        check(message.hex() == row["signingMessageHex"], "act row %s signing message" % row["name"])
        check(canon.sha256_raw(message) == row["expectHex"], "act row %s: sha256(message) is the digest" % row["name"])
    if shape == "key":
        check(act.key_thumb(row["keyBase64url"]) == row["expectHex"], "act row %s key thumb" % row["name"])
    if shape == "lineage":
        got = shape_code(act.act_lineage_id, row["mirrorLineageId"], row["world"])
        check(got == row["shapeVerdict"], "act row %s lineage inputs: %s" % (row["name"], got))
        check(canon.parse(data) == {"mirror": row["mirrorLineageId"], "world": row["world"]},
              "act row %s: its text is the lineage object" % row["name"])
        if got == "ok":
            check(act.act_lineage_id(row["mirrorLineageId"], row["world"]) == row["expectHex"],
                  "act row %s lineage id" % row["name"])
    if shape == "policy":
        check(canon.encode(act.POLICY_V0) == data, "act row %s: POLICY_V0 encodes to the row" % row["name"])
        check(act.POLICY_V0_DIGEST == row["expectHex"], "act row %s: POLICY_V0_DIGEST" % row["name"])
    if shape == "record":
        result = record.check_record(data)
        problems = [[p["code"], p["where"]] for p in result["problems"] if p["code"] != "CAPSULE_PRODUCER_UNVERIFIED"]
        if result["ok"] and result["complete"]:
            got = "ok"
        elif result["ok"]:
            got = "CAPSULE_INCOMPLETE"
        else:
            got = problems[0][0]
        check(got == row["shapeVerdict"] and problems == row["recordProblems"],
              "record row %s: %s %r" % (row["name"], got, problems))
        check(result["id"] == row["digests"]["aukora.capsule.v1"], "record row %s: its id is its digest" % row["name"])


def run_vectors():
    with open(VECTORS_PATH, "rb") as handle:
        size = len(handle.read())
    check(size <= MAX_VECTOR_FILE_BYTES, "vector file is %d bytes, over 200 KB" % size)
    doc = canon.read_harness_json(VECTORS_PATH)
    counts = {}
    for row in doc["rows"]:
        try:
            reason = canon.check_vector_row(row)
        except Exception as error:
            reason = "crashed %r" % (error,)
        check(reason is None, "vector %s: %s" % (row["name"], reason))
        check("canonicalHex" not in row, "vector %s keeps a second copy of its bytes" % row["name"])
        key = row["verdict"] if row["verdict"] == "ok" else row["class"]
        counts[key] = counts.get(key, 0) + 1
        if "shape" in row:
            try:
                act_row(row)
            except Exception as error:
                check(False, "act row %s crashed %r" % (row["name"], error))
    for cls in canon.CLASSES:
        check(counts.get(cls, 0) >= 6, "class %s appears %d times (3.8 wants six)" % (cls, counts.get(cls, 0)))
    names = set(row["name"] for row in doc["rows"])
    check(not any("ball-id" in name for name in names), "the synthetic ball-id pair is gone (3.5)")
    rows = dict((row["name"], row) for row in doc["rows"])
    for name, count in (("limit-object-8192-members", 8192), ("limit-object-8193-members", 8193)):
        gen = rows[name].get("inputGen", {})
        check(set(gen) == canon.GEN_COUNTER_FIELDS and gen["count"] == count,
              "3.8: %s is stored in the second generator form" % name)
    shapes = set(row.get("shape") for row in doc["rows"])
    for shape in ROW_SHAPES + ("gate-inputs", "lineage", "request", "key", "record"):
        verdicts = set(row["shapeVerdict"] for row in doc["rows"] if row.get("shape") == shape and "shapeVerdict" in row)
        check(shape in shapes and ("ok" in verdicts or shape == "key"), "an accepted act row of shape %s" % shape)
        if shape in ("verdict", "chain", "row", "answer", "read", "status", "rowread", "gate-inputs", "lineage", "request",
                     "record"):
            check(any(v != "ok" for v in verdicts), "a refused act row of shape %s" % shape)


def run_generator_forms():
    """3.8: both inputGen forms, expanded by the one harness function."""
    unit = {"prefixHex": "7b", "unitHex": "3031", "count": 3, "suffixHex": "7d"}
    check(canon.row_input({"inputGen": unit}) == b"{010101}", "first form: prefix, unit count times, suffix")
    counter = {"prefixHex": b"{".hex(), "beforeHex": b'"k'.hex(), "width": 3, "afterHex": b'":0'.hex(),
               "sepHex": b",".hex(), "count": 3, "suffixHex": b"}".hex()}
    check(canon.row_input({"inputGen": counter}) == b'{"k000":0,"k001":0,"k002":0}', "second form: zero-padded counter")
    check(canon.row_input({"inputGen": dict(counter, count=0)}) == b"{}", "second form with count 0: prefix and suffix")
    check(canon.row_input({"inputGen": dict(counter, count=1)}) == b'{"k000":0}', "second form with count 1: no sep")
    check(canon.row_input({"inputGen": dict(counter, width=1, count=10)}).endswith(b'"k9":0}'), "width 1 up to 9")
    big = dict(counter, width=4, count=8193)
    data = canon.row_input({"inputGen": big})
    check(len(data) == 2 + 9 * 8193 + 8192 and data[1 + 10 * 8192: 1 + 10 * 8192 + 7] == b'"k8192"',
          "8,193 distinct keys: the 8,193rd at 1 + 10 * 8,192")
    for name, bad in (
        ("i does not fit the width", dict(counter, width=1, count=11)),
        ("width 0", dict(counter, width=0)),
        ("width a bool", dict(counter, width=True)),
        ("count negative", dict(counter, count=-1)),
        ("both forms at once", dict(counter, unitHex="00")),
        ("a field missing", dict((k, v) for k, v in counter.items() if k != "sepHex")),
        ("expansion past the bound", dict(counter, width=8, count=200000)),
    ):
        try:
            canon.row_input({"inputGen": bad})
            got = "expanded"
        except ValueError:
            got = "refused"
        check(got == "refused", "inputGen %s is refused" % name)
    check(
        canon.digest("aukora.capsule.v1", b"{}") == "1764c8c6824016513eebf3e13a6b5672a193c2fcc861d2d261eb2224636c5691",
        "anchor: empty object under aukora.capsule.v1",
    )


# ---------------------------------------------------------------- digests
def run_digests():
    check(len(canon.DOMAINS) == 8 and len(set(canon.DOMAINS)) == 8, "eight domains (3.5)")
    for bad in ("aukora.capsule.v2", "", "aukora.ball.v1", "AUKORA.CAPSULE.V1"):
        try:
            canon.digest(bad, b"{}")
            got = "ok"
        except ValueError:
            got = "refused"
        check(got == "refused", "digest refuses domain %r" % bad)
    # It hashes whatever bytes it is given and never parses.
    for data in (b"", b"\xff\x00", b'{"b":1,"a":2}', b"not a text", bytearray(b"{}"), memoryview(b"{}")):
        try:
            canon.digest("aukora.capsule.v1", data)
            got = "ok"
        except Exception as error:  # a parse refusal here would be a defect
            got = repr(error)
        check(got == "ok", "digest hashes %r without parsing: %s" % (bytes(data)[:8], got))
    for data in (5, "{}", None, [1]):
        try:
            canon.digest("aukora.capsule.v1", data)
            got = "ok"
        except TypeError:
            got = "TypeError"
        check(got == "TypeError", "digest takes bytes only, not %r" % (data,))
    check(canon.sha256_raw(b"abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "sha256-raw is plain sha256")


# ---------------------------------------------------------- random values
KEY_ALPHABET = "abcxyzABZ0189_.:-"
PRINTABLE = "".join(chr(c) for c in range(0x20, 0x7F))


def rand_key(rng):
    return "".join(rng.choice(KEY_ALPHABET) for _ in range(rng.randint(1, 8)))


def rand_scalar(rng):
    pick = rng.randint(0, 6)
    if pick == 0:
        return None
    if pick == 1:
        return rng.random() < 0.5
    if pick == 2:
        return rng.choice([0, 1, -1, canon.MAX_SAFE_INTEGER, -canon.MAX_SAFE_INTEGER, 10, -10])
    if pick == 3:
        return rng.randint(-canon.MAX_SAFE_INTEGER, canon.MAX_SAFE_INTEGER)
    weighted = PRINTABLE + '"\\"\\'
    return "".join(rng.choice(weighted) for _ in range(rng.randint(0, 12)))


def rand_value(rng, depth):
    """A valid value whose own depth (if a container) is `depth`."""
    if depth >= 7 or rng.random() < 0.45:
        return rand_scalar(rng)
    if rng.random() < 0.5:
        return [rand_value(rng, depth + 1) for _ in range(rng.randint(0, 4))]
    return {rand_key(rng): rand_value(rng, depth + 1) for _ in range(rng.randint(0, 4))}


def rand_root(rng):
    return {rand_key(rng): rand_value(rng, 2) for _ in range(rng.randint(0, 5))}


def containers(value, out):
    if type(value) is dict:
        out.append(value)
        for v in value.values():
            containers(v, out)
    elif type(value) is list:
        out.append(value)
        for v in value:
            containers(v, out)
    return out


def deep_chain(levels):
    v = 1
    for _ in range(levels):
        v = [v]
    return v


class IntChild(int):
    pass


class DictChild(dict):
    pass


# Draft 3, 3.4: a float is NUMBER; a key that is not a str is KEY; a tuple,
# bytes, a set, a class instance (subclasses included) are TYPE.
DEFECTS = (
    ("float", "NUMBER"),
    ("nan", "NUMBER"),
    ("tuple", "TYPE"),
    ("bytes", "TYPE"),
    ("set", "TYPE"),
    ("int-subclass", "TYPE"),
    ("dict-subclass", "TYPE"),
    ("nonstr-key", "KEY"),
    ("tuple-key", "KEY"),
    ("bad-key-char", "KEY"),
    ("non-ascii-key", "KEY"),
    ("empty-key", "KEY"),
    ("long-key", "KEY"),
    ("big-int", "NUMBER"),
    ("control-char", "BYTE_RANGE"),
    ("non-ascii", "BYTE_RANGE"),
    ("long-string", "LIMIT"),
    ("too-deep", "LIMIT"),
    ("root-list", "TYPE"),
)


def inject(rng, root, defect):
    if defect == "root-list":
        return [root]
    dicts = [c for c in containers(root, []) if type(c) is dict]
    place = rng.choice(containers(root, []))
    bad = {
        "float": rng.choice([1.5, 1.0, -0.0, 0.0, 1e300]),
        "nan": float("nan"),
        "tuple": (1, 2),
        "bytes": b"x",
        "set": {1},
        "int-subclass": IntChild(3),
        "dict-subclass": DictChild(a=1),
        "big-int": rng.choice([canon.MAX_SAFE_INTEGER + 1, -canon.MAX_SAFE_INTEGER - 1, 10 ** 30, 10 ** 5000]),
        "control-char": "a" + chr(rng.choice([0, 9, 10, 13, 0x1F, 0x7F])) + "b",
        "non-ascii": "caf" + chr(rng.choice([0xE9, 0x2028, 0x1F600, 0xD800])),
        "long-string": "s" * 2049,
        "too-deep": deep_chain(16),
    }.get(defect)
    keyed = {"nonstr-key": 7, "tuple-key": (1,), "bad-key-char": "a b", "non-ascii-key": "été",
             "empty-key": "", "long-key": "k" * 65}
    if defect in keyed:
        rng.choice(dicts)[keyed[defect]] = 1
    elif type(place) is dict:
        place["zz" + rand_key(rng)] = bad
    else:
        place.insert(rng.randint(0, len(place)), bad)
    return root


def run_random_values(count):
    rng = random.Random(SEED)
    for i in range(count):
        value = rand_root(rng)
        if rng.random() < 0.4:
            defect, expected = DEFECTS[rng.randrange(len(DEFECTS))]
            value = inject(rng, value, defect)
            kind, got = encode_verdict(value)
            check(kind == "no" and got.code == expected and got.at is None, "value %d defect %s: %r" % (i, defect, got))
            continue
        kind, out = encode_verdict(value)
        if kind != "ok":
            check(False, "value %d valid by construction refused: %s" % (i, out))
            continue
        back = canon.parse(out)
        check(same(back, value), "value %d: parse(encode(v)) != v" % i)
        check(canon.encode(back) == out, "value %d: encode(parse(t)) != t" % i)


# ------------------------------------------------------ random byte strings
JSONISH = b'{}[]",:-0123456789truefalsn\\ ab.eE+'


def mutate(rng, data):
    data = bytearray(data)
    for _ in range(rng.randint(1, 3)):
        op = rng.randint(0, 3)
        if op == 0 and data:
            data[rng.randrange(len(data))] = rng.choice(JSONISH)
        elif op == 1:
            data.insert(rng.randint(0, len(data)), rng.choice(JSONISH))
        elif op == 2 and data:
            del data[rng.randrange(len(data))]
        elif len(data) > 1:
            j = rng.randrange(len(data) - 1)
            data[j], data[j + 1] = data[j + 1], data[j]
    return bytes(data)


def judge_bytes(i, data):
    kind, got = verdict(data)
    if kind == "ok":
        out = canon.encode(got)
        check(out == data, "bytes %d: encode(parse(t)) != t" % i)
        check(same(canon.parse(out), got), "bytes %d: parse(encode(v)) != v" % i)
        if len(data) > 2:
            cut = data[: (len(data) * 7) // 11]
            check(verdict(cut)[0] == "no", "bytes %d: a proper prefix was accepted" % i)
        return
    ok = got.code in canon.CLASSES and 0 <= got.at <= len(data)
    check(ok, "bytes %d: bad refusal %r" % (i, got))
    # Left to right: everything before the failing byte was fine, so cutting the
    # text there must end the pass at that same byte (SYNTAX at the cut), unless
    # the failure was bytes after a complete root, whose prefix is then accepted.
    if got.code not in ("TYPE", "BYTE_RANGE") and not (got.code == "LIMIT" and len(data) > canon.MAX_TEXT_BYTES):
        k2, g2 = verdict(data[: got.at])
        held = (k2 == "no" and g2.code == "SYNTAX" and g2.at == got.at) or (
            k2 == "ok" and got.code == "SYNTAX" and got.at < len(data)
        )
        check(held, "bytes %d: prefix property %r vs %r" % (i, got, g2))


def run_random_bytes(count):
    rng = random.Random(SEED + 1)
    vrng = random.Random(SEED + 2)
    for i in range(count):
        pick = i % 4
        if pick == 0:
            data = bytes(rng.randrange(256) for _ in range(rng.randint(0, 40)))
        elif pick == 1:
            data = b"{" + bytes(rng.choice(JSONISH) for _ in range(rng.randint(0, 30)))
        else:
            base = canon.encode(rand_root(vrng))
            data = base if pick == 2 and rng.random() < 0.2 else mutate(rng, base)
        judge_bytes(i, data)


# ------------------------------------------------------------------ limits
def zeros(k):
    return ",".join(["0"] * k)


def big_strings(total):
    """{"a":["x..",...]} of exactly `total` bytes."""
    body = total - 8
    items = []
    while body > 0:
        take = min(2048, body - 2 - (1 if items else 0))
        items.append("x" * take)
        body -= take + 2 + (1 if len(items) > 1 else 0)
    text = '{"a":[' + ",".join('"' + s + '"' for s in items) + "]}"
    assert len(text) == total, (len(text), total)
    return text.encode("ascii")


def nodes_case(last):
    head = '{"a":[' + zeros(8192) + '],"b":[' + zeros(8192) + '],"c":['
    return len(head), (head + zeros(last) + "]}").encode("ascii")


def chain(levels):
    v = []
    for _ in range(levels - 1):
        v = [v]
    return v


def run_limits():
    head_len, at_bound = nodes_case(3612)
    _, past = nodes_case(3613)
    members = lambda k: ("{" + ",".join('"k%04d":0' % i for i in range(k)) + "}").encode()  # noqa: E731
    parse_cases = [
        ("text bytes", big_strings(262144), big_strings(262145), ("LIMIT", 262144)),
        ("depth", b'{"a":' + b"[" * 15 + b"]" * 15 + b"}", b'{"a":' + b"[" * 16 + b"]" * 16 + b"}", ("LIMIT", 20)),
        ("nodes", at_bound, past, ("LIMIT", head_len + 2 * 3612)),
        ("string chars", b'{"s":"' + b"a" * 2048 + b'"}', b'{"s":"' + b"a" * 2049 + b'"}', ("LIMIT", 2054)),
        ("string chars, escape counts one", b'{"s":"' + b"\\\\" * 2048 + b'"}', b'{"s":"' + b"\\\\" * 2049 + b'"}',
         ("LIMIT", 6 + 2 * 2048)),
        ("array items", b'{"a":[' + zeros(8192).encode() + b"]}", b'{"a":[' + zeros(8193).encode() + b"]}",
         ("LIMIT", 6 + 2 * 8192)),
        # Also in the vector file since draft 6 (the second generator form of 3.8).
        ("object members", members(8192), members(8193), ("LIMIT", 1 + 10 * 8192)),
        ("key bytes", b'{"' + b"k" * 64 + b'":1}', b'{"' + b"k" * 65 + b'":1}', ("KEY", 66)),
        ("integer magnitude", b'{"n":9007199254740991}', b'{"n":9007199254740992}', ("NUMBER", 5)),
        ("negative magnitude", b'{"n":-9007199254740991}', b'{"n":-9007199254740992}', ("NUMBER", 5)),
    ]
    for label, good, bad, (cls, at) in parse_cases:
        kind, _ = verdict(good)
        check(kind == "ok", "parse limit %s at bound refused" % label)
        kind, got = verdict(bad)
        check(kind == "no" and (got.code, got.at) == (cls, at), "parse limit %s past bound: %r" % (label, got))
        value = canon.parse(good)
        check(canon.encode(value) == good, "encode limit %s at bound" % label)

    # Draft 3 positions (3.3): a bad escape at the backslash, a bad literal at its first byte.
    for text, at in ((b'{"a":"\\n"}', 6), (b'{"a":"\\', 6), (b'{"a":"xy\\', 8), (b'{"a":tru}', 5), (b'{"a":t', 5),
                     (b'{"a":[nul]}', 6), (b'{"a":fals', 5), (b'{"a":falsE}', 5)):
        kind, got = verdict(text)
        check(kind == "no" and (got.code, got.at) == ("SYNTAX", at), "position %r: %r" % (text, got))

    encode_cases = [
        ("string chars", {"s": "a" * 2048}, {"s": "a" * 2049}, "LIMIT"),
        ("key bytes", {"k" * 64: 1}, {"k" * 65: 1}, "KEY"),
        ("depth", {"a": chain(15)}, {"a": chain(16)}, "LIMIT"),
        ("array items", {"a": [0] * 8192}, {"a": [0] * 8193}, "LIMIT"),
        ("object members", {"k%04d" % i: 0 for i in range(8192)}, {"k%04d" % i: 0 for i in range(8193)}, "LIMIT"),
        ("nodes", {"a": [0] * 8192, "b": [0] * 8192, "c": [0] * 3612}, {"a": [0] * 8192, "b": [0] * 8192, "c": [0] * 3613},
         "LIMIT"),
        ("integer", {"n": canon.MAX_SAFE_INTEGER}, {"n": canon.MAX_SAFE_INTEGER + 1}, "NUMBER"),
        ("negative integer", {"n": -canon.MAX_SAFE_INTEGER}, {"n": -canon.MAX_SAFE_INTEGER - 1}, "NUMBER"),
        ("text bytes", canon.parse(big_strings(262144)), canon.parse(big_strings(262144)), None),
    ]
    big = canon.parse(big_strings(262144))
    big_past = copy.deepcopy(big)
    big_past["a"][-1] += "x"
    encode_cases[-1] = ("text bytes", big, big_past, "LIMIT")
    for label, good, bad, cls in encode_cases:
        check(encode_class(good) == "ok", "encode limit %s at bound refused" % label)
        kind, got = encode_verdict(bad)
        check(kind == "no" and got.code == cls and got.at is None, "encode limit %s past bound: %r" % (label, got))


def run_encoder_rows():
    """Host-value rows for every encoder class (3.4) and its order."""
    cyclic = []
    cyclic.append(cyclic)
    cyclic_dict = {}
    cyclic_dict["a"] = cyclic_dict
    rows = [
        # BYTE_RANGE
        ("str with e-acute", {"a": "café"}, "BYTE_RANGE"),
        ("str with newline", {"a": "\n"}, "BYTE_RANGE"),
        ("str with DEL", {"a": "\x7f"}, "BYTE_RANGE"),
        ("str with lone surrogate", {"a": "\ud800"}, "BYTE_RANGE"),
        ("str with emoji", {"a": ["ok", "\U0001F600"]}, "BYTE_RANGE"),
        ("str with NUL", {"a": "\x00"}, "BYTE_RANGE"),
        # NUMBER
        ("float 1.5", {"a": 1.5}, "NUMBER"),
        ("float 1.0", {"a": 1.0}, "NUMBER"),
        ("float -0.0", {"a": -0.0}, "NUMBER"),
        ("float nan", {"a": float("nan")}, "NUMBER"),
        ("float inf", {"a": float("inf")}, "NUMBER"),
        ("int 2**53", {"a": 2 ** 53}, "NUMBER"),
        ("int -(2**53)", {"a": -(2 ** 53)}, "NUMBER"),
        ("int of 5001 digits", {"a": 10 ** 5000}, "NUMBER"),
        ("int of 5001 digits, negative", {"a": -(10 ** 5000)}, "NUMBER"),
        ("int of 262201 digits", {"a": 10 ** 262200}, "NUMBER"),
        ("int of 400001 digits", {"a": 10 ** 400000}, "NUMBER"),
        # KEY
        ("int key", {1: 1}, "KEY"),
        ("None key", {None: 1}, "KEY"),
        ("tuple key", {(1, 2): 1}, "KEY"),
        ("bool key", {True: 1}, "KEY"),
        ("empty key", {"": 1}, "KEY"),
        ("key with space", {"a b": 1}, "KEY"),
        ("key of 65", {"k" * 65: 1}, "KEY"),
        ("non-ascii key", {"é": 1}, "KEY"),
        ("key with quote", {'a"': 1}, "KEY"),
        # LIMIT
        ("string of 2049", {"a": "x" * 2049}, "LIMIT"),
        ("depth 17", {"a": chain(16)}, "LIMIT"),
        ("self-containing list", {"a": cyclic}, "LIMIT"),
        ("self-containing dict", cyclic_dict, "LIMIT"),
        ("array of 8193", {"a": [None] * 8193}, "LIMIT"),
        ("object of 8193", {"k%04d" % i: None for i in range(8193)}, "LIMIT"),
        # TYPE
        ("root list", [1], "TYPE"),
        ("root int", 5, "TYPE"),
        ("root None", None, "TYPE"),
        ("root float", 1.5, "TYPE"),
        ("root str", "{}", "TYPE"),
        ("root dict subclass", DictChild(), "TYPE"),
        ("tuple", {"a": (1,)}, "TYPE"),
        ("bytes", {"a": b""}, "TYPE"),
        ("bytearray", {"a": bytearray(b"x")}, "TYPE"),
        ("set", {"a": {1}}, "TYPE"),
        ("object", {"a": object()}, "TYPE"),
        ("int subclass", {"a": IntChild(1)}, "TYPE"),
        ("function", {"a": len}, "TYPE"),
        # order: first failure in emission order wins
        ("float before a bad string", {"a": 1.5, "b": "\n"}, "NUMBER"),
        ("bad string before a float", {"a": "\n", "b": 1.5}, "BYTE_RANGE"),
        ("bad key sorts first", {"b": 1.5, "a b": 1}, "KEY"),
        ("big int before a float", {"a": 10 ** 5000, "z": 1.5}, "NUMBER"),
        ("float inside, item 5 of 8193", {"a": [0] * 5 + [1.5] + [0] * 8187}, "NUMBER"),
        ("item count before item 8193's own float", {"a": [0] * 8192 + [1.5]}, "LIMIT"),
        ("text length before a later float", {"a": ["x" * 2045] * 130, "b": 1.5}, "LIMIT"),
        ("an earlier float before the text length", {"a": 1.5, "b": ["x" * 2045] * 130}, "NUMBER"),
        ("depth before the bottom's float", {"a": [[[[[[[[[[[[[[[[1.5]]]]]]]]]]]]]]]]}, "LIMIT"),
        ("a tuple before a float", {"a": (1,), "b": 1.5}, "TYPE"),
        ("bool is not an int", {"a": True, "b": False}, "ok"),
    ]
    for label, value, expected in rows:
        try:
            got = encode_class(value)
        except Exception as crash:  # a crash is never a verdict
            got = "crash %r" % (crash,)
        check(got == expected, "encoder row %s: %s" % (label, got))
    check(canon.encode({"a": True, "b": 1}) == b'{"a":true,"b":1}', "encode keeps bool apart from int")
    check(canon.encode({"2": 1, "10": 2, "__proto__": 3, "constructor": 4}) == b'{"10":2,"2":1,"__proto__":3,"constructor":4}',
          "encode sorts by key bytes")


# ------------------------------------------------------------------ record
def at_path(body, path):
    node = body
    for part in path[:-1]:
        node = node[part]
    return node, path[-1]


def setv(path, value):
    def run(body):
        node, last = at_path(body, path)
        node[last] = value

    return run


def delv(path):
    def run(body):
        node, last = at_path(body, path)
        del node[last]

    return run


def swap(path, i=0):
    def run(body):
        node, last = at_path(body, path)
        items = node[last]
        items[i], items[i + 1] = items[i + 1], items[i]

    return run


def dup(path):
    def run(body):
        node, last = at_path(body, path)
        items = node[last]
        items[1] = copy.deepcopy(items[0])

    return run


def both(*runs):
    def run(body):
        for r in runs:
            r(body)

    return run


def drop_inventory(row_id):
    def run(body):
        inv = body["state"]["inventory"]
        inv[:] = [r for r in inv if r["id"] != row_id]

    return run


def drop_source(name):
    def run(body):
        src = body["observation"]["sources"]
        src[:] = [r for r in src if r["name"] != name]

    return run


def fail_source(name, code="UNKNOWN_SOURCE_FAILED"):
    def run(body):
        for r in body["observation"]["sources"]:
            if r["name"] == name:
                r["ok"], r["code"] = False, code

    return run


S = ["state"]
H = S + ["heads"]
INV = S + ["inventory"]
OBS = ["observation"]
# Fixture inventory order: 0 file, 1 headHistory, 2 messages, 3 module, 4 organ:mind,
# 5 ownerBinding, 6 providerBudget, 7 turnJournal (1, 2, 5, 6, 7: the constants of ruling 5). Sources: head.local, head.published,
# head.staged, memory, producer. Evidence: one row in each of the three lists.
# authorityRequired: the whole closed list of three.
SCHEMA_MUTATIONS = [
    ("body missing observation", delv(OBS), "SCHEMA", "body.observation"),
    ("body unknown field", setv(["extra"], 1), "SCHEMA", "body.extra"),
    ("body schema wrong type", setv(["schema"], 1), "SCHEMA", "body.schema"),
    ("lineageId uppercase", setv(S + ["lineageId"], "A" * 64), "SCHEMA", "body.state.lineageId"),
    ("lineageId 63 digits", setv(S + ["lineageId"], "1" * 63), "SCHEMA", "body.state.lineageId"),
    ("parentCapsuleId integer", setv(S + ["parentCapsuleId"], 5), "SCHEMA", "body.state.parentCapsuleId"),
    ("state unknown field", setv(S + ["zzz"], None), "SCHEMA", "body.state.zzz"),
    ("agreement outside list", setv(H + ["agreement"], "live"), "SCHEMA", "body.state.heads.agreement"),
    ("agreement not the recomputed value", setv(H + ["agreement"], "agree"), "SCHEMA", "body.state.heads.agreement"),
    ("agreement stale after an epoch change", setv(H + ["published", "epoch"], 80), "SCHEMA", "body.state.heads.agreement"),
    ("ballIdForm outside list", setv(H + ["local", "ballIdForm"], "other"), "SCHEMA", "body.state.heads.local.ballIdForm"),
    ("epoch negative", setv(H + ["local", "epoch"], -1), "SCHEMA", "body.state.heads.local.epoch"),
    ("epoch string", setv(H + ["local", "epoch"], "76"), "SCHEMA", "body.state.heads.local.epoch"),
    ("local missing parentBallId", delv(H + ["local", "parentBallId"]), "SCHEMA", "body.state.heads.local.parentBallId"),
    ("published extra field", setv(H + ["published", "parentBallId"], None), "SCHEMA",
     "body.state.heads.published.parentBallId"),
    ("staged missing state", delv(H + ["staged", "state"]), "SCHEMA", "body.state.heads.staged.state"),
    ("ballId empty", setv(H + ["local", "ballId"], ""), "SCHEMA", "body.state.heads.local.ballId"),
    ("ballId 129 chars", setv(H + ["local", "ballId"], "b" * 129), "SCHEMA", "body.state.heads.local.ballId"),
    ("local null", setv(H + ["local"], None), "SCHEMA", "body.state.heads.local"),
    ("builder other", setv(S + ["producer", "builder"], "auma/capsule-record"), "SCHEMA", "body.state.producer.builder"),
    ("builderVersion 2", setv(S + ["producer", "builderVersion"], 2), "SCHEMA", "body.state.producer.builderVersion"),
    ("claim other", setv(S + ["producer", "claim"], "host-built"), "SCHEMA", "body.state.producer.claim"),
    ("sourceRevision 39 hex", setv(S + ["producer", "sourceRevision"], "a" * 39), "SCHEMA", "body.state.producer.sourceRevision"),
    ("sourceRevision uppercase", setv(S + ["producer", "sourceRevision"], "A" * 40), "SCHEMA",
     "body.state.producer.sourceRevision"),
    ("runtimeArtifactSha256 not hex64", setv(S + ["producer", "runtimeArtifactSha256"], "xyz"), "SCHEMA",
     "body.state.producer.runtimeArtifactSha256"),
    ("inventory kind outside list", setv(INV + [0, "kind"], "secret"), "SCHEMA", "body.state.inventory[0].kind"),
    ("inventory disposition outside list", setv(INV + [0, "disposition"], "maybe"), "SCHEMA",
     "body.state.inventory[0].disposition"),
    ("inventory reason outside list", setv(INV + [1, "reason"], "EXCLUDED_BY_ME"), "SCHEMA", "body.state.inventory[1].reason"),
    ("included with a reason", setv(INV + [0, "reason"], "EXCLUDED_PRIVATE"), "SCHEMA", "body.state.inventory[0].reason"),
    ("excluded without a reason", setv(INV + [1, "reason"], None), "SCHEMA", "body.state.inventory[1].reason"),
    ("excluded with an UNKNOWN_ reason", setv(INV + [1, "reason"], "UNKNOWN_NO_SOURCE"), "SCHEMA",
     "body.state.inventory[1].reason"),
    ("unknown with an EXCLUDED_ reason", both(setv(INV + [0, "disposition"], "unknown"), setv(INV + [0, "reason"], "EXCLUDED_SECRET")),
     "SCHEMA", "body.state.inventory[0].reason"),
    ("inventory digestKind outside list", setv(INV + [0, "digestKind"], "md5"), "SCHEMA",
     "body.state.inventory[0].digestKind"),
    ("inventory sha256-raw digest not hex64", setv(INV + [0, "digest"], "mind@3"), "SCHEMA", "body.state.inventory[0].digest"),
    ("inventory digest without digestKind", setv(INV + [1, "digest"], "c" * 64), "SCHEMA", "body.state.inventory[1].digest"),
    ("inventory digestKind without digest", setv(INV + [0, "digest"], None), "SCHEMA", "body.state.inventory[0].digest"),
    ("inventory byteLength negative", setv(INV + [0, "byteLength"], -5), "SCHEMA", "body.state.inventory[0].byteLength"),
    ("inventory unsorted", swap(INV), "SCHEMA", "body.state.inventory[1]"),
    ("inventory duplicate id", dup(INV), "SCHEMA", "body.state.inventory[1]"),
    ("inventory row extra field", setv(INV + [0, "note"], "x"), "SCHEMA", "body.state.inventory[0].note"),
    ("always-excluded row included", both(setv(INV + [5, "disposition"], "included"), setv(INV + [5, "reason"], None)),
     "SCHEMA", "body.state.inventory[5].disposition"),
    ("always-excluded row unknown", both(setv(INV + [7, "disposition"], "unknown"), setv(INV + [7, "reason"], "UNKNOWN_NO_SOURCE")),
     "SCHEMA", "body.state.inventory[7].disposition"),
    ("receipts count string", setv(S + ["roots", "receipts", "count"], "42"), "SCHEMA", "body.state.roots.receipts.count"),
    ("receipts lastLeafHash null", setv(S + ["roots", "receipts", "lastLeafHash"], None), "SCHEMA",
     "body.state.roots.receipts.lastLeafHash"),
    ("memory nodes negative", setv(S + ["roots", "memory"], {"root": "9" * 64, "nodes": -1}), "SCHEMA",
     "body.state.roots.memory.nodes"),
    ("suite missing cases", delv(S + ["roots", "suite", "cases"]), "SCHEMA", "body.state.roots.suite.cases"),
    ("policy version string", setv(S + ["roots", "policy", "version"], "v0"), "SCHEMA", "body.state.roots.policy.version"),
    ("roots missing baseline", delv(S + ["roots", "baseline"]), "SCHEMA", "body.state.roots.baseline"),
    ("pending state outside list", setv(S + ["pending", 0, "state"], "done"), "SCHEMA", "body.state.pending[0].state"),
    ("pending intentId 64 digits", setv(S + ["pending", 0, "intentId"], "a" * 64), "SCHEMA", "body.state.pending[0].intentId"),
    ("pending intentId any id", setv(S + ["pending", 0, "intentId"], "intent-7"), "SCHEMA", "body.state.pending[0].intentId"),
    ("pending actionId not hex64", setv(S + ["pending", 0, "actionId"], "act-1"), "SCHEMA", "body.state.pending[0].actionId"),
    ("pending seq zero", setv(S + ["pending", 0, "seq"], 0), "SCHEMA", "body.state.pending[0].seq"),
    ("pending unsorted", swap(S + ["pending"]), "SCHEMA", "body.state.pending[1]"),
    ("pending duplicate seq", setv(S + ["pending", 1, "seq"], 4), "SCHEMA", "body.state.pending[1]"),
    ("evidence status outside list", setv(S + ["evidence", "receipts", 0, "status"], "ok"), "SCHEMA",
     "body.state.evidence.receipts[0].status"),
    ("evidence receipts unsorted", swap(S + ["evidence", "receipts"]), "SCHEMA", "body.state.evidence.receipts[1]"),
    ("evidence missing checkpoints", delv(S + ["evidence", "checkpoints"]), "SCHEMA", "body.state.evidence.checkpoints"),
    ("evidence scope empty", setv(S + ["evidence", "retention", 0, "scope"], ""), "SCHEMA",
     "body.state.evidence.retention[0].scope"),
    ("evidence scope outside the closed list", setv(S + ["evidence", "retention", 0, "scope"], "home"), "SCHEMA",
     "body.state.evidence.retention[0].scope"),
    ("evidence scope of another list (receipts row as checkpoint)", setv(S + ["evidence", "receipts", 0, "scope"], "checkpoint"),
     "SCHEMA", "body.state.evidence.receipts[0].scope"),
    ("evidence scope of another list (checkpoint row as retention)",
     setv(S + ["evidence", "checkpoints", 0, "scope"], "behavioral-retention-only"), "SCHEMA",
     "body.state.evidence.checkpoints[0].scope"),
    ("inventory id with no fixed form", setv(INV + [0, "id"], "docs/readme.md"), "SCHEMA", "body.state.inventory[0].id"),
    ("inventory id file: with an empty path", setv(INV + [0, "id"], "file:"), "SCHEMA", "body.state.inventory[0].id"),
    ("inventory id module: not a sha256", setv(INV + [3, "id"], "module:" + "A" * 64), "SCHEMA", "body.state.inventory[3].id"),
    ("inventory id module: 63 digits", setv(INV + [3, "id"], "module:" + "a" * 63), "SCHEMA", "body.state.inventory[3].id"),
    ("inventory id organ: with an empty id", setv(INV + [4, "id"], "organ:"), "SCHEMA", "body.state.inventory[4].id"),
    ("inventory id a fixed name in another case", setv(INV + [5, "id"], "OwnerBinding"), "SCHEMA",
     "body.state.inventory[5].id"),
    ("readerMin 0", setv(S + ["compatibility", "readerMin"], 0), "SCHEMA", "body.state.compatibility.readerMin"),
    ("canon not a string", setv(S + ["compatibility", "canon"], 1), "SCHEMA", "body.state.compatibility.canon"),
    ("unsupported holds an integer", setv(S + ["compatibility", "unsupported"], [5]), "SCHEMA",
     "body.state.compatibility.unsupported[0]"),
    ("unsupported unsorted", setv(S + ["compatibility", "unsupported"], ["ZETA", "ALPHA"]), "SCHEMA",
     "body.state.compatibility.unsupported[1]"),
    ("authorityRequired empty code", setv(S + ["authorityRequired"], [""]), "SCHEMA", "body.state.authorityRequired[0]"),
    ("authorityRequired lowercase code", setv(S + ["authorityRequired"], ["owner_passkey"]), "SCHEMA",
     "body.state.authorityRequired[0]"),
    ("authorityRequired code starts with a digit", setv(S + ["authorityRequired"], ["9LIVES"]), "SCHEMA",
     "body.state.authorityRequired[0]"),
    ("authorityRequired code of 129", setv(S + ["authorityRequired"], ["A" * 129]), "SCHEMA", "body.state.authorityRequired[0]"),
    ("authorityRequired duplicate", setv(S + ["authorityRequired"], ["OWNER_SESSION", "OWNER_SESSION"]), "SCHEMA",
     "body.state.authorityRequired[1]"),
    ("authorityRequired outside the closed list", setv(S + ["authorityRequired"], ["OWNER_PASSKEY"]), "SCHEMA",
     "body.state.authorityRequired[0]"),
    ("authorityRequired a section 16 code", setv(S + ["authorityRequired"], ["CAPSULE_AUTHORITY_REQUIRED"]), "SCHEMA",
     "body.state.authorityRequired[0]"),
    ("authorityRequired unsorted", setv(S + ["authorityRequired"], ["WRITER_LEASE", "OWNER_SESSION"]), "SCHEMA",
     "body.state.authorityRequired[1]"),
    ("extensions not an object", setv(S + ["extensions"], []), "SCHEMA", "body.state.extensions"),
    ("capturedAtMs negative", setv(OBS + ["capturedAtMs"], -1), "SCHEMA", "body.observation.capturedAtMs"),
    ("attempt 4", setv(OBS + ["attempt"], 4), "SCHEMA", "body.observation.attempt"),
    ("attempt 0", setv(OBS + ["attempt"], 0), "SCHEMA", "body.observation.attempt"),
    ("source ok not boolean", setv(OBS + ["sources", 0, "ok"], "yes"), "SCHEMA", "body.observation.sources[0].ok"),
    ("source failed without code", setv(OBS + ["sources", 2, "ok"], False), "SCHEMA", "body.observation.sources[2].code"),
    ("source ok with a code", setv(OBS + ["sources", 2, "code"], "SOME_CODE"), "SCHEMA", "body.observation.sources[2].code"),
    ("source code lowercase", both(setv(OBS + ["sources", 2, "ok"], False), setv(OBS + ["sources", 2, "code"], "failed")),
     "SCHEMA", "body.observation.sources[2].code"),
    ("source name outside the closed list", setv(OBS + ["sources", 0, "name"], "clock"), "SCHEMA",
     "body.observation.sources[0].name"),
    ("sources unsorted", swap(OBS + ["sources"]), "SCHEMA", "body.observation.sources[1]"),
    ("source missing observedAtMs", delv(OBS + ["sources", 0, "observedAtMs"]), "SCHEMA",
     "body.observation.sources[0].observedAtMs"),
    # The null rule, case three: a null whose source has no row.
    ("null memory with no memory row", drop_source("memory"), "SCHEMA", "body.state.roots.memory"),
    ("null runtimeArtifactSha256 with no producer row", drop_source("producer"), "SCHEMA",
     "body.state.producer.runtimeArtifactSha256"),
    ("null published with no row", both(setv(H + ["published"], None), setv(H + ["agreement"], "unknown"),
                                        drop_source("head.published")), "SCHEMA", "body.state.heads.published"),
]

UNSUPPORTED = [
    ("schema other name", setv(["schema"], "aukora.capsule.v2"), "body.schema"),
    ("readerMin 2", setv(S + ["compatibility", "readerMin"], 2), "body.state.compatibility.readerMin"),
    ("canon other", setv(S + ["compatibility", "canon"], "aukora.canon.v2"), "body.state.compatibility.canon"),
    ("extensions not empty", setv(S + ["extensions"], {"x": 1}), "body.state.extensions"),
    # reported alone: other field errors in the same body are not checked
    ("unsupported beside a field error", both(setv(S + ["compatibility", "readerMin"], 2), setv(OBS + ["attempt"], 9)),
     "body.state.compatibility.readerMin"),
]

INCOMPLETE = [
    # Ruling 3: each failed source row is reported once, whether or not a null names it.
    ("null memory whose source failed", fail_source("memory"), ["source:memory"]),
    ("null staged whose source failed", both(setv(H + ["staged"], None), fail_source("head.staged")),
     ["source:head.staged"]),
    ("a failed source with nothing null", fail_source("head.local"), ["source:head.local"]),
    ("an unknown inventory row", both(setv(INV + [0, "disposition"], "unknown"), setv(INV + [0, "reason"], "UNKNOWN_NOT_CAPTURED")),
     ["inventory:file:docs/readme.md"]),
    ("ownerBinding row missing", drop_inventory("ownerBinding"), ["inventory:ownerBinding"]),
    ("all five rows missing", both(*[drop_inventory(n) for n in record.ALWAYS_EXCLUDED]),
     ["inventory:" + n for n in record.ALWAYS_EXCLUDED]),
]

COMPLETE = [
    ("null memory read and empty", lambda body: None),
    ("null staged read and empty", setv(H + ["staged"], None)),
    ("null runtimeArtifactSha256 read and empty", lambda body: None),
    ("evidence lists empty", both(setv(S + ["evidence", "retention"], []), setv(S + ["evidence", "receipts"], []),
                                  setv(S + ["evidence", "checkpoints"], []))),
]


def run_record():
    fixture = canon.read_harness_json(HERE + "/capsule_record_fixture_py.json")
    data = bytes.fromhex(fixture["bodyHex"])
    original_id = fixture["expectedId"]
    items = dict((k, bytes.fromhex(v)) for k, v in fixture["itemsHex"].items())
    label = {"code": "CAPSULE_PRODUCER_UNVERIFIED", "where": None}
    result = record.check_record(data, original_id, items)
    check(result == {"ok": True, "complete": True, "id": original_id, "stateRoot": fixture["expectedStateRoot"],
                     "problems": [label]}, "record fixture verifies, complete, with the label: %r" % (result,))
    check(set(result) == {"ok", "complete", "id", "stateRoot", "problems"}, "verifier result shape")
    marker = b',"state":'
    state_bytes = data[data.index(marker) + len(marker): -1]
    check(canon.digest("aukora.capsule.state.v1", state_bytes) == result["stateRoot"], "state root over the body's own bytes")
    body = canon.parse(data)

    def run(mutation, presented=None, with_items=None):
        mutated = copy.deepcopy(body)
        mutation(mutated)
        got = record.check_record(canon.encode(mutated), presented, with_items)
        EMITTED.update(p["code"] for p in got["problems"])
        return got

    for label_text, mutation, code, where in SCHEMA_MUTATIONS:
        got = run(mutation)
        held = (not got["ok"] and not got["complete"] and got["problems"][:1] == [{"code": code, "where": where}]
                and got["stateRoot"] is None and label in got["problems"])
        check(held, "record mutation %s: %r" % (label_text, got["problems"]))
    for label_text, mutation, where in UNSUPPORTED:
        got = run(mutation)
        check(not got["ok"] and got["problems"] == [{"code": "CAPSULE_SCHEMA_UNSUPPORTED", "where": where}],
              "record unsupported %s, alone: %r" % (label_text, got["problems"]))
    for label_text, mutation, wheres in INCOMPLETE:
        got = run(mutation)
        incomplete = [p["where"] for p in got["problems"] if p["code"] == "CAPSULE_INCOMPLETE"]
        check(got["ok"] and not got["complete"] and sorted(incomplete) == sorted(wheres) and label in got["problems"],
              "record incomplete %s: %r" % (label_text, got))
    for label_text, mutation in COMPLETE:
        got = run(mutation)
        check(got["ok"] and got["complete"] and got["problems"] == [label], "record complete %s: %r" % (label_text, got))

    # Agreement, recomputed (section 4): every row of the rule.
    local = {"ballId": "a" * 64, "ballIdForm": "canonical", "epoch": 76}
    table = [
        (None, "unknown"),
        ({"ballId": "a" * 64, "ballIdForm": "legacy", "epoch": 76}, "unknown"),
        ({"ballId": "a" * 64, "ballIdForm": "canonical", "epoch": 76}, "agree"),
        ({"ballId": "b" * 64, "ballIdForm": "canonical", "epoch": 75}, "local-ahead"),
        ({"ballId": "b" * 64, "ballIdForm": "canonical", "epoch": 77}, "published-ahead"),
        ({"ballId": "b" * 64, "ballIdForm": "canonical", "epoch": 76}, "diverged"),
        ({"ballId": "a" * 64, "ballIdForm": "canonical", "epoch": 75}, "diverged"),
    ]
    for published, expected in table:
        check(record.agreement_of(local, published) == expected, "agreement %r -> %s" % (published, expected))
        mutated = copy.deepcopy(body)
        mutated["state"]["heads"]["local"].update(local)
        mutated["state"]["heads"]["published"] = published
        mutated["state"]["heads"]["agreement"] = expected
        got = record.check_record(canon.encode(mutated))
        check(got["ok"], "record with agreement %s verifies: %r" % (expected, got["problems"]))
        for other in record.AGREEMENT:
            if other == expected:
                continue
            mutated["state"]["heads"]["agreement"] = other
            got = record.check_record(canon.encode(mutated))
            check(got["problems"][:1] == [{"code": "SCHEMA", "where": "body.state.heads.agreement"}],
                  "stored agreement %s where %s is right" % (other, expected))

    # 3.6: tampering is a mismatch, judged on the raw bytes before any parse.
    changed = data.replace(b'"epoch":76', b'"epoch":86', 1)
    check(changed != data and len(changed) == len(data), "one-byte change built")
    got = record.check_record(changed, original_id)
    EMITTED.update(p["code"] for p in got["problems"])
    check(got == {"ok": False, "complete": False, "id": canon.digest("aukora.capsule.v1", changed), "stateRoot": None,
                  "problems": [{"code": "CAPSULE_BYTES_MISMATCH", "where": "id"}]}, "changed bytes under the original id")
    other = record.check_record(changed, canon.digest("aukora.capsule.v1", changed))
    check(other["id"] != original_id and other["ok"] and other["complete"] and other["problems"] == [label],
          "changed bytes under their own id are simply another record")
    for cut in (data[:-1], data[: len(data) // 2], b"", b"\xff garbage"):
        got = record.check_record(cut, original_id)
        check(got["problems"] == [{"code": "CAPSULE_BYTES_MISMATCH", "where": "id"}], "truncation or garbage under the original id")
    got = record.check_record(data[:-1])
    check(got["problems"] == [{"code": "SYNTAX", "where": len(data) - 1}], "truncation alone is a parse refusal: %r" % got)
    noncanon = b'{"b":1,"a":2}'
    got = record.check_record(noncanon, canon.digest("aukora.capsule.v1", noncanon))
    check(got["problems"] == [{"code": "KEY_ORDER", "where": 7}], "non-canonical bytes under their own id: their class")

    # Item bytes (section 4).
    file_id = "file:docs/readme.md"
    module_id = [k for k in items if k.startswith("module:")][0]
    got = record.check_record(data, original_id, None)
    check(got["ok"] and got["complete"] and got["problems"] == [label], "no item bytes supplied: nothing checked")
    for name, supplied in (
        ("one changed byte", dict(items, **{file_id: b"#" + items[file_id][1:].replace(b"O", b"o", 1)})),
        ("a truncation", dict(items, **{file_id: items[file_id][:-1]})),
        ("an extra byte", dict(items, **{file_id: items[file_id] + b"\n"})),
    ):
        got = record.check_record(data, original_id, supplied)
        check(not got["ok"] and not got["complete"] and {"code": "CAPSULE_BYTES_MISMATCH", "where": "item:" + file_id}
              in got["problems"] and got["stateRoot"] == fixture["expectedStateRoot"], "item %s: %r" % (name, got))
    got = record.check_record(data, original_id, {file_id: items[file_id]})
    check(got["ok"] and not got["complete"] and got["problems"] == [
        {"code": "CAPSULE_INCOMPLETE", "where": "item:" + module_id}, label], "an item with no bytes is reported: %r" % got)

    # Determinism: same state, another observation -> same root, another id.
    later = copy.deepcopy(body)
    later["observation"]["capturedAtMs"] += 1000
    again = record.check_record(canon.encode(later))
    check(again["stateRoot"] == result["stateRoot"] and again["id"] != original_id, "observation outside the state root")
    moved = copy.deepcopy(body)
    moved["state"]["heads"]["local"]["epoch"] = 77
    check(record.check_record(canon.encode(moved))["stateRoot"] != result["stateRoot"], "state change moves the root")

    # List bounds, checked on the parsed body directly (an over-long record may not fit 262,144 bytes).
    def bounded(path, row, count, where):
        mutated = copy.deepcopy(body)
        node, last = at_path(mutated, path)
        node[last] = [copy.deepcopy(row) for _ in range(count)]
        try:
            record.check_body(mutated)
            got = None
        except record.RecordRefused as refusal:
            got = (refusal.code, refusal.where)
        return got

    inv_row = body["state"]["inventory"][0]
    pend_row = body["state"]["pending"][0]
    ev_row = body["state"]["evidence"]["retention"][0]
    src_row = body["observation"]["sources"][0]
    for path, row, bound in ((INV, inv_row, 2048), (S + ["pending"], pend_row, 1024),
                             (S + ["evidence", "retention"], ev_row, 1024), (S + ["evidence", "receipts"], ev_row, 1024),
                             (S + ["evidence", "checkpoints"], ev_row, 1024), (OBS + ["sources"], src_row, 64),
                             (S + ["authorityRequired"], "OWNER_SESSION", 64), (S + ["compatibility", "unsupported"], "X", 64)):
        where = "body." + ".".join(str(p) for p in path)
        got = bounded(path, row, bound + 1, where)
        check(got == ("SCHEMA", where), "bound %s at %d: %r" % (where, bound + 1, got))
        got = bounded(path, row, bound, where)
        check(got is None or got[1] != where, "bound %s at %d is not the list's own refusal: %r" % (where, bound, got))

    # A parsed body handed in directly with a key that is not a str: SCHEMA, never a TypeError.
    for path in ([], ["state"], ["observation"]):
        mutated = copy.deepcopy(body)
        node = mutated
        for part in path:
            node = node[part]
        node[1] = 2
        where = ".".join(["body"] + path)
        try:
            record.check_body(mutated)
            got = None
        except record.RecordRefused as refusal:
            got = (refusal.code, refusal.where)
        except TypeError as crash:
            got = ("TypeError", str(crash))
        check(got == ("SCHEMA", where), "record key that is not a str at %s: %r" % (where, got))


EMITTED = set()
# Section 16, read off the table by hand, in table order (26 rows; the act door says 18 of them).
SECTION_16 = (
    "CAPSULE_BYTES_MISMATCH CAPSULE_SCHEMA_UNSUPPORTED CAPSULE_INCOMPLETE CAPSULE_PRODUCER_UNVERIFIED "
    "CAPSULE_CAPTURE_CHANGED CAPSULE_ACTION_ID_MISMATCH CAPSULE_LINEAGE_MISMATCH PROOF_INVALID PROOF_REPLAYED "
    "PROOF_SUPERSEDED CAPSULE_GENERATION_STALE CAPSULE_INSTANCE_REVOKED BODY_KEY_FORKED WRITER_LEASE_REQUIRED "
    "CAPSULE_INTENT_ALREADY_PLACED CAPSULE_ACTION_CONFLICT CAPSULE_POSITION_STALE CAPSULE_ACTION_UNKNOWN "
    "CAPSULE_ACTION_ABANDONED CAPSULE_ACTION_COMMITTED CAPSULE_INHERITED_LOCKED CAPSULE_GATE_DENIED CAPSULE_LEDGER_FULL "
    "CAPSULE_AUTHORITY_REQUIRED CAPSULE_OUTCOME_UNKNOWN DESTINATION_BEHIND"
).split()


def run_codes():
    """Section 16 is one closed table; the act door's rows are exactly its act-door rows."""
    check(record.CODES == tuple(SECTION_16) and len(record.CODES) == 26, "record.CODES is section 16, in order")
    check(len(act.ACT_DOOR_CODES) == 18 and len(set(act.ACT_DOOR_CODES)) == 18, "18 act-door codes, unique")
    start = record.CODES.index("CAPSULE_ACTION_ID_MISMATCH")
    check(act.ACT_DOOR_CODES == record.CODES[start: start + 18], "the act-door rows are rows 6 to 23 of the table")
    for code in ("CAPSULE_BYTES_MISMATCH", "CAPSULE_INCOMPLETE", "CAPSULE_AUTHORITY_REQUIRED", "CAPSULE_OUTCOME_UNKNOWN",
                 "DESTINATION_BEHIND", "CAPSULE_CAPTURE_CHANGED"):
        check(code not in act.ACT_DOOR_CODES, "%s is not said by the act door" % code)
    for code in record.AUTHORITY_REQUIRED + record.REASON:
        check(code not in record.CODES, "%s is closed where it is defined, not in section 16" % code)
    allowed = set(record.CODES) | set(canon.CLASSES) | {"SCHEMA"}
    check(EMITTED <= allowed, "every code the verifier reported is a class, SCHEMA or a section 16 row: %r"
          % sorted(EMITTED - allowed))
    check({"CAPSULE_BYTES_MISMATCH", "CAPSULE_SCHEMA_UNSUPPORTED", "CAPSULE_INCOMPLETE", "CAPSULE_PRODUCER_UNVERIFIED"}
          <= EMITTED, "the four verifier codes were each reported: %r" % sorted(EMITTED))


# --------------------------------------------------------------- act shapes
MIRROR = "3f2a9c1e-5b7d-4a60-8e1f-2c3b4a5d6e7f"


def valid_command():
    return {
        "schema": "aukora.act.v1",
        "lineageId": act.act_lineage_id(MIRROR),
        "seq": 1,
        "prev": "0" * 64,
        "intentId": "0123456789abcdef0123456789abcdef",
        "op": "ledger.note.append",
        "target": "test-ledger",
        "payloadHex": act.SAFE_PAYLOAD_HEX,
    }


def key_examples():
    doc = canon.read_harness_json(VECTORS_PATH)
    rows = dict((r["name"], r) for r in doc["rows"])
    key1 = rows["act-key-thumb"]["keyBase64url"]
    envelope = canon.parse(canon.row_input(rows["act-envelope-with-digest"]))
    return key1, envelope["nextKey"], envelope


def valid_envelope(command, key2, thumb1, verb="act"):
    return {
        "schema": "aukora.proof.v3",
        "verb": verb,
        "lineageId": command["lineageId"],
        "holderGeneration": 7,
        "leaseGeneration": 3,
        "actionId": act.command_id(canon.encode(command)),
        "signerThumb": thumb1,
        "nextKey": key2,
    }


def mutations_of(valid, path, rules, check_fn, label):
    for name, mutation, code, where in rules:
        value = copy.deepcopy(valid)
        mutation(value)
        try:
            check_fn(value)
            got = ("ok", None)
        except act.ShapeRefused as refusal:
            got = (refusal.code, refusal.where)
        check(got == (code, where), "%s mutation %s: %r" % (label, name, got))


def field_rules(path, cases):
    """cases: (field, bad value, rule name). Plus missing and extra field."""
    rules = []
    for field, bad, name in cases:
        rules.append((name, setv([field], bad), "SCHEMA", "%s.%s" % (path, field)))
    return rules


def run_act_shapes():
    key1, key2, vector_envelope = key_examples()
    thumb1 = act.key_thumb(key1)
    command = valid_command()
    check(shape_code(act.check_command, command) == "ok", "valid command")
    check(command["lineageId"] == vector_envelope["lineageId"], "lineage id agrees with the act rows")
    check(act.act_lineage_id(MIRROR) != act.act_lineage_id(MIRROR[:-1] + "e"), "another MIRROR lineage gives another act lineage")
    check(act.act_lineage_id(MIRROR) == canon.digest("aukora.act-lineage.v1", ('{"mirror":"%s","world":"node-main-v1"}'
                                                                                % MIRROR).encode()), "6.2 lineage digest")
    check(shape_code(act.act_lineage_id, MIRROR, "node-main-v1") == "ok", "the world is exactly node-main-v1")
    for name, mirror, world in (
        ("a non-string", 5, act.WORLD),
        ("a non-printable string", "bad\n", act.WORLD),
        ("no dashes", MIRROR.replace("-", ""), act.WORLD),
        ("uppercase", MIRROR.upper(), act.WORLD),
        ("one uppercase digit", MIRROR[:-1] + "F", act.WORLD),
        ("braces", "{" + MIRROR + "}", act.WORLD),
        ("a dash moved", MIRROR[:7] + "-" + MIRROR[7] + MIRROR[9:], act.WORLD),
        ("a group too long", MIRROR + "0", act.WORLD),
        ("a non-hex digit", "g" + MIRROR[1:], act.WORLD),
        ("a sixth group", MIRROR + "-0", act.WORLD),
        ("an empty string", "", act.WORLD),
        ("another world", MIRROR, "x61-other-v1"),
        ("a world that is not a string", MIRROR, None),
    ):
        check(shape_code(act.act_lineage_id, mirror, world) == "SCHEMA", "lineage from %s is SCHEMA" % name)

    command_rules = [
        ("missing field", delv(["op"]), "SCHEMA", "command.op"),
        ("extra field", setv(["note"], "x"), "SCHEMA", "command.note"),
        ("schema other", setv(["schema"], "aukora.act.v2"), "SCHEMA", "command.schema"),
        ("lineageId not hex64", setv(["lineageId"], "1" * 63), "SCHEMA", "command.lineageId"),
        ("seq 0", setv(["seq"], 0), "SCHEMA", "command.seq"),
        ("seq bool", setv(["seq"], True), "SCHEMA", "command.seq"),
        ("seq past the bound", setv(["seq"], 2 ** 53), "SCHEMA", "command.seq"),
        ("prev uppercase", setv(["prev"], "A" * 64), "SCHEMA", "command.prev"),
        ("intentId 31 hex", setv(["intentId"], "0" * 31), "SCHEMA", "command.intentId"),
        ("intentId uppercase", setv(["intentId"], "A" * 32), "SCHEMA", "command.intentId"),
        ("op empty", setv(["op"], ""), "SCHEMA", "command.op"),
        ("op 65 bytes", setv(["op"], "o" * 65), "SCHEMA", "command.op"),
        ("op with a space", setv(["op"], "ledger note"), "SCHEMA", "command.op"),
        ("target with a slash", setv(["target"], "test/ledger"), "SCHEMA", "command.target"),
        ("payloadHex odd length", setv(["payloadHex"], "abc"), "SCHEMA", "command.payloadHex"),
        ("payloadHex uppercase", setv(["payloadHex"], "AB"), "SCHEMA", "command.payloadHex"),
        ("payloadHex 514 digits", setv(["payloadHex"], "ab" * 257), "SCHEMA", "command.payloadHex"),
        ("payloadHex not a string", setv(["payloadHex"], 12), "SCHEMA", "command.payloadHex"),
        ("a key that is not a str", setv([1], 2), "SCHEMA", "command"),
    ]
    mutations_of(command, "command", command_rules, act.check_command, "command")
    edge = dict(command, op="o" * 64, payloadHex="ab" * 256)
    check(shape_code(act.check_command, edge) == "ok", "command at its bounds (op 64 bytes, payload 512 digits)")
    check(shape_code(act.check_command, dict(command, payloadHex="")) == "ok", "command with an empty payload")
    check(shape_code(act.check_command, [1]) == "SCHEMA", "a command that is not an object")

    # keys
    check(act.raw_key_bytes(key1) is not None and act.raw_key_bytes(key2) is not None, "example keys are curve points")
    raw = act.raw_key_bytes(key1)
    check(len(raw) == 65 and raw[0] == 4, "raw key is 0x04 || X || Y")
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    last = key1[-1]
    spare = alphabet[alphabet.index(last) | 1]  # same value with a spare bit set
    bad_keys = [
        ("padded", key1 + "="),
        ("86 chars", key1[:-1]),
        ("88 chars", key1 + "A"),
        ("standard alphabet", key1.replace("-", "+").replace("_", "/") if ("-" in key1 or "_" in key1) else "+" + key1[1:]),
        ("spare bit set", key1[:-1] + spare),
        ("not on the curve", key1[:-3] + ("A" if key1[-3] != "A" else "B") + key1[-2:]),
        ("not a string", 5),
    ]
    for name, bad in bad_keys:
        check(act.raw_key_bytes(bad) is None, "key spelling %s refused" % name)
        check(shape_code(act.key_thumb, bad) == "SCHEMA", "key thumb of %s refused" % name)
    check(act.key_thumb(key1) != act.key_thumb(key2), "two keys, two thumbs")

    # envelope
    envelope = valid_envelope(command, key2, thumb1)
    check(shape_code(act.check_envelope, envelope) == "ok", "valid envelope")
    check(same(envelope, vector_envelope), "the test's envelope is the vector row's envelope")
    env_bytes = canon.encode(envelope)
    message = act.envelope_signing_message(env_bytes)
    check(message == b"aukora.proof.v3\x00" + env_bytes, "signing message is the domain, 0x00, the envelope bytes")
    check(canon.sha256_raw(message) == act.envelope_digest(env_bytes), "sha256 of the signing message is the envelope digest")
    envelope_rules = [
        ("missing field", delv(["nextKey"]), "SCHEMA", "envelope.nextKey"),
        ("extra field: a time", setv(["atMs"], 1), "SCHEMA", "envelope.atMs"),
        ("extra field: a session", setv(["session"], "s"), "SCHEMA", "envelope.session"),
        ("schema other", setv(["schema"], "aukora.proof.v2"), "SCHEMA", "envelope.schema"),
        ("verb outside list", setv(["verb"], "reserve"), "SCHEMA", "envelope.verb"),
        ("lineageId not hex64", setv(["lineageId"], "x"), "SCHEMA", "envelope.lineageId"),
        ("holderGeneration negative", setv(["holderGeneration"], -1), "SCHEMA", "envelope.holderGeneration"),
        ("holderGeneration string", setv(["holderGeneration"], "7"), "SCHEMA", "envelope.holderGeneration"),
        ("leaseGeneration float-like bool", setv(["leaseGeneration"], False), "SCHEMA", "envelope.leaseGeneration"),
        ("actionId not hex64", setv(["actionId"], "a" * 65), "SCHEMA", "envelope.actionId"),
        ("signerThumb not hex64", setv(["signerThumb"], "T"), "SCHEMA", "envelope.signerThumb"),
        ("nextKey padded", setv(["nextKey"], key2 + "="), "SCHEMA", "envelope.nextKey"),
    ]
    mutations_of(envelope, "envelope", envelope_rules, act.check_envelope, "envelope")

    # request
    def request(cmd, env, signature="ab" * 64):
        return {"schema": "aukora.act-request.v1", "command": cmd, "envelope": env, "signature": signature}

    good = request(command, envelope)
    check(shape_code(act.check_request, good) == "ok", "valid act request")
    check(shape_code(act.check_request_bytes, canon.encode(good)) == "ok", "valid act request as bytes")
    intent = request(command, valid_envelope(command, key2, thumb1, "intent"))
    check(shape_code(act.check_request, intent) == "ok", "valid intent request")
    for verb in ("commit", "abandon"):
        check(shape_code(act.check_request, request(None, valid_envelope(command, key2, thumb1, verb))) == "ok",
              "valid %s request with a null command" % verb)
    other = dict(command, payloadHex=act.SAFE_PAYLOAD_HEX + "00")
    other_id = act.command_id(canon.encode(other))
    request_rules = [
        ("missing field", delv(["signature"]), "SCHEMA", "request.signature"),
        ("extra field", setv(["ownerApproved"], True), "SCHEMA", "request.ownerApproved"),
        ("schema other", setv(["schema"], "aukora.act-request.v2"), "SCHEMA", "request.schema"),
        ("signature 127 hex", setv(["signature"], "a" * 127), "SCHEMA", "request.signature"),
        ("signature uppercase", setv(["signature"], "A" * 128), "SCHEMA", "request.signature"),
        ("act without a command", setv(["command"], None), "SCHEMA", "request.command"),
        ("command broken", setv(["command", "seq"], 0), "SCHEMA", "request.command.seq"),
        ("envelope broken", setv(["envelope", "verb"], "go"), "SCHEMA", "request.envelope.verb"),
        ("stated id is the digest of other bytes", setv(["envelope", "actionId"], other_id), "CAPSULE_ACTION_ID_MISMATCH",
         "request.envelope.actionId"),
        ("command changed under its stated id", setv(["command", "payloadHex"], act.SAFE_PAYLOAD_HEX + "00"),
         "CAPSULE_ACTION_ID_MISMATCH", "request.envelope.actionId"),
        ("commit carrying a command", setv(["envelope", "verb"], "commit"), "SCHEMA", "request.command"),
        ("over 4,096 bytes, before any shape rule", both(setv(["signature"], "a" * 2048), setv(["pad"], "b" * 2048)),
         "LIMIT", 4096),
    ]
    mutations_of(good, "request", request_rules, act.check_request, "request")
    abandon = request(None, valid_envelope(command, key2, thumb1, "abandon"))
    abandon["command"] = command
    check(shape_code(act.check_request, abandon) == "SCHEMA", "abandon carrying a command")
    data = canon.encode(good)
    check(shape_code(act.check_request_bytes, data + b" ") == "SYNTAX", "request bytes with a trailing space")
    check(shape_code(act.check_request_bytes, b"{" + b" " * 4096) == "LIMIT", "request bytes past 4,096 before parsing")
    big = request(dict(command, payloadHex="ab" * 256), envelope)
    big["envelope"]["actionId"] = act.command_id(canon.encode(big["command"]))
    check(len(canon.encode(big)) <= 4096 and shape_code(act.check_request, big) == "ok",
          "a request with the largest payload fits 4,096 bytes")

    # gate inputs and output (section 8)
    proposal = {"verb": "act", "command": command}
    capability = {"holderGeneration": 7, "rowGeneration": None, "ownerBound": True, "budget": None}
    lease = {"held": True, "generation": 3}
    logical = {"seq": 0, "rows": 0}
    inputs = [proposal, capability, act.POLICY_V0, None, lease, logical]
    check(shape_code(act.check_gate_input, *inputs) == "ok", "valid gate input")
    check(act.POLICY_V0_DIGEST == canon.digest("aukora.capsule-policy.v0", canon.encode(act.POLICY_V0)), "policy digest")
    gate_rules = [
        (0, "proposal verb abandon (never gated)", setv(["verb"], "abandon"), "SCHEMA", "proposal.verb"),
        (0, "proposal extra field", setv(["note"], 1), "SCHEMA", "proposal.note"),
        (0, "proposal command broken", setv(["command", "op"], ""), "SCHEMA", "proposal.command.op"),
        (1, "capability rowGeneration negative", setv(["rowGeneration"], -1), "SCHEMA", "capability.rowGeneration"),
        (1, "capability ownerBound null", setv(["ownerBound"], None), "SCHEMA", "capability.ownerBound"),
        (1, "capability budget set", setv(["budget"], {"left": 1}), "SCHEMA", "capability.budget"),
        (1, "capability missing holderGeneration", delv(["holderGeneration"]), "SCHEMA", "capability.holderGeneration"),
        (2, "policy schema other", setv(["schema"], "aukora.capsule-policy.v1"), "SCHEMA", "policy.schema"),
        (2, "policy version negative", setv(["version"], -1), "SCHEMA", "policy.version"),
        (2, "policy rules not a list", setv(["rules"], {}), "SCHEMA", "policy.rules"),
        (2, "policy rule decision outside list", setv(["rules", 0, "decision"], "MAYBE"), "SCHEMA", "policy.rules[0].decision"),
        (2, "policy rule needsBudget not bool", setv(["rules", 0, "needsBudget"], 0), "SCHEMA", "policy.rules[0].needsBudget"),
        (2, "policy rule payload odd", setv(["rules", 0, "payloadHex"], "abc"), "SCHEMA", "policy.rules[0].payloadHex"),
        (2, "policy rule extra field", setv(["rules", 0, "prefix"], True), "SCHEMA", "policy.rules[0].prefix"),
        (4, "lease held not bool", setv(["held"], 1), "SCHEMA", "lease.held"),
        (4, "lease generation string", setv(["generation"], "3"), "SCHEMA", "lease.generation"),
        (4, "lease generation null (draft 6: an integer)", setv(["generation"], None), "SCHEMA", "lease.generation"),
        (5, "logicalTime a wall clock", setv(["atMs"], 1), "SCHEMA", "logicalTime.atMs"),
        (5, "logicalTime rows negative", setv(["rows"], -1), "SCHEMA", "logicalTime.rows"),
    ]
    for index, name, mutation, code, where in gate_rules:
        args = copy.deepcopy(inputs)
        mutation(args[index])
        try:
            act.check_gate_input(*args)
            got = ("ok", None)
        except act.ShapeRefused as refusal:
            got = (refusal.code, refusal.where)
        check(got == (code, where), "gate input %s: %r" % (name, got))
    args = copy.deepcopy(inputs)
    args[3] = {"verdict": "ALLOW"}
    check(shape_code(act.check_gate_input, *args) == "SCHEMA", "a court result is not accepted in this push")
    args = copy.deepcopy(inputs)
    args[0]["command"]["seq"] = 1.0
    check(shape_code(act.check_gate_input, *args) == "NUMBER", "a gate input that is not a canonical value")
    output = {"decision": "ALLOW", "reason": "POLICY_V0_RULE", "policyDigest": act.POLICY_V0_DIGEST}
    check(shape_code(act.check_gate_output, output) == "ok", "valid gate output")
    output_rules = [
        ("decision outside list", setv(["decision"], "PERMIT"), "SCHEMA", "result.decision"),
        ("reason lowercase", setv(["reason"], "allowed"), "SCHEMA", "result.reason"),
        ("policyDigest not hex64", setv(["policyDigest"], "x"), "SCHEMA", "result.policyDigest"),
        ("extra field", setv(["confidence"], 1), "SCHEMA", "result.confidence"),
        ("missing reason", delv(["reason"]), "SCHEMA", "result.reason"),
        ("a key that is not a str", setv([1], 2), "SCHEMA", "result"),
    ]
    mutations_of(output, "result", output_rules, act.check_gate_output, "gate output")
    run_answer_shapes(command, thumb1, act.key_thumb(key2), act.envelope_digest(env_bytes), output)
    run_gate_calls(command)


def run_answer_shapes(command, thumb1, thumb2, envelope_digest, verdict):
    """6.5a: one accepted example and one mutation per rule of each shape."""
    action_id = act.command_id(canon.encode(command))
    row = {"seq": 1, "actionId": action_id, "intentId": command["intentId"], "state": "committed", "command": command,
           "intentBy": {"keyThumb": thumb1, "holderGeneration": 7, "chainFirstThumb": thumb1},
           "resolvedBy": {"keyThumb": thumb1, "holderGeneration": 7}, "gate": {"creation": dict(verdict), "commit": dict(verdict)}}
    chain = {"firstThumb": thumb1, "currentThumb": thumb2, "lastDigest": envelope_digest, "locked": False}
    answer = {"schema": "aukora.act-answer.v1", "envelopeDigest": envelope_digest, "verified": True, "result": "committed",
              "code": None, "row": row, "head": {"seq": 1, "id": action_id}, "holderGeneration": 7,
              "holderKeyThumb": thumb1, "chain": chain}
    read = {"schema": "aukora.act-read.v1", "verb": "row", "actionId": action_id, "intentId": None}
    status = {"schema": "aukora.act-status.v1", "lineageId": command["lineageId"], "holderGeneration": 7,
              "holderKeyThumb": thumb1, "lease": {"held": True, "generation": 3},
              "chain": dict(chain, currentThumb=thumb1, lastDigest=None), "head": {"seq": 0, "id": "0" * 64},
              "pending": False}
    rowread = {"schema": "aukora.act-row.v1", "row": row}
    for name, value, fn in (("verdict", verdict, act.check_verdict), ("chain", chain, act.check_chain),
                            ("row", row, act.check_row), ("answer", answer, act.check_answer),
                            ("read", read, act.check_read), ("status", status, act.check_status),
                            ("rowread", rowread, act.check_row_read)):
        check(shape_code(fn, value) == "ok", "valid %s" % name)
        check(shape_code(fn, [value]) in ("SCHEMA", "TYPE"), "a %s that is not an object" % name)

    # verdict
    mutations_of(verdict, "verdict", [
        ("decision outside list", setv(["decision"], "PERMIT"), "SCHEMA", "verdict.decision"),
        ("reason not a code", setv(["reason"], "ok"), "SCHEMA", "verdict.reason"),
        ("policyDigest uppercase", setv(["policyDigest"], "A" * 64), "SCHEMA", "verdict.policyDigest"),
        ("extra field", setv(["confidence"], 9), "SCHEMA", "verdict.confidence"),
        ("missing decision", delv(["decision"]), "SCHEMA", "verdict.decision"),
    ], act.check_verdict, "verdict")
    # chain
    check(shape_code(act.check_chain, dict(chain, lastDigest=None)) == "ok", "a chain with nothing verified yet")
    mutations_of(chain, "chain", [
        ("firstThumb not hex64", setv(["firstThumb"], "t"), "SCHEMA", "chain.firstThumb"),
        ("currentThumb null", setv(["currentThumb"], None), "SCHEMA", "chain.currentThumb"),
        ("lastDigest 63 digits", setv(["lastDigest"], "a" * 63), "SCHEMA", "chain.lastDigest"),
        ("locked not a boolean", setv(["locked"], 0), "SCHEMA", "chain.locked"),
        ("locked null", setv(["locked"], None), "SCHEMA", "chain.locked"),
        ("extra field: burned", setv(["burned"], []), "SCHEMA", "chain.burned"),
        ("missing lastDigest", delv(["lastDigest"]), "SCHEMA", "chain.lastDigest"),
    ], act.check_chain, "chain")
    # row
    pending = dict(row, state="pending", resolvedBy=None, gate={"creation": verdict, "commit": None})
    check(shape_code(act.check_row, pending) == "ok", "a pending row with no resolver and no commit verdict")
    mutations_of(row, "row", [
        ("seq 0", setv(["seq"], 0), "SCHEMA", "row.seq"),
        ("actionId not hex64", setv(["actionId"], "x"), "SCHEMA", "row.actionId"),
        ("intentId 64 hex", setv(["intentId"], "a" * 64), "SCHEMA", "row.intentId"),
        ("state outside list", setv(["state"], "done"), "SCHEMA", "row.state"),
        ("state refused (an answer's result, not a row's)", setv(["state"], "refused"), "SCHEMA", "row.state"),
        ("command broken", setv(["command", "seq"], 0), "SCHEMA", "row.command.seq"),
        ("command null", setv(["command"], None), "SCHEMA", "row.command"),
        ("intentBy missing chainFirstThumb", delv(["intentBy", "chainFirstThumb"]), "SCHEMA", "row.intentBy.chainFirstThumb"),
        ("intentBy holderGeneration negative", setv(["intentBy", "holderGeneration"], -1), "SCHEMA",
         "row.intentBy.holderGeneration"),
        ("intentBy null", setv(["intentBy"], None), "SCHEMA", "row.intentBy"),
        ("resolvedBy extra field", setv(["resolvedBy", "chainFirstThumb"], thumb1), "SCHEMA", "row.resolvedBy.chainFirstThumb"),
        ("resolvedBy keyThumb not hex64", setv(["resolvedBy", "keyThumb"], "k"), "SCHEMA", "row.resolvedBy.keyThumb"),
        ("gate creation null", setv(["gate", "creation"], None), "SCHEMA", "row.gate.creation"),
        ("gate commit broken", setv(["gate", "commit", "decision"], "MAYBE"), "SCHEMA", "row.gate.commit.decision"),
        ("gate extra field", setv(["gate", "court"], None), "SCHEMA", "row.gate.court"),
        ("extra field: evicted", setv(["evicted"], False), "SCHEMA", "row.evicted"),
    ], act.check_row, "row")
    # answer: the code rule, both ways, then one mutation per field rule
    rows_by_state = {"pending": pending, "committed": row, "abandoned": dict(pending, state="abandoned",
                                                                             resolvedBy=row["resolvedBy"])}
    for result in ("pending", "committed", "abandoned"):
        check(shape_code(act.check_answer, dict(answer, result=result, row=rows_by_state[result])) == "ok",
              "answer %s with a null code" % result)
        check(shape_code(act.check_answer, dict(answer, result=result, row=rows_by_state[result],
                                                code="CAPSULE_GATE_DENIED")) == "SCHEMA",
              "answer %s with a code" % result)
    no_state = dict(head=None, holderGeneration=None, holderKeyThumb=None, chain=None)
    for code in act.ACT_DOOR_CODES:
        refused = dict(answer, result="refused", code=code, row=None)
        if code in act.NO_STATE_CODES:  # ruling 9: steps 1 and 2 read no state
            refused.update(no_state)
        check(shape_code(act.check_answer, refused) == "ok", "answer refused with act-door code %s" % code)
    for code in [c for c in record.CODES if c not in act.ACT_DOOR_CODES] + ["SCHEMA", "LIMIT", "CAPSULE_SOMETHING"]:
        check(shape_code(act.check_answer, dict(answer, result="refused", code=code, row=None)) == "SCHEMA",
              "answer refused with %s, not an act-door row" % code)
    mutations_of(answer, "answer", [
        ("schema other", setv(["schema"], "aukora.act-answer.v2"), "SCHEMA", "answer.schema"),
        ("envelopeDigest not hex64", setv(["envelopeDigest"], "d"), "SCHEMA", "answer.envelopeDigest"),
        ("verified not a boolean", setv(["verified"], "true"), "SCHEMA", "answer.verified"),
        ("result outside list", setv(["result"], "done"), "SCHEMA", "answer.result"),
        ("refused with a null code", setv(["result"], "refused"), "SCHEMA", "answer.code"),
        ("refused with a code outside the act-door rows", both(setv(["result"], "refused"),
                                                                 setv(["code"], "DESTINATION_BEHIND")),
         "SCHEMA", "answer.code"),
        ("committed with a code", setv(["code"], "WRITER_LEASE_REQUIRED"), "SCHEMA", "answer.code"),
        ("row broken", setv(["row", "state"], "x"), "SCHEMA", "answer.row.state"),
        ("head seq negative", setv(["head", "seq"], -1), "SCHEMA", "answer.head.seq"),
        ("head id null", setv(["head", "id"], None), "SCHEMA", "answer.head.id"),
        ("head extra field", setv(["head", "rows"], 1), "SCHEMA", "answer.head.rows"),
        ("holderGeneration null", setv(["holderGeneration"], None), "SCHEMA", "answer.holderGeneration"),
        ("holderKeyThumb not hex64", setv(["holderKeyThumb"], "h"), "SCHEMA", "answer.holderKeyThumb"),
        ("chain null", setv(["chain"], None), "SCHEMA", "answer.chain"),
        ("chain broken", setv(["chain", "locked"], "no"), "SCHEMA", "answer.chain.locked"),
        ("extra field: a session", setv(["session"], "s"), "SCHEMA", "answer.session"),
        ("missing verified", delv(["verified"]), "SCHEMA", "answer.verified"),
        ("not a canonical value", setv(["holderGeneration"], 7.0), "NUMBER", None),
    ], act.check_answer, "answer")
    check(shape_code(act.check_answer, dict(answer, result="refused", code="CAPSULE_INSTANCE_REVOKED", row=None,
                                            holderKeyThumb=None, chain=None)) == "ok",
          "an answer of a world with no holder (ruling 9)")
    # read: the one-of rule, then the rest
    for verb in ("status", "pending"):
        check(shape_code(act.check_read, dict(read, verb=verb, actionId=None)) == "ok", "read %s with both ids null" % verb)
    check(shape_code(act.check_read, dict(read, actionId=None, intentId=command["intentId"])) == "ok", "read row by intent id")
    mutations_of(read, "read", [
        ("row with both ids", setv(["intentId"], command["intentId"]), "SCHEMA", "read.actionId"),
        ("row with neither id", setv(["actionId"], None), "SCHEMA", "read.actionId"),
        ("row actionId 32 hex (an intent id)", setv(["actionId"], command["intentId"]), "SCHEMA", "read.actionId"),
        ("row intentId 64 hex (an action id)", both(setv(["actionId"], None), setv(["intentId"], action_id)), "SCHEMA",
         "read.intentId"),
        ("status with an actionId", setv(["verb"], "status"), "SCHEMA", "read.actionId"),
        ("pending with an intentId", both(setv(["verb"], "pending"), setv(["actionId"], None),
                                          setv(["intentId"], command["intentId"])), "SCHEMA", "read.intentId"),
        ("verb outside list", setv(["verb"], "head"), "SCHEMA", "read.verb"),
        ("schema other", setv(["schema"], "aukora.act-row.v1"), "SCHEMA", "read.schema"),
        ("extra field: an envelope", setv(["envelope"], None), "SCHEMA", "read.envelope"),
        ("missing intentId", delv(["intentId"]), "SCHEMA", "read.intentId"),
    ], act.check_read, "read")
    # status
    mutations_of(status, "status", [
        ("schema other", setv(["schema"], "aukora.act-answer.v1"), "SCHEMA", "status.schema"),
        ("lineageId null", setv(["lineageId"], None), "SCHEMA", "status.lineageId"),
        ("holderGeneration negative", setv(["holderGeneration"], -1), "SCHEMA", "status.holderGeneration"),
        ("holderKeyThumb not hex64", setv(["holderKeyThumb"], "z" * 64), "SCHEMA", "status.holderKeyThumb"),
        ("lease null", setv(["lease"], None), "SCHEMA", "status.lease"),
        ("lease generation null", setv(["lease", "generation"], None), "SCHEMA", "status.lease.generation"),
        ("lease with an id (a bearer)", setv(["lease", "id"], "l"), "SCHEMA", "status.lease.id"),
        ("chain lastDigest not hex64", setv(["chain", "lastDigest"], ""), "SCHEMA", "status.chain.lastDigest"),
        ("head seq a string", setv(["head", "seq"], "0"), "SCHEMA", "status.head.seq"),
        ("pending null", setv(["pending"], None), "SCHEMA", "status.pending"),
        ("pending a count", setv(["pending"], 1), "SCHEMA", "status.pending"),
        ("extra field: lastAnswer", setv(["lastAnswer"], None), "SCHEMA", "status.lastAnswer"),
    ], act.check_status, "status")
    check(shape_code(act.check_status, dict(status, holderKeyThumb=None, chain=None)) == "ok",
          "a status of a world with no holder (ruling 9)")
    # rowread
    check(shape_code(act.check_row_read, dict(rowread, row=None)) == "ok", "a rowread of none")
    check(shape_code(act.check_row_read, dict(rowread, row=pending)) == "ok", "a rowread of a pending row")
    mutations_of(rowread, "rowread", [
        ("schema other", setv(["schema"], "aukora.act-read.v1"), "SCHEMA", "rowread.schema"),
        ("row broken", setv(["row", "seq"], 0), "SCHEMA", "rowread.row.seq"),
        ("row the string none", setv(["row"], "none"), "SCHEMA", "rowread.row"),
        ("extra field", setv(["verb"], "row"), "SCHEMA", "rowread.verb"),
        ("missing row", delv(["row"]), "SCHEMA", "rowread.row"),
    ], act.check_row_read, "rowread")


def run_gate_calls(command):
    """Section 8, the two calls and their inputs."""
    creation = {"proposal": {"verb": "intent", "command": command},
                "capability": {"holderGeneration": 7, "rowGeneration": None, "ownerBound": True, "budget": None},
                "policy": act.POLICY_V0, "courtResult": None, "lease": {"held": True, "generation": 3},
                "logicalTime": {"seq": 0, "rows": 0}}
    commit = copy.deepcopy(creation)
    commit["proposal"]["verb"] = "commit"
    commit["capability"]["rowGeneration"] = 7
    commit["logicalTime"]["rows"] = 1
    check(shape_code(act.check_gate_inputs, creation, "creation") == "ok", "gate inputs at creation (intent)")
    check(shape_code(act.check_gate_inputs, dict(creation, proposal={"verb": "act", "command": command}), "creation") == "ok",
          "gate inputs at creation (act)")
    check(shape_code(act.check_gate_inputs, commit, "commit") == "ok", "gate inputs at commit")
    check(shape_code(act.check_gate_inputs, dict(creation, capability=dict(creation["capability"], ownerBound=False)),
                     "creation") == "ok", "ownerBound false is a boolean (the gate decides on it, not the shape)")
    check(shape_code(act.check_gate_inputs, creation, "commit") == "SCHEMA", "creation inputs at the commit call")
    check(shape_code(act.check_gate_inputs, commit, "creation") == "SCHEMA", "commit inputs at the creation call")
    for call in ("intent", "Creation", None, ""):
        check(shape_code(act.check_gate_inputs, creation, call) == "SCHEMA", "gate call %r is not a call" % (call,))
    check(shape_code(act.check_gate_inputs, [creation], "creation") == "TYPE", "inputs that are not an object")
    rules = [
        ("creation", creation, "verb commit", setv(["proposal", "verb"], "commit"), "inputs.proposal.verb"),
        ("creation", creation, "verb abandon", setv(["proposal", "verb"], "abandon"), "inputs.proposal.verb"),
        ("creation", creation, "rowGeneration set", setv(["capability", "rowGeneration"], 7), "inputs.capability.rowGeneration"),
        ("commit", commit, "verb act", setv(["proposal", "verb"], "act"), "inputs.proposal.verb"),
        ("commit", commit, "verb intent", setv(["proposal", "verb"], "intent"), "inputs.proposal.verb"),
        ("commit", commit, "rowGeneration null", setv(["capability", "rowGeneration"], None), "inputs.capability.rowGeneration"),
        ("commit", commit, "rowGeneration a string", setv(["capability", "rowGeneration"], "7"), "inputs.capability.rowGeneration"),
    ]
    for call, base, mutation_name, mutation, where in rules:
        mutations_of(base, "inputs", [(mutation_name, mutation, "SCHEMA", where)],
                     lambda v, call=call: act.check_gate_inputs(v, call), "gate %s call" % call)
    for call, base in (("creation", creation), ("commit", commit)):
        mutations_of(base, "inputs", [
            ("courtResult set", setv(["courtResult"], {"verdict": "ALLOW"}), "SCHEMA", "inputs.courtResult"),
            ("courtResult false", setv(["courtResult"], False), "SCHEMA", "inputs.courtResult"),
            ("ownerBound null", setv(["capability", "ownerBound"], None), "SCHEMA", "inputs.capability.ownerBound"),
            ("ownerBound a string", setv(["capability", "ownerBound"], "true"), "SCHEMA", "inputs.capability.ownerBound"),
            ("lease generation null", setv(["lease", "generation"], None), "SCHEMA", "inputs.lease.generation"),
            ("lease held null", setv(["lease", "held"], None), "SCHEMA", "inputs.lease.held"),
            ("lease null", setv(["lease"], None), "SCHEMA", "inputs.lease"),
            ("missing logicalTime", delv(["logicalTime"]), "SCHEMA", "inputs.logicalTime"),
            ("extra input: a clock", setv(["clock"], 1), "SCHEMA", "inputs.clock"),
            ("budget set", setv(["capability", "budget"], 5), "SCHEMA", "inputs.capability.budget"),
            ("policy broken", setv(["policy", "version"], -1), "SCHEMA", "inputs.policy.version"),
            ("command broken", setv(["proposal", "command", "op"], ""), "SCHEMA", "inputs.proposal.command.op"),
            ("not a canonical value", setv(["logicalTime", "seq"], 0.5), "NUMBER", None),
        ], lambda v, call=call: act.check_gate_inputs(v, call), "gate %s inputs" % call)


# ------------------------------------------------------ draft 7, the rulings
def ruled(number, rule, ok, detail):
    check(ok, "ruling %d %s: %s" % (number, rule, detail))


def run_rulings_7():
    """Draft 7's rulings: each ruling as its named rule (record.RULES and act.RULES),
    with accepted and refused cases. Labels read "ruling N <rule>: ..."."""
    named = set((n, r) for n, r, _ in record.RULES) | set((n, r) for n, r, _ in act.RULES)
    check(set(n for n, _ in named) == set(range(2, 14)), "rulings 2 to 13 each carried by a named rule: %r" % sorted(named))
    for module in (record, act):
        for _, rule, holder in module.RULES:
            check(callable(getattr(module, holder, None)), "rule %s is held by %s" % (rule, holder))

    # 1. A runner ignores row members it does not know.
    anchor = "1764c8c6824016513eebf3e13a6b5672a193c2fcc861d2d261eb2224636c5691"
    known = {"name", "inputHex", "inputGen", "verdict", "digests", "class", "at", "presentedIdHex", "idCheck"}
    for row in (
        {"name": "r1-ok", "inputHex": "7b7d", "verdict": "ok", "digests": {"aukora.capsule.v1": anchor},
         "laneNote": {"shape": "anything", "verdict": "no"}},
        {"name": "r1-no", "inputHex": "5b5d", "verdict": "no", "class": "TYPE", "at": 0, "shapeVerdict": "ok", "x": None},
    ):
        ruled(1, "runner-ignores-unknown-members", canon.check_vector_row(row) is None, row["name"])
    doc_rows = dict((r["name"], r) for r in canon.read_harness_json(VECTORS_PATH)["rows"])
    r1 = doc_rows.get("runner-ignores-unknown-members", {})
    ruled(1, "runner-ignores-unknown-members", bool(set(r1) - known - {"note", "rulings"}) and
          canon.check_vector_row(r1) is None, "the vector row carries a member the runner does not know")

    # Record rulings (2 to 6) on the fixture.
    fixture = canon.read_harness_json(HERE + "/capsule_record_fixture_py.json")
    body = canon.parse(bytes.fromhex(fixture["bodyHex"]))
    label = {"code": "CAPSULE_PRODUCER_UNVERIFIED", "where": None}

    def rec(*runs):
        mutated = copy.deepcopy(body)
        for r in runs:
            r(mutated)
        got = record.check_record(canon.encode(mutated))
        EMITTED.update(p["code"] for p in got["problems"])
        return got

    def refused_at(got, where):
        return not got["ok"] and got["problems"][:1] == [{"code": "SCHEMA", "where": where}]

    def accepted(got):
        return got["ok"] and got["complete"] and got["problems"] == [label]

    ev = S + ["evidence"]
    for own, scope in record.EVIDENCE_SCOPE:
        for other, other_scope in record.EVIDENCE_SCOPE:
            got = rec(setv(ev + [own, 0, "scope"], other_scope))
            if own == other:
                ruled(2, "evidence-scope-own-list", accepted(got), "%s takes %s" % (own, scope))
            else:
                ruled(2, "evidence-scope-own-list", refused_at(got, "body.state.evidence.%s[0].scope" % own),
                      "%s row with %s's scope: %r" % (own, other, got["problems"][:1]))

    def incomplete_wheres(got):
        return sorted(p["where"] for p in got["problems"] if p["code"] == "CAPSULE_INCOMPLETE")

    for name, runs, wheres in (
        ("a failed source naming two nulls", (setv(S + ["producer", "sourceRevision"], None), fail_source("producer")),
         ["source:producer"]),
        ("a failed source naming one null", (fail_source("memory"),), ["source:memory"]),
        ("a failed source naming no null", (fail_source("head.local"),), ["source:head.local"]),
        ("two failed sources", (fail_source("memory"), fail_source("head.published")), ["source:head.published", "source:memory"]),
    ):
        got = rec(*runs)
        ruled(3, "failed-source-once-per-row", got["ok"] and not got["complete"] and incomplete_wheres(got) == wheres,
              "%s: %r" % (name, incomplete_wheres(got)))
    got = rec(setv(S + ["producer", "sourceRevision"], None))
    ruled(3, "failed-source-once-per-row", accepted(got), "a null whose source read nothing is complete")

    for name, runs, expect in (
        ("file: with a 128-character path", (setv(INV + [0, "id"], "file:" + "p" * 128),), None),
        ("organ: with a 128-character id", (setv(INV + [4, "id"], "organ:" + "o" * 128),), None),
        ("file: with a 1-character path", (setv(INV + [0, "id"], "file:a"),), None),
        ("file: with a 129-character path", (setv(INV + [0, "id"], "file:" + "p" * 129),), "body.state.inventory[0].id"),
        ("organ: with a 129-character id", (setv(INV + [4, "id"], "organ:" + "o" * 129),), "body.state.inventory[4].id"),
        ("file: with nothing after it", (setv(INV + [0, "id"], "file:"),), "body.state.inventory[0].id"),
        ("module: with 65 hex digits", (setv(INV + [3, "id"], "module:" + "a" * 65),), "body.state.inventory[3].id"),
    ):
        got = rec(*runs)
        ok = accepted(got) if expect is None else refused_at(got, expect)
        ruled(4, "inventory-id-rest-1-to-128", ok, "%s: %r" % (name, got["problems"][:1]))
    for index, kind, expect in (
        (4, "file", False), (4, "module", False), (4, "other", False), (4, "organ-entry", True),
        (3, "file", False), (3, "organ-entry", False), (3, "module", True),
        (0, "organ-entry", False), (0, "module", False), (0, "file", True), (0, "log", True), (0, "root", True),
        (0, "other", True),
    ):
        got = rec(setv(INV + [index, "kind"], kind))
        where = "body.state.inventory[%d].kind" % index
        ok = accepted(got) if expect else refused_at(got, where)
        ruled(4, "inventory-id-form-fixes-kind", ok, "%s with kind %s: %r" % (body["state"]["inventory"][index]["id"], kind,
                                                                           got["problems"][:1]))

    # The five constants, typed here by hand from ruling 5.
    reasons = {"ownerBinding": "EXCLUDED_AUTHORITY", "messages": "EXCLUDED_PRIVATE", "turnJournal": "EXCLUDED_PRIVATE",
               "providerBudget": "EXCLUDED_HOST_SPECIFIC", "headHistory": "EXCLUDED_NOT_PORTABLE"}
    ruled(5, "always-excluded-rows-are-constants", record.EXCLUDED_REASON == reasons, "the reason table")
    index_of = dict((r["id"], i) for i, r in enumerate(body["state"]["inventory"]))
    for name in sorted(reasons):
        i = index_of[name]
        p = INV + [i]
        ruled(5, "always-excluded-rows-are-constants", body["state"]["inventory"][i] == record.excluded_row(name),
              "the fixture's %s row is the constant" % name)
        for field, runs in (
            ("kind", (setv(p + ["kind"], "log"),)),
            ("byteLength", (setv(p + ["byteLength"], 0),)),
            ("digest", (setv(p + ["digest"], "mind@3"), setv(p + ["digestKind"], "native-id"))),
            ("disposition", (setv(p + ["disposition"], "unknown"), setv(p + ["reason"], "UNKNOWN_NO_SOURCE"))),
            ("reason", (setv(p + ["reason"], [r for r in record.REASON if r.startswith("EXCLUDED_") and r != reasons[name]][0]),)),
        ):
            got = rec(*runs)
            ruled(5, "always-excluded-rows-are-constants", refused_at(got, "body.state.inventory[%d].%s" % (i, field)),
                  "%s with another %s: %r" % (name, field, got["problems"][:1]))
    for name, reason in (("providerBudget", "EXCLUDED_SECRET"), ("messages", "EXCLUDED_NOT_PORTABLE"),
                         ("ownerBinding", "EXCLUDED_PRIVATE")):
        got = rec(setv(INV + [index_of[name], "reason"], reason))
        ruled(5, "always-excluded-rows-are-constants", refused_at(got, "body.state.inventory[%d].reason" % index_of[name]),
              "%s with %s" % (name, reason))
    got = rec(drop_inventory("providerBudget"))
    ruled(5, "always-excluded-rows-are-constants", got["ok"] and incomplete_wheres(got) == ["inventory:providerBudget"],
          "a record without one of the five is incomplete, as before")

    for name, codes, ok in (
        ("the three", ["OWNER_APPROVED_MOVE", "OWNER_SESSION", "WRITER_LEASE"], True),
        ("none", [], False),
        ("two of three", ["OWNER_SESSION", "WRITER_LEASE"], False),
        ("one", ["OWNER_APPROVED_MOVE"], False),
    ):
        got = rec(setv(S + ["authorityRequired"], codes))
        ruled(6, "authority-required-exactly-three", accepted(got) if ok else refused_at(got, "body.state.authorityRequired"),
              "%s: %r" % (name, got["problems"][:1]))

    # 7. The mirror id: version and variant digits are not checked.
    for mirror in ("00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff",
                   "3f2a9c1e-5b7d-9a60-0e1f-2c3b4a5d6e7f"):
        ruled(7, "mirror-id-dashed-lowercase-hex", shape_code(act.act_lineage_id, mirror) == "ok", mirror)
    for mirror in ("00000000-0000-0000-0000-00000000000G", "00000000000000000000000000000000",
                   "00000000-0000-0000-0000-00000000000A"):
        ruled(7, "mirror-id-dashed-lowercase-hex", shape_code(act.act_lineage_id, mirror) == "SCHEMA", mirror)

    # 8. A request that does not parse is refused with its class and position: no act answer.
    for data, code, at in ((b'{"command":null', "SYNTAX", 15), (b'{"schema":1} ', "SYNTAX", 12), (b"", "TYPE", 0),
                           (b'{"b":1,"a":1}', "KEY_ORDER", 7)):
        try:
            act.check_request_bytes(data)
            got = ("ok", None)
        except act.ShapeRefused as refusal:
            got = (refusal.code, refusal.where)
        ruled(8, "unparsed-request-is-a-class-not-an-answer", got == (code, at), "%r: %r" % (data, got))

    # Act rulings (9 to 13).
    key1, key2, _ = key_examples()
    thumb1, thumb2 = act.key_thumb(key1), act.key_thumb(key2)
    command = valid_command()
    action_id = act.command_id(canon.encode(command))
    allow = {"decision": "ALLOW", "reason": "POLICY_V0_RULE", "policyDigest": act.POLICY_V0_DIGEST}
    by = {"keyThumb": thumb1, "holderGeneration": 7}
    pending = {"seq": 1, "actionId": action_id, "intentId": command["intentId"], "state": "pending", "command": command,
               "intentBy": dict(by, chainFirstThumb=thumb1), "resolvedBy": None,
               "gate": {"creation": dict(allow), "commit": None}}
    committed = dict(pending, state="committed", resolvedBy=dict(by), gate={"creation": dict(allow), "commit": dict(allow)})
    abandoned = dict(pending, state="abandoned", resolvedBy=dict(by))
    chain = {"firstThumb": thumb1, "currentThumb": thumb2, "lastDigest": "d" * 64, "locked": False}
    answer = {"schema": "aukora.act-answer.v1", "envelopeDigest": "e" * 64, "verified": True, "result": "committed",
              "code": None, "row": committed, "head": {"seq": 1, "id": action_id}, "holderGeneration": 7,
              "holderKeyThumb": thumb1, "chain": chain}
    status = {"schema": "aukora.act-status.v1", "lineageId": command["lineageId"], "holderGeneration": 7,
              "holderKeyThumb": thumb1, "lease": {"held": False, "generation": 4}, "chain": chain,
              "head": {"seq": 1, "id": action_id}, "pending": False}

    def refusal(code, **more):
        out = dict(answer, result="refused", code=code, row=None, verified=False)
        out.update(more)
        return out

    def where(fn, value):
        try:
            fn(value)
            return "ok"
        except act.ShapeRefused as refused:
            return "%s %s" % (refused.code, refused.where)

    none4 = dict(head=None, holderGeneration=None, holderKeyThumb=None, chain=None)
    no_holder = dict(holderKeyThumb=None, chain=None)
    cases9 = [
        ("answer-state-null-only-at-steps-1-2", refusal("CAPSULE_ACTION_ID_MISMATCH", **none4), "ok"),
        ("answer-state-null-only-at-steps-1-2", refusal("CAPSULE_LINEAGE_MISMATCH", **none4), "ok"),
        ("answer-state-null-only-at-steps-1-2", refusal("CAPSULE_ACTION_ID_MISMATCH"), "SCHEMA answer.head"),
        ("answer-state-null-only-at-steps-1-2", refusal("CAPSULE_LINEAGE_MISMATCH", **dict(none4, chain=chain)),
         "SCHEMA answer.chain"),
        ("answer-state-null-only-at-steps-1-2", refusal("CAPSULE_ACTION_ID_MISMATCH", **dict(none4, holderGeneration=7)),
         "SCHEMA answer.holderGeneration"),
        ("answer-state-null-only-at-steps-1-2", refusal("CAPSULE_LINEAGE_MISMATCH", **dict(none4, holderKeyThumb=thumb1)),
         "SCHEMA answer.holderKeyThumb"),
        ("answer-state-null-only-at-steps-1-2", refusal("WRITER_LEASE_REQUIRED", **none4), "SCHEMA answer.head"),
        ("answer-state-null-only-at-steps-1-2", refusal("PROOF_INVALID", **none4), "SCHEMA answer.head"),
        ("answer-no-holder-only-instance-revoked", refusal("CAPSULE_INSTANCE_REVOKED", **no_holder), "ok"),
        ("answer-no-holder-only-instance-revoked", refusal("CAPSULE_INSTANCE_REVOKED"), "ok"),
        ("answer-no-holder-only-instance-revoked", refusal("CAPSULE_INSTANCE_REVOKED", **dict(no_holder, head=None)),
         "SCHEMA answer.head"),
        ("answer-no-holder-only-instance-revoked",
         refusal("CAPSULE_INSTANCE_REVOKED", **dict(no_holder, holderGeneration=None)), "SCHEMA answer.holderGeneration"),
        ("answer-no-holder-only-instance-revoked", refusal("WRITER_LEASE_REQUIRED", **no_holder),
         "SCHEMA answer.holderKeyThumb"),
        ("answer-no-holder-only-instance-revoked", refusal("BODY_KEY_FORKED", **no_holder), "SCHEMA answer.holderKeyThumb"),
        ("answer-no-holder-only-instance-revoked", dict(answer, **no_holder), "SCHEMA answer.holderKeyThumb"),
        ("holder-thumb-null-exactly-when-chain-null", refusal("CAPSULE_INSTANCE_REVOKED", holderKeyThumb=None),
         "SCHEMA answer.holderKeyThumb"),
        ("holder-thumb-null-exactly-when-chain-null", refusal("CAPSULE_INSTANCE_REVOKED", chain=None), "SCHEMA answer.chain"),
        ("holder-thumb-null-exactly-when-chain-null", dict(answer, chain=None), "SCHEMA answer.chain"),
    ]
    for rule, value, expect in cases9:
        got = where(act.check_answer, value)
        ruled(9, rule, got == expect, "answer %s %s: %s" % (value["result"], value["code"], got))
    for name, value, expect in (
        ("a world with no holder", dict(status, **no_holder), "ok"),
        ("a held world", status, "ok"),
        ("thumb null, chain present", dict(status, holderKeyThumb=None), "SCHEMA status.holderKeyThumb"),
        ("thumb present, chain null", dict(status, chain=None), "SCHEMA status.chain"),
        ("head null", dict(status, head=None), "SCHEMA status.head"),
        ("holderGeneration null", dict(status, holderGeneration=None), "SCHEMA status.holderGeneration"),
    ):
        got = where(act.check_status, value)
        ruled(9, "holder-thumb-null-exactly-when-chain-null", got == expect, "status, %s: %s" % (name, got))
    for name, lease, expect in (
        ("held false, generation 4", {"held": False, "generation": 4}, "ok"),
        ("held false, generation 0", {"held": False, "generation": 0}, "ok"),
        ("held false, generation null", {"held": False, "generation": None}, "SCHEMA status.lease.generation"),
        ("held true, generation -1", {"held": True, "generation": -1}, "SCHEMA status.lease.generation"),
    ):
        got = where(act.check_status, dict(status, lease=lease))
        ruled(9, "lease-generation-an-integer", got == expect, "%s: %s" % (name, got))

    other_command = dict(command, payloadHex=command["payloadHex"] + "00")
    deny = dict(allow, decision="DENY", reason="POLICY_NO_RULE")
    escalate = dict(allow, decision="ESCALATE", reason="POLICY_ESCALATE")
    cases10 = [
        (10, "row-resolved-by-null-exactly-when-pending", pending, "ok"),
        (10, "row-resolved-by-null-exactly-when-pending", committed, "ok"),
        (10, "row-resolved-by-null-exactly-when-pending", abandoned, "ok"),
        (10, "row-resolved-by-null-exactly-when-pending", dict(pending, resolvedBy=dict(by)), "SCHEMA row.resolvedBy"),
        (10, "row-resolved-by-null-exactly-when-pending", dict(committed, resolvedBy=None), "SCHEMA row.resolvedBy"),
        (10, "row-resolved-by-null-exactly-when-pending", dict(abandoned, resolvedBy=None), "SCHEMA row.resolvedBy"),
        (10, "row-commit-verdict-exactly-when-committed", dict(committed, gate={"creation": allow, "commit": None}),
         "SCHEMA row.gate.commit"),
        (10, "row-commit-verdict-exactly-when-committed", dict(pending, gate={"creation": allow, "commit": allow}),
         "SCHEMA row.gate.commit"),
        (10, "row-commit-verdict-exactly-when-committed", dict(abandoned, gate={"creation": allow, "commit": allow}),
         "SCHEMA row.gate.commit"),
        (10, "row-action-id-is-command-digest", dict(pending, actionId=act.command_id(canon.encode(other_command))),
         "SCHEMA row.actionId"),
        (10, "row-action-id-is-command-digest", dict(pending, command=other_command), "SCHEMA row.actionId"),
        (10, "row-seq-and-intent-id-are-the-command-s", dict(pending, seq=2), "SCHEMA row.seq"),
        (10, "row-seq-and-intent-id-are-the-command-s", dict(pending, intentId="f" * 32), "SCHEMA row.intentId"),
        (12, "stored-commit-verdict-is-allow", dict(committed, gate={"creation": allow, "commit": deny}),
         "SCHEMA row.gate.commit.decision"),
        (12, "stored-commit-verdict-is-allow", dict(committed, gate={"creation": allow, "commit": escalate}),
         "SCHEMA row.gate.commit.decision"),
        (12, "stored-commit-verdict-is-allow", dict(committed, gate={"creation": escalate, "commit": allow}), "ok"),
        (12, "stored-commit-verdict-is-allow", dict(pending, gate={"creation": escalate, "commit": None}), "ok"),
    ]
    for number, rule, value, expect in cases10:
        got = where(act.check_row, value)
        ruled(number, rule, got == expect, "row %s: %s" % (value["state"], got))
    got = where(act.check_row_read, {"schema": "aukora.act-row.v1", "row": dict(pending, seq=2)})
    ruled(10, "row-seq-and-intent-id-are-the-command-s", got == "SCHEMA rowread.row.seq", "inside a rowread: %s" % got)

    cases11 = [
        ("answer-row-present-with-result-state", dict(answer, result="pending", row=pending), "ok"),
        ("answer-row-present-with-result-state", dict(answer, result="abandoned", row=abandoned), "ok"),
        ("answer-row-present-with-result-state", dict(answer, row=None), "SCHEMA answer.row"),
        ("answer-row-present-with-result-state", dict(answer, result="pending", row=None), "SCHEMA answer.row"),
        ("answer-row-present-with-result-state", dict(answer, result="pending", row=committed), "SCHEMA answer.row.state"),
        ("answer-row-present-with-result-state", dict(answer, result="abandoned", row=pending), "SCHEMA answer.row.state"),
        ("answer-row-present-with-result-state", dict(answer, row=abandoned), "SCHEMA answer.row.state"),
        ("answer-row-null-at-steps-1-2", refusal("CAPSULE_ACTION_CONFLICT", row=pending), "ok"),
        ("answer-row-null-at-steps-1-2", refusal("CAPSULE_ACTION_COMMITTED", row=committed), "ok"),
        ("answer-row-null-at-steps-1-2", refusal("CAPSULE_GATE_DENIED", row=None), "ok"),
        ("answer-row-null-at-steps-1-2", refusal("CAPSULE_LINEAGE_MISMATCH", **dict(none4, row=pending)), "SCHEMA answer.row"),
        ("answer-row-null-at-steps-1-2", refusal("CAPSULE_ACTION_ID_MISMATCH", **dict(none4, row=committed)),
         "SCHEMA answer.row"),
    ]
    for rule, value, expect in cases11:
        got = where(act.check_answer, value)
        ruled(11, rule, got == expect, "answer %s %s: %s" % (value["result"], value["code"], got))

    gate = {"proposal": {"verb": "commit", "command": command},
            "capability": {"holderGeneration": 7, "rowGeneration": 7, "ownerBound": True, "budget": None},
            "policy": act.POLICY_V0, "courtResult": None, "lease": {"held": True, "generation": 3},
            "logicalTime": {"seq": 0, "rows": 1}}
    creation = dict(gate, proposal={"verb": "intent", "command": command},
                    capability=dict(gate["capability"], rowGeneration=None))
    for name, inputs, call, expect in (
        ("commit with rows 1", gate, "commit", "ok"),
        ("commit with rows 5", dict(gate, logicalTime={"seq": 4, "rows": 5}), "commit", "ok"),
        ("commit with rows 0", dict(gate, logicalTime={"seq": 0, "rows": 0}), "commit", "SCHEMA inputs.logicalTime.rows"),
        ("creation with rows 0", dict(creation, logicalTime={"seq": 0, "rows": 0}), "creation", "ok"),
        ("creation with rows -1", dict(creation, logicalTime={"seq": 0, "rows": -1}), "creation",
         "SCHEMA inputs.logicalTime.rows"),
    ):
        got = where(lambda v, call=call: act.check_gate_inputs(v, call), inputs)
        ruled(13, "gate-commit-call-rows-at-least-1", got == expect, "%s: %s" % (name, got))


def main():
    run_vectors()
    run_digests()
    run_random_values(20000)
    run_random_bytes(20000)
    run_limits()
    run_encoder_rows()
    run_generator_forms()
    run_record()
    run_codes()
    run_act_shapes()
    run_rulings_7()
    for line in FAILURES:
        sys.stdout.write("FAIL %s\n" % line)
    sys.stdout.write("PYTHON pass=%d fail=%d\n" % (RESULTS["pass"], RESULTS["fail"]))
    return 1 if RESULTS["fail"] else 0


if __name__ == "__main__":
    sys.exit(main())
