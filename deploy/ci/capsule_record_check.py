#!/usr/bin/env python3
"""Verify a capsule record (aukora.capsule.v1) against the CLOSED schema of
the capsule contract (draft 7) section 4, independently of the JavaScript.

Imports only the canonical module (and sys for the command line).

    check_record(data, presented_id=None, items=None)
        -> {"ok", "complete", "id", "stateRoot", "problems"}

`items`, when given, maps an inventory id to that item's raw bytes. Every
problem is {"code", "where"}. The order (first refusal wins):
  1. A presented id is compared with the digest of the RAW bytes first; a
     mismatch is CAPSULE_BYTES_MISMATCH and the bytes are not parsed (3.6).
  2. The canonical parse (its class and byte offset).
  3. Another schema name, readerMin above 1, another canon, or non-empty
     extensions: CAPSULE_SCHEMA_UNSUPPORTED, reported alone, no field checks.
  4. SCHEMA with the field path: the closed shape, "Types, fixed now" (with
     the closed lists of draft 7: each evidence list's own scope, the
     authorityRequired list of exactly three, the fixed inventory id forms
     and the kind each form fixes), the recomputed `agreement`, a null with
     no source row, the five always-excluded rows that are not their
     constants.
  5. Reports that leave `ok` true: CAPSULE_INCOMPLETE (an unknown row; each
     failed source row, once, whether or not a null names it; a missing
     always-excluded row; an item with no bytes supplied);
     CAPSULE_BYTES_MISMATCH for a supplied item whose bytes differ (this one
     sets `ok` false); the label CAPSULE_PRODUCER_UNVERIFIED on every record
     checked as v1.
`complete` (draft 7): nothing unknown, no failed source, every required row
present. The five always-excluded rows, being excluded, do not make a record
incomplete. A record that is not `ok` is never `complete`.
The draft 7 rulings this module carries are named in RULES (number, name,
the function that holds it); capsule_canon_test.py tests each by name.
Every code this module reports is a refusal class of 3.3, SCHEMA, or a row of
CODES (section 16, exactly).
Valid bytes under their own id are simply a record.

Command line: python3 -I deploy/ci/capsule_record_check.py --fixture FILE
"""

import sys

# A run must leave no __pycache__ in the tree (a .pyc holds this machine's path).
sys.dont_write_bytecode = True
# python3 -I leaves the script's own folder off sys.path; put back exactly that one.
sys.path.insert(0, __file__.rpartition("/")[0] or ".")
import capsule_canon as canon  # noqa: E402

RECORD_DOMAIN = "aukora.capsule.v1"
STATE_DOMAIN = "aukora.capsule.state.v1"
SCHEMA_NAME = "aukora.capsule.v1"
CANON_NAME = "aukora.canon.v1"
MAX_ID_CHARS = 128

