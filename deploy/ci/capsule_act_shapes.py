#!/usr/bin/env python3
"""Closed shapes of the act door and the gate (capsule contract draft 7,
sections 6.2 to 6.5a, section 8's inputs and output, and the act-door rows of
section 16), written independently of the JavaScript. Imports only the
canonical module. The draft 7 rulings carried here are named in RULES.

    act_lineage_id(mirror_lineage_id, world)   6.2 (the mirror id is a lowercase
                                               UUID with its dashes; world is fixed)
    check_command(value), command_id(data)     6.3
    key_thumb(raw_public_key_base64url)        3.5 / 6.4
    check_envelope(value), envelope_digest(data),
    envelope_signing_message(data)             6.4 (the exact bytes the key signs)
    check_request(value), check_request_bytes(data)   6.4 / 6.1 / 6.7 step 1
    check_verdict, check_row, check_chain, check_answer, check_read,
    check_status, check_row_read, ACT_DOOR_CODES          6.5a and 16
    check_gate_inputs(inputs, call), check_gate_input(...), check_gate_output(value),
    POLICY_V0, POLICY_V0_DIGEST                8

A refusal is ShapeRefused(code, where): a canonical class (where is the byte
offset from the parser, or None from the encoder), SCHEMA (where is the field
path), or CAPSULE_ACTION_ID_MISMATCH. There is no signature verification here:
the standard library has none and none is added.
"""

import sys

# A run must leave no __pycache__ in the tree (a .pyc holds this machine's path).
sys.dont_write_bytecode = True
# python3 -I leaves the script's own folder off sys.path; put back exactly that one.
sys.path.insert(0, __file__.rpartition("/")[0] or ".")
import capsule_canon as canon  # noqa: E402

COMMAND_SCHEMA = "aukora.act.v1"
REQUEST_SCHEMA = "aukora.act-request.v1"
ENVELOPE_SCHEMA = "aukora.proof.v3"
POLICY_SCHEMA = "aukora.capsule-policy.v0"
ANSWER_SCHEMA = "aukora.act-answer.v1"
READ_SCHEMA = "aukora.act-read.v1"
STATUS_SCHEMA = "aukora.act-status.v1"
ROW_READ_SCHEMA = "aukora.act-row.v1"
WORLD = "node-main-v1"
VERBS = ("intent", "act", "commit", "abandon")
VERBS_WITH_COMMAND = ("intent", "act")
PROPOSAL_VERBS = ("intent", "act", "commit")
DECISIONS = ("ALLOW", "ESCALATE", "DENY")
RESULTS = ("pending", "committed", "abandoned", "refused")
ROW_STATES = ("pending", "committed", "abandoned")
READ_VERBS = ("status", "pending", "row")
GATE_CALLS = ("creation", "commit")
# Section 16: the rows whose "Who says it" names the act door, in table order.
# An answer's code is null unless its result is refused, and then one of these.
ACT_DOOR_CODES = (
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
)
# Ruling 9: the refusals of steps 1 and 2 of 6.7. No ledger, chain or holder
# state was read, so the four state members of the answer are all null.
NO_STATE_CODES = ("CAPSULE_ACTION_ID_MISMATCH", "CAPSULE_LINEAGE_MISMATCH")
# Ruling 9: the one answer of a world with no holder (the first row of 7.3).
NO_HOLDER_CODE = "CAPSULE_INSTANCE_REVOKED"
# The draft 7 rulings carried here: (ruling, rule name, where it is held).
RULES = (
    (7, "mirror-id-dashed-lowercase-hex", "check_mirror_lineage_id"),
    (8, "unparsed-request-is-a-class-not-an-answer", "check_request_bytes"),
    (9, "answer-state-null-only-at-steps-1-2", "_answer_state"),
    (9, "answer-no-holder-only-instance-revoked", "_answer_state"),
    (9, "holder-thumb-null-exactly-when-chain-null", "_holder_and_chain"),
    (9, "lease-generation-an-integer", "check_lease"),
    (10, "row-resolved-by-null-exactly-when-pending", "_row_rules"),
    (10, "row-commit-verdict-exactly-when-committed", "_row_rules"),
    (10, "row-action-id-is-command-digest", "_row_rules"),
    (10, "row-seq-and-intent-id-are-the-command-s", "_row_rules"),
    (11, "answer-row-present-with-result-state", "_answer_row"),
    (11, "answer-row-null-at-steps-1-2", "_answer_row"),
    (12, "stored-commit-verdict-is-allow", "_row_rules"),
    (13, "gate-commit-call-rows-at-least-1", "_call_rules"),
)
MAX_REQUEST_BYTES = 4096
MAX_PAYLOAD_HEX = 512
SAFE_PAYLOAD_HEX = "63617073756c652d76302e332d736166652d616374696f6e"  # "capsule-v0.3-safe-action", 24 bytes
GENESIS_PREV = "0" * 64

