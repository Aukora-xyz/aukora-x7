#!/usr/bin/env python3
"""aukora.canon.v1: the independent Python implementation (contract milestone M1).

Written from the capsule contract (draft 6) section 3 alone, without
reading the JavaScript implementation. Standard library only; Python 3.9 to
3.14.

    parse(data)          one hand-written left-to-right pass (section 3.3);
                         raises Refused(code, at). Never calls json.loads.
    encode(value)        section 3.4: a direct depth-first walk of the host
                         value; raises Refused(code, None) (a class only).
                         Never calls json.dumps.
    digest(domain, data) sha256(ascii(domain) || 0x00 || data), lowercase hex,
                         over whatever bytes it is given; it never parses.
    sha256_raw(data)     plain sha256 of raw bytes (the `sha256-raw` label).

Command line (python3 -I deploy/ci/capsule_canon.py):
    --vectors FILE       check a vectors file; one line per failing row, then
                         VECTORS pass=<n> fail=<n>
    --stdin-verdict      one hex line in, one line out:
                         ok <canonicalHex> <digest under aukora.capsule.v1>
                         no <class> <at>
There is no lenient mode.
"""

import sys

# A run must leave no __pycache__ in the tree (a .pyc holds this machine's path).
sys.dont_write_bytecode = True

import hashlib  # noqa: E402

# Section 3.2 limits, each with its counting unit.
MAX_TEXT_BYTES = 262144  # bytes of the whole text
MAX_DEPTH = 16  # root object is depth 1; each object or array inside another adds 1
MAX_NODES = 20000  # value occurrences: the root, each member value, each array item (keys are not nodes)
MAX_STRING_CHARS = 2048  # characters after decoding (an escape pair is one character)
MAX_ARRAY_ITEMS = 8192  # items of one array
MAX_OBJECT_MEMBERS = 8192  # members of one object
MAX_KEY_CHARS = 64  # bytes between the quotes of a key (keys have no escapes)
MAX_SAFE_INTEGER = 9007199254740991  # largest allowed magnitude

CLASSES = ("LIMIT", "BYTE_RANGE", "TYPE", "NUMBER", "KEY", "KEY_ORDER", "SYNTAX")

# Section 3.5: the closed list of domains.
DOMAINS = (
    "aukora.capsule.v1",
    "aukora.capsule.state.v1",
    "aukora.act.v1",
    "aukora.capsule-facts.v1",
    "aukora.capsule-policy.v0",
    "aukora.proof.v3",
    "aukora.key.v1",
    "aukora.act-lineage.v1",
)

_LBRACE, _RBRACE, _LBRACK, _RBRACK = 0x7B, 0x7D, 0x5B, 0x5D
_QUOTE, _BACKSLASH, _COMMA, _COLON, _MINUS = 0x22, 0x5C, 0x2C, 0x3A, 0x2D