AGREEMENT = ("agree", "local-ahead", "published-ahead", "diverged", "unknown")
BALL_ID_FORM = ("canonical", "legacy")
INVENTORY_KIND = ("organ-entry", "module", "file", "log", "root", "other")
DIGEST_KIND = ("sha256-raw", "native-id")
DISPOSITION = ("included", "excluded", "unknown")
REASON = (
    "EXCLUDED_AUTHORITY",
    "EXCLUDED_SECRET",
    "EXCLUDED_PRIVATE",
    "EXCLUDED_HOST_SPECIFIC",
    "EXCLUDED_NOT_PORTABLE",
    "UNKNOWN_NO_SOURCE",
    "UNKNOWN_SOURCE_FAILED",
    "UNKNOWN_SIGNER_UNPINNED",
    "UNKNOWN_NOT_CAPTURED",
)
PENDING_STATE = ("intent", "sent", "unknown")
# Section 4: evidence.scope is closed, one scope per evidence list.
EVIDENCE_SCOPE = (
    ("retention", "behavioral-retention-only"),
    ("receipts", "nostr-receipts-head"),
    ("checkpoints", "checkpoint"),
)
# Section 4: authorityRequired[] holds codes from this closed list (sorted, unique),
# and a v1 record carries all three, always (ruling 6).
AUTHORITY_REQUIRED = ("OWNER_APPROVED_MOVE", "OWNER_SESSION", "WRITER_LEASE")
# Section 4: inventory ids have a fixed form: organ:<organ id>, module:<sha256>,
# file:<path id>, or one of the five fixed names of the always-excluded rows.
# The 1-to-128 rule applies to the part after the prefix, and the form fixes
# the kind (ruling 4).
ID_PREFIXES = ("organ:", "module:", "file:")
KINDS_OF_FORM = (
    ("organ:", ("organ-entry",)),
    ("module:", ("module",)),
    ("file:", ("file", "log", "root", "other")),
)
# Section 16, the one closed table of codes, in table order.
CODES = (
    "CAPSULE_BYTES_MISMATCH",
    "CAPSULE_SCHEMA_UNSUPPORTED",
    "CAPSULE_INCOMPLETE",
    "CAPSULE_PRODUCER_UNVERIFIED",
    "CAPSULE_CAPTURE_CHANGED",
    "CAPSULE_ACTION_ID_MISMATCH",
    "CAPSULE_LINEAGE_MISMATCH",
    "PROOF_INVALID",
    "PROOF_REPLAYED",
    "PROOF_SUPERSEDED",
    "CAPSULE_GENERATION_STALE",
    "CAPSULE_INSTANCE_REVOKED",
    "BODY_KEY_FORKED",
    "WRITER_LEASE_REQUIRED",
    "CAPSULE_INTENT_ALREADY_PLACED",
    "CAPSULE_ACTION_CONFLICT",
    "CAPSULE_POSITION_STALE",
    "CAPSULE_ACTION_UNKNOWN",
    "CAPSULE_ACTION_ABANDONED",
    "CAPSULE_ACTION_COMMITTED",
    "CAPSULE_INHERITED_LOCKED",
    "CAPSULE_GATE_DENIED",
    "CAPSULE_LEDGER_FULL",
    "CAPSULE_AUTHORITY_REQUIRED",
    "CAPSULE_OUTCOME_UNKNOWN",
    "DESTINATION_BEHIND",
)
EVIDENCE_STATUS = ("verified", "unverified", "failed")
# Section 5, "Source names (closed)".
SOURCE_NAMES = (
    "baseline", "evidence", "files", "head.local", "head.published", "head.staged", "holder", "journal",
    "lease", "lineage", "memory", "modules", "organs", "owner", "policy", "producer", "receipts", "suite",
)
# Section 4, "Required rows": always present, always excluded.
ALWAYS_EXCLUDED = ("headHistory", "messages", "ownerBinding", "providerBudget", "turnJournal")
# Ruling 5: those five rows are constants; only the reason differs by name.
EXCLUDED_REASON = {
    "ownerBinding": "EXCLUDED_AUTHORITY",
    "messages": "EXCLUDED_PRIVATE",
    "turnJournal": "EXCLUDED_PRIVATE",
    "providerBudget": "EXCLUDED_HOST_SPECIFIC",
    "headHistory": "EXCLUDED_NOT_PORTABLE",
}


def excluded_row(name):
    """The one row ruling 5 allows for an always-excluded name."""
    return {"id": name, "kind": "other", "byteLength": None, "digest": None, "digestKind": None,
            "disposition": "excluded", "reason": EXCLUDED_REASON[name]}