POLICY_V0 = {
    "schema": POLICY_SCHEMA,
    "version": 0,
    "rules": [
        {
            "op": "ledger.note.append",
            "target": "test-ledger",
            "payloadHex": SAFE_PAYLOAD_HEX,
            "needsBudget": False,
            "decision": "ALLOW",
        }
    ],
}
POLICY_V0_DIGEST = canon.digest("aukora.capsule-policy.v0", canon.encode(POLICY_V0))

_HEX = frozenset("0123456789abcdef")
_KEY_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.:-")
_CODE_HEAD = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
_CODE_TAIL = _CODE_HEAD | frozenset("0123456789_")
_B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
_B64URL_VALUE = dict((c, i) for i, c in enumerate(_B64URL))

# P-256 (secp256r1): y^2 = x^3 - 3x + b over GF(p). Used only to say that a
# spelled key is a point of the curve; nothing here signs or verifies.
_P = 2 ** 256 - 2 ** 224 + 2 ** 192 + 2 ** 96 - 1
_B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
RAW_KEY_BYTES = 65  # 0x04 || X || Y
RAW_KEY_CHARS = 87  # its one base64url spelling: no padding, the two spare bits zero


class ShapeRefused(Exception):
    def __init__(self, code, where):
        Exception.__init__(self, "%s at %s" % (code, where))
        self.code = code
        self.where = where


def _fail(path):
    raise ShapeRefused("SCHEMA", path)


def _fields(value, path, names):
    if type(value) is not dict:
        _fail(path)
    if any(type(key) is not str for key in value):
        _fail(path)  # a host key that is not a str is refused, never a TypeError
    for name in sorted(set(names) | set(value)):
        if name not in value or name not in names:
            _fail(path + "." + name)


def _int_from(value, path, low):
    if type(value) is not int or value < low or value > canon.MAX_SAFE_INTEGER:
        _fail(path)


def _hexn(value, path, n):
    if type(value) is not str or len(value) != n or not set(value) <= _HEX:
        _fail(path)


def _hex64(value, path):
    _hexn(value, path, 64)


def _exact(value, path, expected):
    if type(value) is not type(expected) or value != expected:
        _fail(path)


def _one_of(value, path, allowed):
    if type(value) is not str or value not in allowed:
        _fail(path)


def _key_bytes(value, path):
    """op and target: 1 to 64 key bytes (the key grammar of 3.1)."""
    if type(value) is not str or not 1 <= len(value) <= 64 or not set(value) <= _KEY_CHARS:
        _fail(path)


def _payload_hex(value, path):
    """Even length, lowercase hex, at most 512 digits (6.1)."""
    if type(value) is not str or len(value) > MAX_PAYLOAD_HEX or len(value) % 2 or not set(value) <= _HEX:
        _fail(path)


def _code(value, path):
    if type(value) is not str or not 1 <= len(value) <= 128 or value[0] not in _CODE_HEAD:
        _fail(path)
    if not set(value[1:]) <= _CODE_TAIL:
        _fail(path)


def _canonical(value):
    try:
        return canon.encode(value)
    except canon.Refused as refusal:
        raise ShapeRefused(refusal.code, refusal.at)