_DIGIT_BYTES = frozenset(b"0123456789")
_ALPHA_BYTES = frozenset(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")
_KEY_BYTES = _ALPHA_BYTES | _DIGIT_BYTES | frozenset(b"_.:-")
# The maximal run read at a number position: 0-9 A-Z a-z + - .
_RUN_BYTES = _ALPHA_BYTES | _DIGIT_BYTES | frozenset(b"+-.")
_VALUE_START = frozenset(b'{["-0123456789tfn')
_MAX_SAFE_DIGITS = str(MAX_SAFE_INTEGER).encode("ascii")


class Refused(Exception):
    """A refusal. code is one of CLASSES; at is a byte offset (0 <= at <= len)
    for the parser, and None for the encoder, which reports a class only."""

    def __init__(self, code, at):
        Exception.__init__(self, "%s at %s" % (code, at))
        self.code = code
        self.at = at


def _is_canonical_integer(run):
    """integer = "0" | [ "-" ] %x31-39 *DIGIT, magnitude at most MAX_SAFE_INTEGER."""
    if run == b"0":
        return True
    digits = run[1:] if run[:1] == b"-" else run
    if not digits or digits[0] not in b"123456789":
        return False
    for b in digits:
        if b not in _DIGIT_BYTES:
            return False
    if len(digits) != len(_MAX_SAFE_DIGITS):
        return len(digits) < len(_MAX_SAFE_DIGITS)
    return digits <= _MAX_SAFE_DIGITS


class _Pass(object):
    """Step 4 of section 3.3: the single pass. Runs only after steps 1 to 3."""

    def __init__(self, data):
        self.d = data
        self.n = len(data)
        self.pos = 0
        self.nodes = 0

    def _peek(self):
        return self.d[self.pos] if self.pos < self.n else -1

    def value(self, parent_depth):
        at = self.pos
        b = self._peek()
        if b not in _VALUE_START:  # (a), also the end of the text
            raise Refused("SYNTAX", at)
        self.nodes += 1  # (b)
        if self.nodes > MAX_NODES:
            raise Refused("LIMIT", at)
        if b == _LBRACE:
            return self.obj(parent_depth + 1)
        if b == _LBRACK:
            return self.arr(parent_depth + 1)
        if b == _QUOTE:
            return self.string()
        if b == _MINUS or b in _DIGIT_BYTES:
            return self.number()
        if b == 0x74:
            return self.literal(b"true", True)
        if b == 0x66:
            return self.literal(b"false", False)
        return self.literal(b"null", None)

    def obj(self, depth):
        at = self.pos
        if depth > MAX_DEPTH:  # (c)
            raise Refused("LIMIT", at)
        self.pos += 1
        result = {}
        if self._peek() == _RBRACE:
            self.pos += 1
            return result
        previous = None
        members = 0
        while True:
            if self._peek() != _QUOTE:  # member position (a)
                raise Refused("SYNTAX", self.pos)
            members += 1  # (b)
            if members > MAX_OBJECT_MEMBERS:
                raise Refused("LIMIT", self.pos)
            key_at = self.pos
            key = self.key()  # (c)
            if previous is not None and not key > previous:  # MUTATION-POINT key-order
                raise Refused("KEY_ORDER", key_at)  # (d)
            previous = key
            if self._peek() != _COLON:  # (e)
                raise Refused("SYNTAX", self.pos)
            self.pos += 1
            result[key.decode("ascii")] = self.value(depth)
            b = self._peek()
            if b == _COMMA:
                self.pos += 1
                continue
            if b == _RBRACE:
                self.pos += 1
                return result
            raise Refused("SYNTAX", self.pos)

    def key(self):
        start = self.pos
        i = start + 1
        d, n = self.d, self.n
        while True:
            if i >= n:
                raise Refused("SYNTAX", n)
            b = d[i]
            if b == _QUOTE:
                break
            if b not in _KEY_BYTES or i - start > MAX_KEY_CHARS:
                raise Refused("KEY", i)
            i += 1
        if i == start + 1:
            raise Refused("KEY", i)  # the closing quote of an empty key
        self.pos = i + 1
        return d[start + 1 : i]

    def arr(self, depth):
        at = self.pos
        if depth > MAX_DEPTH:  # (c)
            raise Refused("LIMIT", at)
        self.pos += 1
        result = []
        if self._peek() == _RBRACK:
            self.pos += 1
            return result
        while True:
            # (a) before (b): only a byte that can start a value is counted.
            if self._peek() in _VALUE_START and len(result) >= MAX_ARRAY_ITEMS:
                raise Refused("LIMIT", self.pos)
            result.append(self.value(depth))
            b = self._peek()
            if b == _COMMA:
                self.pos += 1
                continue
            if b == _RBRACK:
                self.pos += 1
                return result
            raise Refused("SYNTAX", self.pos)

    def string(self):
        start = self.pos
        i = start + 1
        d, n = self.d, self.n
        out = bytearray()
        chars = 0
        while True:
            if i >= n:
                raise Refused("SYNTAX", n)
            b = d[i]
            if b == _QUOTE:
                break
            chars += 1
            if chars > MAX_STRING_CHARS:  # before this character's own bytes are judged
                raise Refused("LIMIT", i)
            if b == _BACKSLASH:
                # Draft 3: a bad escape, also one cut by the end of the text, is
                # reported at the backslash.
                if i + 1 >= n:
                    raise Refused("SYNTAX", i)
                e = d[i + 1]
                if e != _QUOTE and e != _BACKSLASH:
                    raise Refused("SYNTAX", i)
                out.append(e)
                i += 2
            else:
                out.append(b)
                i += 1
        self.pos = i + 1
        return out.decode("ascii")

    def number(self):
        start = self.pos
        i = start
        d, n = self.d, self.n
        while i < n and d[i] in _RUN_BYTES:
            i += 1
        run = d[start:i]
        if not _is_canonical_integer(run):  # MUTATION-POINT number
            raise Refused("NUMBER", start)
        self.pos = i
        return int(run.decode("ascii"))

    def literal(self, word, result):
        # Draft 3: a misspelt or cut-off literal is reported at its first byte.
        start = self.pos
        if self.d[start : start + len(word)] != word:
            raise Refused("SYNTAX", start)
        self.pos = start + len(word)
        return result


def _first_out_of_range(data):
    for i, b in enumerate(data):
        if b < 0x20 or b > 0x7E:
            return i
    return -1


def parse(data):
    """Parse a canonical text. Returns dict/list/str/int/bool/None, or raises Refused."""
    if not isinstance(data, (bytes, bytearray)):
        raise TypeError("parse takes bytes")
    data = bytes(data)
    # 1. LIMIT on the whole text.
    if len(data) > MAX_TEXT_BYTES:
        raise Refused("LIMIT", MAX_TEXT_BYTES)
    # 2. BYTE_RANGE over every byte, before the pass.
    bad = _first_out_of_range(data)  # MUTATION-POINT byte-range
    if bad >= 0:
        raise Refused("BYTE_RANGE", bad)
    # 3. TYPE: empty, or not an object.
    if not data or data[0] != _LBRACE:
        raise Refused("TYPE", 0)
    # 4. The pass.
    p = _Pass(data)
    result = p.value(0)
    if p.pos != p.n:
        raise Refused("SYNTAX", p.pos)
    return result


# ------------------------------------------------------------------ encoder
def _refuse(code):
    raise Refused(code, None)


def _key_ok(name):
    """A key of the grammar: 1 to 64 bytes of ALPHA DIGIT _ . : -"""
    if not 1 <= len(name) <= MAX_KEY_CHARS:
        return False
    for ch in name:
        if ord(ch) >= 0x80 or ord(ch) not in _KEY_BYTES:
            return False
    return True


def _escape(text):
    return b'"' + text.encode("ascii").replace(b"\\", b"\\\\").replace(b'"', b'\\"') + b'"'


class _Encoder(object):
    """Section 3.4, in its order: depth-first; members in ascending key order by
    direct emission; items in index order; at each value the counts and the
    depth before the value's own checks; the text length as bytes are
    produced; the first failure wins."""

    def __init__(self):
        self.out = bytearray()
        self.nodes = 0

    def produce(self, chunk):
        self.out += chunk
        if len(self.out) > MAX_TEXT_BYTES:
            _refuse("LIMIT")

    def run(self, root):
        if type(root) is not dict:
            _refuse("TYPE")  # a root that is not an object
        # Work items: (0, bytes) produce; (1, value, depth) a value occurrence
        # whose container depth would be `depth`; (2, list, k, depth) item k;
        # (3, name, value, k, depth) member k in key order.
        work = [(1, root, 1)]
        while work:
            item = work.pop()
            tag = item[0]
            if tag == 0:
                self.produce(item[1])
                continue
            if tag == 2:
                _, items, k, depth = item
                if k:
                    self.produce(b",")
                if k >= MAX_ARRAY_ITEMS:
                    _refuse("LIMIT")
                self.value(items[k], depth, work)
                continue
            if tag == 3:
                _, name, value, k, depth = item
                if k:
                    self.produce(b",")
                if k >= MAX_OBJECT_MEMBERS:
                    _refuse("LIMIT")
                if not _key_ok(name):
                    _refuse("KEY")
                self.produce(b'"' + name.encode("ascii") + b'":')
                self.value(value, depth, work)
                continue
            self.value(item[1], item[2], work)
        return bytes(self.out)

    def value(self, v, depth, work):
        self.nodes += 1  # the count before anything about the value itself
        if self.nodes > MAX_NODES:
            _refuse("LIMIT")
        t = type(v)
        if t is dict or t is list:
            if depth > MAX_DEPTH:  # then the depth
                _refuse("LIMIT")
        if v is None:
            self.produce(b"null")
        elif v is True:  # bool before int
            self.produce(b"true")
        elif v is False:
            self.produce(b"false")
        elif t is int:
            # Compared, never str()'d while unbounded: an int of any size is
            # refused NUMBER without building its decimal text.
            if not -MAX_SAFE_INTEGER <= v <= MAX_SAFE_INTEGER:
                _refuse("NUMBER")
            self.produce(str(v).encode("ascii"))
        elif isinstance(v, float):
            _refuse("NUMBER")  # any float
        elif t is str:
            limit = min(len(v), MAX_STRING_CHARS + 1)
            for i in range(limit):
                if i == MAX_STRING_CHARS:
                    _refuse("LIMIT")
                c = ord(v[i])
                if c < 0x20 or c > 0x7E:
                    _refuse("BYTE_RANGE")
            self.produce(_escape(v))
        elif t is list:
            self.produce(b"[")
            work.append((0, b"]"))
            for k in range(len(v) - 1, -1, -1):
                work.append((2, v, k, depth + 1))
        elif t is dict:
            names = list(v.keys())
            for name in names:
                if type(name) is not str:
                    _refuse("KEY")  # a key that is not a str cannot even be ordered
            ordered = sorted((name.encode("utf-8", "surrogatepass"), name) for name in names)
            self.produce(b"{")
            work.append((0, b"}"))
            for k in range(len(ordered) - 1, -1, -1):
                name = ordered[k][1]
                work.append((3, name, v[name], k, depth + 1))
        else:
            _refuse("TYPE")  # tuples, bytes, sets, class instances, subclasses


def encode(value):
    """Encode a host value (section 3.4) to canonical bytes, or raise Refused
    with a class and at=None. The bytes it returns are parsed again; a refusal
    there would be a defect of this module and is raised as AssertionError."""
    data = _Encoder().run(value)
    try:
        parse(data)
    except Refused as inner:  # pragma: no cover - a defect, never a verdict
        raise AssertionError("encoder produced non-canonical bytes: %s" % inner)
    return data


# ------------------------------------------------------------------ digests
def _bytes_only(data):
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise TypeError("digest takes bytes")
    return bytes(data)


def digest(domain, data):
    """sha256( ascii(domain) || 0x00 || data ), lowercase hex (section 3.5).
    `domain` must be one of the closed list; `data` is hashed as given."""
    if domain not in DOMAINS:
        raise ValueError("domain outside the closed list of section 3.5: %r" % (domain,))
    return hashlib.sha256(domain.encode("ascii") + b"\x00" + _bytes_only(data)).hexdigest()


def sha256_raw(data):
    """Plain sha256 of an artifact's raw bytes (the `sha256-raw` label of 3.5)."""
    return hashlib.sha256(_bytes_only(data)).hexdigest()


# ------------------------------------------------------------------ harness
MAX_GEN_BYTES = 4 * MAX_TEXT_BYTES  # an inputGen row never expands past this


GEN_UNIT_FIELDS = frozenset(("prefixHex", "unitHex", "count", "suffixHex"))
GEN_COUNTER_FIELDS = frozenset(("prefixHex", "beforeHex", "width", "afterHex", "sepHex", "count", "suffixHex"))


def row_input(row):
    """The bytes of a vector row (3.8): inputHex, or inputGen in one of two forms.
    {prefixHex, unitHex, count, suffixHex}: prefix, the unit `count` times, suffix.
    {prefixHex, beforeHex, width, afterHex, sepHex, count, suffixHex}: prefix; then
    for i from 0 to count - 1 the piece before + i as `width` zero-padded decimal
    digits + after, the pieces joined by sep; then suffix. A generator that names
    other fields, or an i that does not fit `width` digits, is refused (ValueError)."""
    if "inputHex" in row:
        return bytes.fromhex(row["inputHex"])
    gen = row["inputGen"]
    count = gen.get("count")
    if type(count) is not int or count < 0:
        raise ValueError("inputGen count out of bounds")
    if set(gen) == GEN_UNIT_FIELDS:
        prefix, unit, suffix = (bytes.fromhex(gen[k]) for k in ("prefixHex", "unitHex", "suffixHex"))
        if len(prefix) + len(unit) * count + len(suffix) > MAX_GEN_BYTES:
            raise ValueError("inputGen out of bounds")
        return prefix + unit * count + suffix
    if set(gen) != GEN_COUNTER_FIELDS:
        raise ValueError("inputGen fields are neither form of 3.8")
    prefix, before, after, sep, suffix = (
        bytes.fromhex(gen[k]) for k in ("prefixHex", "beforeHex", "afterHex", "sepHex", "suffixHex"))
    width = gen["width"]
    if type(width) is not int or width < 1 or (count and len(str(count - 1)) > width):
        raise ValueError("inputGen width out of bounds")
    piece = len(before) + width + len(after)
    if len(prefix) + count * piece + max(count - 1, 0) * len(sep) + len(suffix) > MAX_GEN_BYTES:
        raise ValueError("inputGen out of bounds")
    form = "%0" + str(width) + "d"
    pieces = [before + (form % i).encode("ascii") + after for i in range(count)]
    return prefix + sep.join(pieces) + suffix


def check_vector_row(row):
    """Return None when the row holds, else a one-line reason."""
    data = row_input(row)
    if "presentedIdHex" in row:
        # 3.6: the raw bytes are hashed and compared first; they are not parsed for it.
        under = digest("aukora.capsule.v1", data)
        outcome = "match" if under == row["presentedIdHex"] else "CAPSULE_BYTES_MISMATCH"
        if outcome != row["idCheck"]:
            return "id check expected %s, got %s" % (row["idCheck"], outcome)
    try:
        value = parse(data)
        got = None
    except Refused as refusal:
        value = None
        got = refusal
    verdict = row["verdict"]
    if verdict == "ok":
        if got is not None:
            return "expected ok, got no %s %d" % (got.code, got.at)
        if encode(value) != data:
            return "encode(parse(t)) != t"
        for domain in sorted(row["digests"]):
            computed = digest(domain, data)
            if computed != row["digests"][domain]:
                return "digest %s differs: %s" % (domain, computed)
    elif verdict == "no":
        if got is None:
            return "expected no %s %d, got ok" % (row["class"], row["at"])
        if got.code != row["class"] or got.at != row["at"]:
            return "expected no %s %d, got no %s %d" % (row["class"], row["at"], got.code, got.at)
    else:
        return "unknown verdict %r" % (verdict,)
    return None


def read_harness_json(path):
    """Read a harness file (vectors, fixture). Harness input only: the stdlib
    JSON reader never decides whether a text is canonical."""
    import json

    with open(path, "rb") as handle:
        return json.loads(handle.read().decode("utf-8"))


def run_vectors(path, stream):
    doc = read_harness_json(path)
    passed = failed = 0
    for row in doc["rows"]:
        try:
            reason = check_vector_row(row)
        except Exception as error:  # an unexpected crash is a failing row
            reason = "crashed: %r" % (error,)
        if reason is None:
            passed += 1
        else:
            failed += 1
            stream.write("FAIL %s: %s\n" % (row.get("name"), reason))
    stream.write("VECTORS pass=%d fail=%d\n" % (passed, failed))
    return passed, failed


def _hex_bytes(text):
    return bytes.fromhex(text) if text else b""


def stdin_verdict(source, sink):
    for line in source:
        line = line.rstrip(b"\r\n")
        try:
            data = _hex_bytes(line.decode("ascii").strip())
        except ValueError:
            sink.write(b"err HEX\n")
            sink.flush()
            continue
        try:
            canonical = encode(parse(data))
            sink.write(("ok %s %s\n" % (canonical.hex(), digest("aukora.capsule.v1", canonical))).encode("ascii"))
        except Refused as refusal:
            sink.write(("no %s %d\n" % (refusal.code, refusal.at)).encode("ascii"))
        sink.flush()


def main(argv):
    if len(argv) == 2 and argv[0] == "--vectors":
        _, failed = run_vectors(argv[1], sys.stdout)
        return 1 if failed else 0
    if len(argv) == 1 and argv[0] == "--stdin-verdict":
        stdin_verdict(sys.stdin.buffer, sys.stdout.buffer)
        return 0
    sys.stderr.write("usage: capsule_canon.py --vectors FILE | --stdin-verdict\n")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