# The draft 7 rulings carried here: (ruling, rule name, where it is held).
RULES = (
    (2, "evidence-scope-own-list", "_evidence"),
    (3, "failed-source-once-per-row", "check_body"),
    (4, "inventory-id-rest-1-to-128", "_inventory_id"),
    (4, "inventory-id-form-fixes-kind", "_inventory"),
    (5, "always-excluded-rows-are-constants", "_inventory"),
    (6, "authority-required-exactly-three", "_state"),
)
# The null rule's source for each nullable field that stands for something read.
# SCHEMA.md (the per-field table) is not this lane's to read; these pairs are
# this lane's reading of sections 4 and 5. Structural nulls (parentCapsuleId,
# local.parentBallId, inventory row fields, evidence digests, a source's code)
# are governed by their own pairing rules, not by a source row.
NULL_SOURCES = (
    (("lineageId",), "lineage"),
    (("heads", "published"), "head.published"),
    (("heads", "staged"), "head.staged"),
    (("producer", "sourceRevision"), "producer"),
    (("producer", "runtimeArtifactSha256"), "producer"),
    (("roots", "receipts"), "receipts"),
    (("roots", "memory"), "memory"),
    (("roots", "suite"), "suite"),
    (("roots", "baseline"), "baseline"),
    (("roots", "policy"), "policy"),
)
# "Types, fixed now": list bounds.
MAX_INVENTORY = 2048
MAX_PENDING = 1024
MAX_EVIDENCE = 1024
MAX_SOURCES = 64
MAX_CODES = 64

_HEX = frozenset("0123456789abcdef")
_CODE_HEAD = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
_CODE_TAIL = _CODE_HEAD | frozenset("0123456789_")


class RecordRefused(Exception):
    def __init__(self, code, where):
        Exception.__init__(self, "%s at %s" % (code, where))
        self.code = code
        self.where = where


def _fail(path):
    raise RecordRefused("SCHEMA", path)


def _fields(value, path, names):
    """A closed object: exactly these member names."""
    if type(value) is not dict:
        _fail(path)
    if any(type(key) is not str for key in value):
        _fail(path)  # a host key that is not a str is refused, never a TypeError
    for name in sorted(set(names) | set(value)):
        if name not in value or name not in names:
            _fail(path + "." + name)


def _is_int(value):
    return type(value) is int


def _nonneg_int(value, path):
    if not _is_int(value) or value < 0:
        _fail(path)


def _ident(value, path):
    if type(value) is not str or not 1 <= len(value) <= MAX_ID_CHARS:
        _fail(path)


def _code(value, path):
    """[A-Z][A-Z0-9_]{0,127}"""
    if type(value) is not str or not 1 <= len(value) <= 128 or value[0] not in _CODE_HEAD:
        _fail(path)
    if not set(value[1:]) <= _CODE_TAIL:
        _fail(path)


def _hexn(value, path, n):
    if type(value) is not str or len(value) != n or not set(value) <= _HEX:
        _fail(path)


def _hex64(value, path):
    _hexn(value, path, 64)


def _one_of(value, path, allowed):
    if type(value) is not str or value not in allowed:
        _fail(path)


def _exact(value, path, expected):
    if type(value) is not type(expected) or value != expected:
        _fail(path)


def _nullable(check):
    def inner(value, path, *rest):
        if value is not None:
            check(value, path, *rest)

    return inner


def _list(value, path, bound):
    if type(value) is not list or len(value) > bound:
        _fail(path)
    return value


def _strictly_sorted(items, path, key):
    for i in range(1, len(items)):
        a, b = key(items[i - 1]), key(items[i])
        if isinstance(a, str):
            a, b = a.encode("ascii"), b.encode("ascii")
        if not a < b:
            _fail("%s[%d]" % (path, i))


def _head(value, path, names):
    _fields(value, path, names)
    _ident(value["ballId"], path + ".ballId")
    _one_of(value["ballIdForm"], path + ".ballIdForm", BALL_ID_FORM)
    _nonneg_int(value["epoch"], path + ".epoch")


def agreement_of(local, published):
    """Section 4, "Three heads, never one". Draft 3 lists both "the larger
    epoch" and "the ids are equal and the epochs differ"; this lane reads the
    second as taking precedence (the same ball at two epochs is not ahead)."""
    if published is None or local["ballIdForm"] != published["ballIdForm"]:
        return "unknown"
    same_id = local["ballId"] == published["ballId"]
    same_epoch = local["epoch"] == published["epoch"]
    if same_id and same_epoch:
        return "agree"
    if same_id or same_epoch:
        return "diverged"
    return "local-ahead" if local["epoch"] > published["epoch"] else "published-ahead"