# ------------------------------------------------------------- keys, 6.4
def raw_key_bytes(spelled):
    """The 65 raw bytes of a P-256 public key given in its one base64url
    spelling, or None if the text is not that spelling of a curve point."""
    if type(spelled) is not str or len(spelled) != RAW_KEY_CHARS:
        return None
    acc = 0
    for ch in spelled:
        v = _B64URL_VALUE.get(ch)
        if v is None:
            return None
        acc = (acc << 6) | v
    if acc & 0b11:  # 87 * 6 = 522 bits: the last two must be zero
        return None
    raw = (acc >> 2).to_bytes(RAW_KEY_BYTES, "big")
    if raw[0] != 0x04:
        return None
    x = int.from_bytes(raw[1:33], "big")
    y = int.from_bytes(raw[33:], "big")
    if x >= _P or y >= _P or (y * y - (x * x * x - 3 * x + _B)) % _P:
        return None
    return raw


def check_key(value, path="key"):
    if raw_key_bytes(value) is None:
        _fail(path)


def key_thumb(raw_public_key_base64url):
    """digest("aukora.key.v1", {"key":"<the key>"})"""
    check_key(raw_public_key_base64url)
    return canon.digest("aukora.key.v1", _canonical({"key": raw_public_key_base64url}))


# ------------------------------------------------------------ lineage, 6.2
_UUID_GROUPS = (8, 4, 4, 4, 12)


def check_mirror_lineage_id(value, path="lineage.mirror"):
    """MIRROR's lineage id as it holds it: the lowercase UUID string, 8-4-4-4-12
    hex digits with its dashes. Anything else is SCHEMA (6.2)."""
    if type(value) is not str:
        _fail(path)
    groups = value.split("-")
    if [len(g) for g in groups] != list(_UUID_GROUPS) or not all(set(g) <= _HEX for g in groups):
        _fail(path)


def act_lineage_id(mirror_lineage_id, world=WORLD):
    """digest("aukora.act-lineage.v1", {"mirror":"<MIRROR's lineage id>","world":"node-main-v1"})"""
    check_mirror_lineage_id(mirror_lineage_id)
    _exact(world, "lineage.world", WORLD)
    return canon.digest("aukora.act-lineage.v1", _canonical({"mirror": mirror_lineage_id, "world": world}))


# ------------------------------------------------------------ command, 6.3
COMMAND_FIELDS = ("schema", "lineageId", "seq", "prev", "intentId", "op", "target", "payloadHex")


def check_command(value, path="command"):
    _fields(value, path, COMMAND_FIELDS)
    _exact(value["schema"], path + ".schema", COMMAND_SCHEMA)
    _hex64(value["lineageId"], path + ".lineageId")
    _int_from(value["seq"], path + ".seq", 1)
    _hex64(value["prev"], path + ".prev")
    _hexn(value["intentId"], path + ".intentId", 32)
    _key_bytes(value["op"], path + ".op")
    _key_bytes(value["target"], path + ".target")
    _payload_hex(value["payloadHex"], path + ".payloadHex")


def command_id(data):
    """An action's id: the digest of the command's canonical bytes."""
    return canon.digest("aukora.act.v1", data)


# ----------------------------------------------------------- envelope, 6.4
ENVELOPE_FIELDS = ("schema", "verb", "lineageId", "holderGeneration", "leaseGeneration", "actionId",
                   "signerThumb", "nextKey")
_SIGNING_PREFIX = ENVELOPE_SCHEMA.encode("ascii") + b"\x00"


def check_envelope(value, path="envelope"):
    _fields(value, path, ENVELOPE_FIELDS)
    _exact(value["schema"], path + ".schema", ENVELOPE_SCHEMA)
    _one_of(value["verb"], path + ".verb", VERBS)
    _hex64(value["lineageId"], path + ".lineageId")
    _int_from(value["holderGeneration"], path + ".holderGeneration", 0)
    _int_from(value["leaseGeneration"], path + ".leaseGeneration", 0)
    _hex64(value["actionId"], path + ".actionId")
    _hex64(value["signerThumb"], path + ".signerThumb")
    check_key(value["nextKey"], path + ".nextKey")


