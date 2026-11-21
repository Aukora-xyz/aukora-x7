package ark

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

const PayloadType = "application/vnd.aukora.ark.v0.1+json"
const MaxPayload = 65536
const MaxDepth = 8

var (
	reHex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)
	reHex32 = regexp.MustCompile(`^[0-9a-f]{32}$`)
	reRid   = regexp.MustCompile(`^[a-z0-9-]{1,64}$`)
	reAname = regexp.MustCompile(`^[a-z_]{1,32}$`)
	reRes   = regexp.MustCompile(`^[a-z0-9._/-]{1,128}$`)
	reCode  = regexp.MustCompile(`^[A-Z_]{1,40}$`)
	reB64u  = regexp.MustCompile(`^[A-Za-z0-9_-]*$`)
)

func Hex(b []byte) string { return hex.EncodeToString(b) }
func SHA(b []byte) string  { s := sha256.Sum256(b); return Hex(s[:]) }
func KeyID(pub []byte) string {
	return SHA(pub)
}

// B64uDecode is the strict decoder of CONTRACT section 1.
func B64uDecode(s string) ([]byte, bool) {
	if !reB64u.MatchString(s) || len(s)%4 == 1 {
		return nil, false
	}
	b, err := base64.RawURLEncoding.Strict().DecodeString(s)
	if err != nil {
		return nil, false
	}
	if base64.RawURLEncoding.EncodeToString(b) != s {
		return nil, false
	}
	return b, true
}
func B64u(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func PAE(payload []byte) []byte {
	h := fmt.Sprintf("DSSEv1 %d %s %d ", len(PayloadType), PayloadType, len(payload))
	return append([]byte(h), payload...)
}

func IsHex64(s string) bool { return reHex64.MatchString(s) }
func IsHex32(s string) bool { return reHex32.MatchString(s) }
func IsRid(s string) bool   { return reRid.MatchString(s) }
func IsRes(s string) bool   { return reRes.MatchString(s) }
func IsAname(s string) bool { return reAname.MatchString(s) }

// textRule: 1..max UTF-8 bytes, no code point below U+0020, no U+007F.
func textRule(s string, max int) bool {
	if len(s) < 1 || len(s) > max || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}
func IsLine(s string) bool { return textRule(s, 200) }

// Item is one envelope after pass 1 (E1-E5).
type Item struct {
	Index       int
	PayloadType string
	PayloadB64  string
	KeyID       string
	SigB64      string
	Payload     []byte
	Sig         []byte
	Type        string
	O           *Obj
	Hash        string
}

// Raw envelope fields from a parsed JSON value. Returns "" or BAD_ENVELOPE.
func envelopeFields(v any) (*Item, string) {
	o, ok := v.(*Obj)
	if !ok || !exact(o, "payloadType", "payload", "signatures") {
		return nil, "BAD_ENVELOPE"
	}
	pt, ok1 := o.M["payloadType"].(string)
	pl, ok2 := o.M["payload"].(string)
	sigs, ok3 := o.M["signatures"].([]any)
	if !ok1 || !ok2 || !ok3 || len(sigs) != 1 {
		return nil, "BAD_ENVELOPE"
	}
	so, ok := sigs[0].(*Obj)
	if !ok || !exact(so, "keyid", "sig") {
		return nil, "BAD_ENVELOPE"
	}
	kid, ok1 := so.M["keyid"].(string)
	sig, ok2 := so.M["sig"].(string)
	if !ok1 || !ok2 || !IsHex64(kid) {
		return nil, "BAD_ENVELOPE"
	}
	return &Item{PayloadType: pt, PayloadB64: pl, KeyID: kid, SigB64: sig}, ""
}

// DecodeItem runs pass 1 (E1, E2, E3, E4s, E4, E5). Reason "" means OK.
func DecodeItem(v any) (*Item, string) {
	it, r := envelopeFields(v)
	if r != "" {
		return nil, r
	}
	if it.PayloadType != PayloadType {
		return it, "BAD_PAYLOAD_TYPE"
	}
	pl, ok := B64uDecode(it.PayloadB64)
	if !ok {
		return it, "BAD_ENCODING"
	}
	sig, ok := B64uDecode(it.SigB64)
	if !ok || len(sig) != 64 {
		return it, "BAD_ENCODING"
	}
	it.Payload, it.Sig = pl, sig
	if len(pl) > MaxPayload {
		return it, "BAD_SCHEMA"
	}
	o, err := ParseStrict(pl, MaxDepth)
	if err != nil {
		return it, "BAD_JSON"
	}
	if !nullsAllowed(o) {
		return it, "BAD_JSON" // section 3 rule 6, which E4 places under BAD_JSON
	}
	it.O = o
	t, ok := CheckSchema(o)
	if !ok {
		return it, "BAD_SCHEMA"
	}
	it.Type = t
	it.Hash = SHA(pl)
	return it, ""
}

// nullsAllowed: rule 6, null only where a field says "or null" (outcome.approval, outcome.effect).
func nullsAllowed(o *Obj) bool {
	isOutcome := S(o, "type") == "outcome"
	var walk func(v any, top bool, key string) bool
	walk = func(v any, top bool, key string) bool {
		switch x := v.(type) {
		case Null:
			return top && isOutcome && (key == "approval" || key == "effect")
		case *Obj:
			for _, k := range x.Keys {
				if !walk(x.M[k], false, k) {
					return false
				}
			}
		case []any:
			for _, e := range x {
				if !walk(e, false, "") {
					return false
				}
			}
		}
		return true
	}
	for _, k := range o.Keys {
		if !walk(o.M[k], true, k) {
			return false
		}
	}
	return true
}

func (it *Item) VerifyWith(pub []byte) bool {
	return ed25519.Verify(ed25519.PublicKey(pub), PAE(it.Payload), it.Sig)
}

// EnvelopeJSON re-emits the envelope (strings only; payload bytes are carried
// unchanged inside the payload string, so nothing is re-serialised for hashing).
func (it *Item) EnvelopeJSON() string {
	return `{"payloadType":` + jstr(it.PayloadType) + `,"payload":` + jstr(it.PayloadB64) +
		`,"signatures":[{"keyid":` + jstr(it.KeyID) + `,"sig":` + jstr(it.SigB64) + `}]}`
}

// jstr: our strings here are base64url / hex / fixed ASCII, but escape anyway.
func jstr(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"':
			b.WriteString(`\"`)
		case r == '\\':
			b.WriteString(`\\`)
		case r < 0x20:
			fmt.Fprintf(&b, `\u%04x`, r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}
func JStr(s string) string { return jstr(s) }

// Sign makes an envelope for payload bytes with a private key.
func Sign(priv ed25519.PrivateKey, payload []byte) *Item {
	pub := priv.Public().(ed25519.PublicKey)
	sig := ed25519.Sign(priv, PAE(payload))
	return &Item{PayloadType: PayloadType, PayloadB64: B64u(payload), KeyID: KeyID(pub),
		SigB64: B64u(sig), Payload: payload, Sig: sig, Hash: SHA(payload)}
}

// ParseEnvelopeFile parses a standalone envelope JSON file through pass 1.
func ParseEnvelopeFile(b []byte) (*Item, string) {
	o, err := ParseUnsigned(b, MaxDepth)
	if err != nil {
		return nil, "BAD_JSON"
	}
	return DecodeItem(o)
}