def _heads(value, path):
    _fields(value, path, ("local", "published", "staged", "agreement"))
    local = value["local"]
    _head(local, path + ".local", ("ballId", "ballIdForm", "epoch", "parentBallId"))
    _nullable(_ident)(local["parentBallId"], path + ".local.parentBallId")
    if value["published"] is not None:
        _head(value["published"], path + ".published", ("ballId", "ballIdForm", "epoch"))
    staged = value["staged"]
    if staged is not None:
        _head(staged, path + ".staged", ("ballId", "ballIdForm", "epoch", "state"))
        _ident(staged["state"], path + ".staged.state")  # a closed list taken from the source: an id here
    _one_of(value["agreement"], path + ".agreement", AGREEMENT)
    if value["agreement"] != agreement_of(local, value["published"]):  # MUTATION-POINT agreement
        _fail(path + ".agreement")


def _producer(value, path):
    _fields(value, path, ("builder", "builderVersion", "sourceRevision", "runtimeArtifactSha256", "claim"))
    _exact(value["builder"], path + ".builder", "host/capsule-record")
    _exact(value["builderVersion"], path + ".builderVersion", 1)
    _nullable(_hexn)(value["sourceRevision"], path + ".sourceRevision", 40)
    _nullable(_hex64)(value["runtimeArtifactSha256"], path + ".runtimeArtifactSha256")
    _exact(value["claim"], path + ".claim", "self-asserted")


def _inventory_id(value, path):
    """organ:<organ id>, module:<sha256 as hex64>, file:<path id>, or a fixed
    name. Ruling 4: the 1-to-128 rule applies to the part AFTER the prefix.
    Returns the form: the prefix, or None for a fixed name."""
    if type(value) is not str:
        _fail(path)
    if value in ALWAYS_EXCLUDED:
        return None
    for prefix in ID_PREFIXES:
        if value.startswith(prefix):
            rest = value[len(prefix):]  # MUTATION-POINT id-rest
            if prefix == "module:":
                _hex64(rest, path)
            else:
                _ident(rest, path)
            return prefix
    _fail(path)


def _form_fixes_kind(form, kind, path):
    """Ruling 4: organ: with organ-entry, module: with module, file: with file,
    log, root or other."""
    for prefix, kinds in KINDS_OF_FORM:
        if form == prefix and kind not in kinds:
            _fail(path)


def _excluded_constants(row, path):
    """Ruling 5: a row with one of the five names and any other value is SCHEMA."""
    expected = excluded_row(row["id"])
    for name in ("kind", "byteLength", "digest", "digestKind", "disposition", "reason"):
        if row[name] != expected[name] or type(row[name]) is not type(expected[name]):
            _fail(path + "." + name)


def _inventory(value, path):
    items = _list(value, path, MAX_INVENTORY)
    names = ("id", "kind", "byteLength", "digest", "digestKind", "disposition", "reason")
    for i, row in enumerate(items):
        p = "%s[%d]" % (path, i)
        _fields(row, p, names)
        form = _inventory_id(row["id"], p + ".id")
        _one_of(row["kind"], p + ".kind", INVENTORY_KIND)
        _form_fixes_kind(form, row["kind"], p + ".kind")  # MUTATION-POINT form-kind
        _nullable(_nonneg_int)(row["byteLength"], p + ".byteLength")
        kind = row["digestKind"]
        _nullable(_one_of)(kind, p + ".digestKind", DIGEST_KIND)
        if kind is None:
            if row["digest"] is not None:
                _fail(p + ".digest")
        elif kind == "sha256-raw":
            _hex64(row["digest"], p + ".digest")
        else:
            _ident(row["digest"], p + ".digest")
        disposition = row["disposition"]
        _one_of(disposition, p + ".disposition", DISPOSITION)
        reason = row["reason"]
        _nullable(_one_of)(reason, p + ".reason", REASON)
        if disposition == "included":
            paired = reason is None
        elif disposition == "excluded":
            paired = reason is not None and reason.startswith("EXCLUDED_")
        else:
            paired = reason is not None and reason.startswith("UNKNOWN_")
        if not paired:
            _fail(p + ".reason")
        if form is None:
            _excluded_constants(row, p)  # MUTATION-POINT excluded-constants
    _strictly_sorted(items, path, lambda row: row["id"])