def envelope_digest(data):
    return canon.digest("aukora.proof.v3", data)


def envelope_signing_message(data):
    """ascii("aukora.proof.v3") || 0x00 || envelope bytes: what ECDSA P-256 with
    SHA-256 signs. sha256 of these bytes is envelope_digest(data)."""
    if not isinstance(data, (bytes, bytearray)):
        raise TypeError("envelope_signing_message takes bytes")
    return _SIGNING_PREFIX + bytes(data)


# ------------------------------------------------------------ request, 6.4
REQUEST_FIELDS = ("schema", "command", "envelope", "signature")


def _request_shape(value):
    path = "request"
    _fields(value, path, REQUEST_FIELDS)
    _exact(value["schema"], path + ".schema", REQUEST_SCHEMA)
    envelope = value["envelope"]
    check_envelope(envelope, path + ".envelope")
    _hexn(value["signature"], path + ".signature", 128)
    command = value["command"]
    if envelope["verb"] in VERBS_WITH_COMMAND:
        if command is None:
            _fail(path + ".command")
        check_command(command, path + ".command")
        if command_id(canon.encode(command)) != envelope["actionId"]:  # MUTATION-POINT action-id
            raise ShapeRefused("CAPSULE_ACTION_ID_MISMATCH", path + ".envelope.actionId")
    elif command is not None:  # MUTATION-POINT commit-command
        _fail(path + ".command")


def check_request(value):
    """A host value: its canonical bytes (at most 4,096), the closed shape, then
    the command's digest against envelope.actionId."""
    data = _canonical(value)
    if len(data) > MAX_REQUEST_BYTES:
        raise ShapeRefused("LIMIT", MAX_REQUEST_BYTES)
    _request_shape(value)


def check_request_bytes(data):
    """Bytes as they reach the door: size, the canonical parse, the shape, the id."""
    data = bytes(data)
    if len(data) > MAX_REQUEST_BYTES:
        raise ShapeRefused("LIMIT", MAX_REQUEST_BYTES)
    try:
        value = canon.parse(data)
    except canon.Refused as refusal:
        raise ShapeRefused(refusal.code, refusal.at)
    _request_shape(value)
    return value


# ------------------------------------------- answers, reads and rows, 6.5a
def _nullable_hex64(value, path):
    if value is not None:
        _hex64(value, path)


def _bool(value, path):
    if type(value) is not bool:
        _fail(path)


def check_verdict(value, path="verdict"):
    """{ decision, reason, policyDigest }: the gate's result (section 8)."""
    _fields(value, path, ("decision", "reason", "policyDigest"))
    _one_of(value["decision"], path + ".decision", DECISIONS)
    _code(value["reason"], path + ".reason")
    _hex64(value["policyDigest"], path + ".policyDigest")


def check_chain(value, path="chain"):
    """{ firstThumb, currentThumb, lastDigest | null, locked }"""
    _fields(value, path, ("firstThumb", "currentThumb", "lastDigest", "locked"))
    _hex64(value["firstThumb"], path + ".firstThumb")
    _hex64(value["currentThumb"], path + ".currentThumb")
    _nullable_hex64(value["lastDigest"], path + ".lastDigest")
    _bool(value["locked"], path + ".locked")


def _ledger_head(value, path):
    """{ seq, id }: genesis is (0, 64 zeros) (6.6)."""
    _fields(value, path, ("seq", "id"))
    _int_from(value["seq"], path + ".seq", 0)
    _hex64(value["id"], path + ".id")


def check_row(value, path="row"):
    """A retained ledger row (6.5a, 6.6). Its command is the command of 6.3."""
    _fields(value, path, ("seq", "actionId", "intentId", "state", "command", "intentBy", "resolvedBy", "gate"))
    _int_from(value["seq"], path + ".seq", 1)
    _hex64(value["actionId"], path + ".actionId")
    _hexn(value["intentId"], path + ".intentId", 32)
    _one_of(value["state"], path + ".state", ROW_STATES)
    check_command(value["command"], path + ".command")
    by = value["intentBy"]
    _fields(by, path + ".intentBy", ("keyThumb", "holderGeneration", "chainFirstThumb"))
    _hex64(by["keyThumb"], path + ".intentBy.keyThumb")
    _int_from(by["holderGeneration"], path + ".intentBy.holderGeneration", 0)
    _hex64(by["chainFirstThumb"], path + ".intentBy.chainFirstThumb")
    resolved = value["resolvedBy"]
    if resolved is not None:
        _fields(resolved, path + ".resolvedBy", ("keyThumb", "holderGeneration"))
        _hex64(resolved["keyThumb"], path + ".resolvedBy.keyThumb")
        _int_from(resolved["holderGeneration"], path + ".resolvedBy.holderGeneration", 0)
    gate = value["gate"]
    _fields(gate, path + ".gate", ("creation", "commit"))
    check_verdict(gate["creation"], path + ".gate.creation")
    if gate["commit"] is not None:
        check_verdict(gate["commit"], path + ".gate.commit")
    _row_rules(value, path)  # MUTATION-POINT row-rules


def _row_rules(value, path):
    """6.5a "What every row obeys" (ruling 10) and ruling 12, after the field
    shapes: each broken rule is SCHEMA at the member that breaks it."""
    command = value["command"]
    if value["actionId"] != command_id(canon.encode(command)):  # MUTATION-POINT row-action-id
        _fail(path + ".actionId")
    if value["seq"] != command["seq"]:  # MUTATION-POINT row-seq
        _fail(path + ".seq")
    if value["intentId"] != command["intentId"]:  # MUTATION-POINT row-intent-id
        _fail(path + ".intentId")
    state, commit = value["state"], value["gate"]["commit"]
    if (value["resolvedBy"] is None) != (state == "pending"):  # MUTATION-POINT row-resolved
        _fail(path + ".resolvedBy")
    if (commit is not None) != (state == "committed"):  # MUTATION-POINT row-commit-verdict
        _fail(path + ".gate.commit")
    if commit is not None and commit["decision"] != "ALLOW":  # MUTATION-POINT commit-allow
        _fail(path + ".gate.commit.decision")


def _closed(check, value, path):
    """A whole answer, read or status is an aukora.canon.v1 object: encode, then the shape."""
    _canonical(value)
    check(value, path)


def _answer_code(result, code, path):
    if result == "refused":
        _one_of(code, path, ACT_DOOR_CODES)
    elif code is not None:
        _fail(path)


def _answer(value, path):
    _fields(value, path, ("schema", "envelopeDigest", "verified", "result", "code", "row", "head", "holderGeneration",
                          "holderKeyThumb", "chain"))
    _exact(value["schema"], path + ".schema", ANSWER_SCHEMA)
    _hex64(value["envelopeDigest"], path + ".envelopeDigest")
    _bool(value["verified"], path + ".verified")
    _one_of(value["result"], path + ".result", RESULTS)
    _answer_code(value["result"], value["code"], path + ".code")  # MUTATION-POINT answer-code
    if value["row"] is not None:
        check_row(value["row"], path + ".row")
    _answer_row(value["result"], value["code"], value["row"], path)  # MUTATION-POINT answer-row
    _answer_state(value, path)


def _answer_row(result, code, row, path):
    """6.5a "The row in an answer" (ruling 11). With pending, committed or
    abandoned the row is present and its state is the result. With refused
    it is null for the two codes of steps 1 and 2; otherwise null or a row
    (which row cannot be checked from the answer alone)."""
    if result in ROW_STATES:
        if row is None:
            _fail(path + ".row")
        if row["state"] != result:
            _fail(path + ".row.state")
    elif code in NO_STATE_CODES and row is not None:
        _fail(path + ".row")