def _roots(value, path):
    _fields(value, path, ("receipts", "memory", "suite", "baseline", "policy"))
    r = value["receipts"]
    if r is not None:
        _fields(r, path + ".receipts", ("count", "lastLeafHash", "checkpointSeq"))
        _nonneg_int(r["count"], path + ".receipts.count")
        _hex64(r["lastLeafHash"], path + ".receipts.lastLeafHash")
        _nonneg_int(r["checkpointSeq"], path + ".receipts.checkpointSeq")
    m = value["memory"]
    if m is not None:
        _fields(m, path + ".memory", ("root", "nodes"))
        _hex64(m["root"], path + ".memory.root")
        _nonneg_int(m["nodes"], path + ".memory.nodes")
    s = value["suite"]
    if s is not None:
        _fields(s, path + ".suite", ("digest", "cases"))
        _hex64(s["digest"], path + ".suite.digest")
        _nonneg_int(s["cases"], path + ".suite.cases")
    b = value["baseline"]
    if b is not None:
        _fields(b, path + ".baseline", ("digest",))
        _hex64(b["digest"], path + ".baseline.digest")
    pol = value["policy"]
    if pol is not None:
        _fields(pol, path + ".policy", ("version", "digest"))
        _nonneg_int(pol["version"], path + ".policy.version")
        _hex64(pol["digest"], path + ".policy.digest")


def _pending(value, path):
    items = _list(value, path, MAX_PENDING)
    for i, row in enumerate(items):
        p = "%s[%d]" % (path, i)
        _fields(row, p, ("actionId", "intentId", "seq", "state"))
        _hex64(row["actionId"], p + ".actionId")
        _hexn(row["intentId"], p + ".intentId", 32)
        if not _is_int(row["seq"]) or row["seq"] < 1:
            _fail(p + ".seq")
        _one_of(row["state"], p + ".state", PENDING_STATE)
    _strictly_sorted(items, path, lambda row: row["seq"])


def _evidence(value, path):
    _fields(value, path, ("retention", "receipts", "checkpoints"))
    for part, scope in EVIDENCE_SCOPE:
        items = _list(value[part], path + "." + part, MAX_EVIDENCE)
        for i, row in enumerate(items):
            p = "%s.%s[%d]" % (path, part, i)
            _fields(row, p, ("ref", "issuer", "scope", "status", "digest"))
            _ident(row["ref"], p + ".ref")
            _ident(row["issuer"], p + ".issuer")
            _exact(row["scope"], p + ".scope", scope)  # MUTATION-POINT evidence-scope
            _one_of(row["status"], p + ".status", EVIDENCE_STATUS)
            _nullable(_hex64)(row["digest"], p + ".digest")
        _strictly_sorted(items, path + "." + part, lambda row: row["ref"])


def _codes(value, path):
    items = _list(value, path, MAX_CODES)
    for i, code in enumerate(items):
        _code(code, "%s[%d]" % (path, i))
    _strictly_sorted(items, path, lambda code: code)


def _compatibility(value, path):
    _fields(value, path, ("readerMin", "canon", "unsupported"))
    _exact(value["readerMin"], path + ".readerMin", 1)
    _exact(value["canon"], path + ".canon", CANON_NAME)
    _codes(value["unsupported"], path + ".unsupported")