def _answer_state(value, path):
    """6.5a "When the four state members are null" (ruling 9): all four null
    exactly at the refusals of steps 1 and 2; else head and holderGeneration
    present, and holderKeyThumb and chain both null only in a world with no
    holder, whose one answer is refused CAPSULE_INSTANCE_REVOKED."""
    if value["code"] in NO_STATE_CODES:  # MUTATION-POINT answer-no-state
        for name in ("head", "holderGeneration", "holderKeyThumb", "chain"):
            if value[name] is not None:
                _fail(path + "." + name)
        return
    _ledger_head(value["head"], path + ".head")
    _int_from(value["holderGeneration"], path + ".holderGeneration", 0)
    no_holder = _holder_and_chain(value, path)
    if no_holder and (value["result"], value["code"]) != ("refused", NO_HOLDER_CODE):  # MUTATION-POINT answer-no-holder
        _fail(path + ".holderKeyThumb")


def _holder_and_chain(value, path):
    """holderKeyThumb is null exactly when chain is null (ruling 9). Returns
    True for the no-holder form (both null)."""
    thumb, chain = value["holderKeyThumb"], value["chain"]
    if (thumb is None) != (chain is None):  # MUTATION-POINT thumb-chain
        _fail(path + (".holderKeyThumb" if thumb is None else ".chain"))
    if thumb is None:
        return True
    _hex64(thumb, path + ".holderKeyThumb")
    check_chain(chain, path + ".chain")
    return False


def check_answer(value, path="answer"):
    """aukora.act-answer.v1 (6.4, 6.5a): code is null unless result is refused,
    and then one of ACT_DOOR_CODES."""
    _closed(_answer, value, path)


def _read(value, path):
    _fields(value, path, ("schema", "verb", "actionId", "intentId"))
    _exact(value["schema"], path + ".schema", READ_SCHEMA)
    _one_of(value["verb"], path + ".verb", READ_VERBS)
    action_id, intent_id = value["actionId"], value["intentId"]
    if value["verb"] == "row":
        if (action_id is None) == (intent_id is None):  # MUTATION-POINT read-one-of
            _fail(path + ".actionId")  # neither or both: exactly one is required
        if action_id is not None:
            _hex64(action_id, path + ".actionId")
        else:
            _hexn(intent_id, path + ".intentId", 32)
    else:
        if action_id is not None:
            _fail(path + ".actionId")
        if intent_id is not None:
            _fail(path + ".intentId")


def check_read(value, path="read"):
    """aukora.act-read.v1: `row` takes exactly one of actionId and intentId;
    `status` and `pending` take both null."""
    _closed(_read, value, path)


def _status(value, path):
    _fields(value, path, ("schema", "lineageId", "holderGeneration", "holderKeyThumb", "lease", "chain", "head",
                          "pending"))
    _exact(value["schema"], path + ".schema", STATUS_SCHEMA)
    _hex64(value["lineageId"], path + ".lineageId")
    _int_from(value["holderGeneration"], path + ".holderGeneration", 0)
    _nullable_hex64(value["holderKeyThumb"], path + ".holderKeyThumb")
    check_lease(value["lease"], path + ".lease")
    if value["chain"] is not None:
        check_chain(value["chain"], path + ".chain")
    _ledger_head(value["head"], path + ".head")
    _bool(value["pending"], path + ".pending")
    # Ruling 9: a status of a world with no holder has holderKeyThumb and chain
    # null; every other status has both. head and holderGeneration always.
    _holder_and_chain(value, path)


def check_status(value, path="status"):
    """aukora.act-status.v1 (6.5, 6.5a)."""
    _closed(_status, value, path)


def _row_read(value, path):
    _fields(value, path, ("schema", "row"))
    _exact(value["schema"], path + ".schema", ROW_READ_SCHEMA)
    if value["row"] is not None:
        check_row(value["row"], path + ".row")


def check_row_read(value, path="rowread"):
    """aukora.act-row.v1: the answer to both the `pending` and the `row` read."""
    _closed(_row_read, value, path)


# --------------------------------------------------------------- gate, 8
def check_proposal(value, path="proposal"):
    _fields(value, path, ("verb", "command"))
    _one_of(value["verb"], path + ".verb", PROPOSAL_VERBS)
    check_command(value["command"], path + ".command")


def check_capability(value, path="capability"):
    _fields(value, path, ("holderGeneration", "rowGeneration", "ownerBound", "budget"))
    _int_from(value["holderGeneration"], path + ".holderGeneration", 0)
    if value["rowGeneration"] is not None:
        _int_from(value["rowGeneration"], path + ".rowGeneration", 0)
    _bool(value["ownerBound"], path + ".ownerBound")
    if value["budget"] is not None:  # null in this push
        _fail(path + ".budget")