def _state(value, path):
    _fields(
        value,
        path,
        (
            "lineageId",
            "parentCapsuleId",
            "heads",
            "producer",
            "inventory",
            "roots",
            "pending",
            "evidence",
            "compatibility",
            "authorityRequired",
            "extensions",
        ),
    )
    _nullable(_hex64)(value["lineageId"], path + ".lineageId")
    _nullable(_hex64)(value["parentCapsuleId"], path + ".parentCapsuleId")
    _heads(value["heads"], path + ".heads")
    _producer(value["producer"], path + ".producer")
    _inventory(value["inventory"], path + ".inventory")
    _roots(value["roots"], path + ".roots")
    _pending(value["pending"], path + ".pending")
    _evidence(value["evidence"], path + ".evidence")
    _compatibility(value["compatibility"], path + ".compatibility")
    _codes(value["authorityRequired"], path + ".authorityRequired")
    for i, code in enumerate(value["authorityRequired"]):
        _one_of(code, "%s.authorityRequired[%d]" % (path, i), AUTHORITY_REQUIRED)
    # Ruling 6: a v1 record carries all three, always; any other list is SCHEMA.
    if value["authorityRequired"] != list(AUTHORITY_REQUIRED):  # MUTATION-POINT authority-three
        _fail(path + ".authorityRequired")
    if type(value["extensions"]) is not dict or value["extensions"]:
        _fail(path + ".extensions")


def _observation(value, path):
    _fields(value, path, ("capturedAtMs", "attempt", "sources"))
    _nonneg_int(value["capturedAtMs"], path + ".capturedAtMs")
    attempt = value["attempt"]
    if not _is_int(attempt) or not 1 <= attempt <= 3:
        _fail(path + ".attempt")
    items = _list(value["sources"], path + ".sources", MAX_SOURCES)
    for i, row in enumerate(items):
        p = "%s.sources[%d]" % (path, i)
        _fields(row, p, ("name", "ok", "code", "observedAtMs"))
        _one_of(row["name"], p + ".name", SOURCE_NAMES)
        if type(row["ok"]) is not bool:
            _fail(p + ".ok")
        _nullable(_code)(row["code"], p + ".code")
        if (row["ok"] is True) != (row["code"] is None):
            _fail(p + ".code")
        _nonneg_int(row["observedAtMs"], p + ".observedAtMs")
    _strictly_sorted(items, path + ".sources", lambda row: row["name"])


def unsupported_where(body):
    """Section 4: the four ways a record needs a newer reader, checked before
    any field check. Returns the path, or None."""
    if type(body) is not dict:
        return None
    name = body.get("schema")
    if type(name) is str and name != SCHEMA_NAME:
        return "body.schema"
    state = body.get("state")
    if type(state) is not dict:
        return None
    compat = state.get("compatibility")
    if type(compat) is dict:
        if _is_int(compat.get("readerMin")) and compat["readerMin"] > 1:
            return "body.state.compatibility.readerMin"
        if type(compat.get("canon")) is str and compat["canon"] != CANON_NAME:
            return "body.state.compatibility.canon"
    extensions = state.get("extensions")
    if type(extensions) is dict and extensions:
        return "body.state.extensions"
    return None


def check_body(body):
    """The closed schema of section 4 over a parsed body; raises RecordRefused
    (SCHEMA). Returns the list of CAPSULE_INCOMPLETE problems."""
    if type(body) is not dict:
        _fail("body")
    _fields(body, "body", ("schema", "state", "observation"))
    _exact(body["schema"], "body.schema", SCHEMA_NAME)
    _state(body["state"], "body.state")
    _observation(body["observation"], "body.observation")
    state = body["state"]
    sources = dict((row["name"], row) for row in body["observation"]["sources"])
    incomplete = []
    # The null rule, three cases: ok:true complete; ok:false unknown; no row SCHEMA.
    for path, source in NULL_SOURCES:
        node = state
        for part in path:
            node = node[part]
        if node is not None:
            continue
        row = sources.get(source)
        where = "body.state." + ".".join(path)
        if row is None:
            _fail(where)
        if row["ok"] is False:  # MUTATION-POINT failed-source-once
            continue  # ruling 3: reported once, by its source row below, not again per null
    # Ruling 3: any failed source row makes the record incomplete, reported once
    # for each such row, whether or not a null names it.
    for row in body["observation"]["sources"]:
        if row["ok"] is False:  # MUTATION-POINT failed-source
            incomplete.append({"code": "CAPSULE_INCOMPLETE", "where": "source:" + row["name"]})
    # The five always-excluded rows: their constants are checked in _inventory (ruling 5).
    present = set(row["id"] for row in state["inventory"])
    for name in ALWAYS_EXCLUDED:
        if name not in present:
            incomplete.append({"code": "CAPSULE_INCOMPLETE", "where": "inventory:" + name})
    for i, row in enumerate(state["inventory"]):
        if row["disposition"] == "unknown":
            incomplete.append({"code": "CAPSULE_INCOMPLETE", "where": "inventory:" + row["id"]})
    return incomplete


def _result(ok, complete, record_id, state_root, problems):
    return {"ok": ok, "complete": complete, "id": record_id, "stateRoot": state_root, "problems": problems}


def check_record(data, presented_id=None, items=None):
    data = bytes(data)
    record_id = canon.digest(RECORD_DOMAIN, data)  # MUTATION-POINT presented-id
    if presented_id is not None and record_id != presented_id:
        return _result(False, False, record_id, None, [{"code": "CAPSULE_BYTES_MISMATCH", "where": "id"}])
    try:
        body = canon.parse(data)
    except canon.Refused as refusal:
        return _result(False, False, record_id, None, [{"code": refusal.code, "where": refusal.at}])
    where = unsupported_where(body)
    if where is not None:
        return _result(False, False, record_id, None, [{"code": "CAPSULE_SCHEMA_UNSUPPORTED", "where": where}])
    label = {"code": "CAPSULE_PRODUCER_UNVERIFIED", "where": None}
    try:
        problems = check_body(body)
    except RecordRefused as refusal:
        return _result(False, False, record_id, None, [{"code": refusal.code, "where": refusal.where}, label])
    state_root = canon.digest(STATE_DOMAIN, canon.encode(body["state"]))
    ok = True
    if items is not None:
        for row in body["state"]["inventory"]:
            if row["digestKind"] != "sha256-raw":
                continue
            supplied = items.get(row["id"])
            if supplied is None:
                problems.append({"code": "CAPSULE_INCOMPLETE", "where": "item:" + row["id"]})
            elif canon.sha256_raw(supplied) != row["digest"]:
                problems.append({"code": "CAPSULE_BYTES_MISMATCH", "where": "item:" + row["id"]})
                ok = False
    complete = ok and not any(p["code"] == "CAPSULE_INCOMPLETE" for p in problems)
    return _result(ok, complete, record_id, state_root, problems + [label])


def main(argv):
    if len(argv) != 2 or argv[0] != "--fixture":
        sys.stderr.write("usage: capsule_record_check.py --fixture FILE\n")
        return 2
    fixture = canon.read_harness_json(argv[1])
    data = bytes.fromhex(fixture["bodyHex"])
    items = dict((k, bytes.fromhex(v)) for k, v in fixture["itemsHex"].items())
    result = check_record(data, fixture["expectedId"], items)
    codes = ",".join(sorted(set(p["code"] for p in result["problems"])))
    line = "RECORD ok=%s complete=%s id=%s stateRoot=%s problems=%s\n" % (
        str(result["ok"]).lower(), str(result["complete"]).lower(), result["id"], result["stateRoot"], codes)
    sys.stdout.write(line)
    held = (result["ok"] and result["complete"] and result["id"] == fixture["expectedId"]
            and result["stateRoot"] == fixture["expectedStateRoot"])
    return 0 if held else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