def check_policy(value, path="policy"):
    _fields(value, path, ("schema", "version", "rules"))
    _exact(value["schema"], path + ".schema", POLICY_SCHEMA)
    _int_from(value["version"], path + ".version", 0)
    rules = value["rules"]
    if type(rules) is not list:
        _fail(path + ".rules")
    for i, rule in enumerate(rules):
        p = "%s.rules[%d]" % (path, i)
        _fields(rule, p, ("op", "target", "payloadHex", "needsBudget", "decision"))
        _key_bytes(rule["op"], p + ".op")
        _key_bytes(rule["target"], p + ".target")
        _payload_hex(rule["payloadHex"], p + ".payloadHex")
        _bool(rule["needsBudget"], p + ".needsBudget")
        _one_of(rule["decision"], p + ".decision", DECISIONS)


def check_court_result(value, path="courtResult"):
    if value is not None:  # null in this push; anything else is DENY at the gate
        _fail(path)


def check_lease(value, path="lease"):
    """{ held, generation } with an integer generation (8; also the status read)."""
    _fields(value, path, ("held", "generation"))
    _bool(value["held"], path + ".held")
    _int_from(value["generation"], path + ".generation", 0)


def check_logical_time(value, path="logicalTime"):
    _fields(value, path, ("seq", "rows"))
    _int_from(value["seq"], path + ".seq", 0)
    _int_from(value["rows"], path + ".rows", 0)


GATE_INPUT_FIELDS = ("proposal", "capability", "policy", "courtResult", "lease", "logicalTime")
_GATE_INPUT_CHECKS = (check_proposal, check_capability, check_policy, check_court_result, check_lease,
                      check_logical_time)


def check_gate_input(proposal, capability, policy, court_result, lease, logical_time):
    """Either call: every input is an aukora.canon.v1 object (8): each is encoded,
    then its shape. check_gate_inputs adds the rules of the two calls."""
    for name, value, check in zip(GATE_INPUT_FIELDS, (proposal, capability, policy, court_result, lease, logical_time),
                                  _GATE_INPUT_CHECKS):
        if value is not None:
            _canonical(value)
        check(value, name)


def check_gate_inputs(inputs, call):
    """Section 8, "The two calls and their inputs". `inputs` is the object
    { proposal, capability, policy, courtResult, lease, logicalTime }; `call` is
    "creation" (proposal.verb intent or act, capability.rowGeneration null) or
    "commit" (proposal.verb commit, rowGeneration an integer). In both,
    courtResult is null, ownerBound a boolean, lease { held, generation } with an
    integer generation."""
    _one_of(call, "call", GATE_CALLS)
    _canonical(inputs)
    path = "inputs"
    _fields(inputs, path, GATE_INPUT_FIELDS)
    for name, check in zip(GATE_INPUT_FIELDS, _GATE_INPUT_CHECKS):
        check(inputs[name], path + "." + name)
    proposal, capability = inputs["proposal"], inputs["capability"]
    _call_rules(call, proposal["verb"], capability["rowGeneration"], path)  # MUTATION-POINT gate-call
    # Ruling 13: in a commit call logicalTime.rows counts the row being committed,
    # so it is at least 1; in a creation call it is at least 0 (check_logical_time).
    if call == "commit" and inputs["logicalTime"]["rows"] < 1:  # MUTATION-POINT commit-rows
        _fail(path + ".logicalTime.rows")


def _call_rules(call, verb, row_generation, path):
    if call == "creation":
        if verb not in VERBS_WITH_COMMAND:
            _fail(path + ".proposal.verb")
        if row_generation is not None:
            _fail(path + ".capability.rowGeneration")
    else:
        if verb != "commit":
            _fail(path + ".proposal.verb")
        if row_generation is None:
            _fail(path + ".capability.rowGeneration")


def check_gate_output(value, path="result"):
    check_verdict(value, path)
