package ark

import (
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"unicode/utf8"
)

type Pins struct {
	OwnerKey, ReceiverKey, ReceiverID, SuppliedBy string
	owner, recv                                   []byte
}

// ParsePins: section 6. Any problem is an error (verifier exit 2).
func ParsePins(b []byte) (*Pins, error) {
	bad := errors.New("bad pins file")
	o, err := ParseUnsigned(b, MaxDepth)
	if err != nil || !exact(o, "v", "owner_key", "receiver_key", "receiver_id", "supplied_by") ||
		!str(o, "v", eq("0.1")) || !str(o, "owner_key", IsHex64) || !str(o, "receiver_key", IsHex64) ||
		!str(o, "receiver_id", IsRid) ||
		!str(o, "supplied_by", func(s string) bool { return len(s) >= 1 && len(s) <= 200 && utf8.ValidString(s) }) {
		return nil, bad
	}
	p := &Pins{OwnerKey: S(o, "owner_key"), ReceiverKey: S(o, "receiver_key"), ReceiverID: S(o, "receiver_id"),
		SuppliedBy: S(o, "supplied_by")}
	if p.OwnerKey == p.ReceiverKey {
		return nil, bad
	}
	p.owner, _ = hex.DecodeString(p.OwnerKey)
	p.recv, _ = hex.DecodeString(p.ReceiverKey)
	return p, nil
}

type Bundle struct {
	Coverage string
	Items    []any
}

// ParseBundle: section 6. Error means BAD_BUNDLE.
func ParseBundle(b []byte) (*Bundle, error) {
	bad := errors.New("BAD_BUNDLE")
	o, err := ParseUnsigned(b, MaxDepth)
	if err != nil || !exact(o, "v", "coverage", "items") || !str(o, "v", eq("0.1")) {
		return nil, bad
	}
	cov, ok := o.M["coverage"].(string)
	if !ok || len(cov) < 1 || len(cov) > 500 {
		return nil, bad
	}
	items, ok := o.M["items"].([]any)
	if !ok || len(items) < 1 || len(items) > 10000 {
		return nil, bad
	}
	return &Bundle{Coverage: cov, Items: items}, nil
}

type Result struct {
	Lines []string
	Exit  int
}

// EscapeHeader (C22): U+0000..U+001F and U+007F as \n, \r, \t or \u00xx; all else as supplied.
func EscapeHeader(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i] // control code points are single bytes in UTF-8; other bytes pass through unchanged
		switch {
		case c == '\n':
			out = append(out, '\\', 'n')
		case c == '\r':
			out = append(out, '\\', 'r')
		case c == '\t':
			out = append(out, '\\', 't')
		case c < 0x20 || c == 0x7f:
			out = append(out, []byte(fmt.Sprintf("\\u%04x", c))...)
		default:
			out = append(out, c)
		}
	}
	return string(out)
}

// Verify implements section 8 given a parsed bundle and pins.
func Verify(bu *Bundle, p *Pins) Result {
	lines := []string{"coverage: " + EscapeHeader(bu.Coverage)}
	lines = append(lines, "pins supplied by: "+EscapeHeader(p.SuppliedBy),"integrity only; freshness and completeness not shown")

	n := len(bu.Items)
	items := make([]*Item, n)
	res := make([]string, n) // "" OK, else reason, or "UNTRUSTED_KEY"
	resolved := make([]bool, n)
	for i, v := range bu.Items {
		it, r := DecodeItem(v)
		if it != nil {
			it.Index = i
		}
		items[i], res[i] = it, r
		if r != "" {
			resolved[i] = true
		}
	}
	kOwner, kRecv := KeyID(p.owner), KeyID(p.recv)
	// S1
	for i, it := range items {
		if resolved[i] {
			continue
		}
		var key []byte
		role := ""
		if it.KeyID == kOwner {
			key, role = p.owner, "owner"
		} else if it.KeyID == kRecv {
			key, role = p.recv, "receiver"
		} else {
			continue
		}
		resolved[i] = true
		if !it.VerifyWith(key) {
			res[i] = "BAD_SIGNATURE"
		} else if !RoleOK(role, it.Type) {
			res[i] = "WRONG_SIGNER"
		}
	}
	// S2
	clients := map[string][]byte{}
	for i, it := range items {
		if it != nil && res[i] == "" && resolved[i] && it.Type == "grant" {
			ck, _ := hex.DecodeString(S(it.O, "client_key"))
			clients[KeyID(ck)] = ck
		}
	}
	for i, it := range items {
		if resolved[i] {
			continue
		}
		ck, ok := clients[it.KeyID]
		if !ok {
			continue
		}
		resolved[i] = true
		if !it.VerifyWith(ck) {
			res[i] = "BAD_SIGNATURE"
		} else if !RoleOK("client", it.Type) {
			res[i] = "WRONG_SIGNER"
		}
	}
	// S3
	unverifiedNote := make([]bool, n)
	for i, it := range items {
		if resolved[i] {
			continue
		}
		if it.Type == "note" {
			unverifiedNote[i] = true
		} else {
			res[i] = "UNTRUSTED_KEY"
		}
	}
	for i := range items {
		if res[i] != "" && res[i] != "UNTRUSTED_KEY" {
			lines = append(lines, "BUNDLE INVALID "+res[i]+" item="+itoa(i))
			return Result{lines, 4}
		}
	}
	for i := range items {
		if res[i] == "UNTRUSTED_KEY" {
			lines = append(lines, "BUNDLE UNTRUSTED_KEY item="+itoa(i))
			return Result{lines, 5}
		}
	}
	lines = append(lines, "BUNDLE OK")

	// 8.2: dedupe by (hash, type); notes never count.
	byHash := map[string]map[string][]*Item{} // type -> hash -> items (all envelopes of that payload)
	for _, t := range []string{"grant", "authority", "proposal", "approval", "outcome"} {
		byHash[t] = map[string][]*Item{}
	}
	for i, it := range items {
		if unverifiedNote[i] || it.Type == "note" {
			continue
		}
		byHash[it.Type][it.Hash] = append(byHash[it.Type][it.Hash], it)
	}
	ops := map[string]bool{}
	outcomes := map[string][]*Item{} // op_id -> distinct outcomes
	for _, t := range []string{"proposal", "outcome"} {
		for _, list := range byHash[t] {
			op := S(list[0].O, "op_id")
			ops[op] = true
			if t == "outcome" {
				outcomes[op] = append(outcomes[op], list[0])
			}
		}
	}
	ids := make([]string, 0, len(ops))
	for k := range ops {
		ids = append(ids, k)
	}
	sort.Strings(ids)
	anyInvalid, anyUnknown := false, false
	for _, x := range ids {
		v := opVerdict(x, outcomes[x], byHash, p)
		lines = append(lines, "OP "+x+" "+v)
		if v == "UNKNOWN" {
			anyUnknown = true
		} else if v != "DONE" && v != "REFUSED" {
			anyInvalid = true
		}
	}
	switch {
	case anyInvalid:
		return Result{lines, 4}
	case anyUnknown:
		return Result{lines, 3}
	}
	return Result{lines, 0}
}

func opVerdict(x string, outs []*Item, by map[string]map[string][]*Item, p *Pins) string {
	if len(outs) == 0 {
		return "UNKNOWN"
	}
	if len(outs) > 1 {
		return "INVALID CONFLICTING_OUTCOMES"
	}
	o := outs[0].O
	if S(o, "receiver_id") != p.ReceiverID {
		return "INVALID WRONG_RECEIVER"
	}
	var P *Item
	var pEnvs []*Item
	if l := by["proposal"][S(o, "proposal")]; len(l) > 0 && S(l[0].O, "op_id") == x {
		P, pEnvs = l[0], l
	}
	if P == nil {
		return "INVALID PROPOSAL_MISSING"
	}
	status := S(o, "status")
	effNull := IsNull(o, "effect")
	if (status == "DONE" && effNull) || (status == "REFUSED" && !effNull) {
		return "INVALID BAD_OUTCOME"
	}
	if status == "REFUSED" {
		return "REFUSED"
	}
	if IsNull(o, "approval") || len(by["approval"][S(o, "approval")]) == 0 {
		return "INVALID NO_APPROVAL"
	}
	A := by["approval"][S(o, "approval")][0].O
	if S(A, "decision") != "approve" {
		return "INVALID APPROVAL_NOT_APPROVE"
	}
	if S(A, "proposal") != S(o, "proposal") {
		return "INVALID APPROVAL_MISMATCH"
	}
	if S(A, "receiver_id") != p.ReceiverID {
		return "INVALID WRONG_RECEIVER"
	}
	if N(A, "epoch") != N(o, "epoch") {
		return "INVALID STALE_EPOCH"
	}
	if N(A, "not_after") < N(o, "at") {
		return "INVALID APPROVAL_EXPIRED"
	}
	gl := by["grant"][S(P.O, "grant")]
	if len(gl) == 0 {
		return "INVALID GRANT_MISSING"
	}
	G := gl[0].O
	if S(G, "owner_key") != p.OwnerKey {
		return "INVALID WRONG_OWNER"
	}
	if S(G, "receiver_id") != p.ReceiverID {
		return "INVALID WRONG_RECEIVER"
	}
	ck, _ := hex.DecodeString(S(G, "client_key"))
	clientOK := false
	for _, e := range pEnvs {
		if e.KeyID == KeyID(ck) {
			clientOK = true
		}
	}
	if !clientOK {
		return "INVALID WRONG_CLIENT"
	}
	act, sc := O(P.O, "action"), O(G, "scope")
	if S(sc, "action") != S(act, "name") || S(sc, "resource") != S(act, "resource") {
		return "INVALID SCOPE_MISMATCH"
	}
	if N(G, "not_after") < N(o, "at") {
		return "INVALID GRANT_EXPIRED"
	}
	found := false
	for _, al := range by["authority"] {
		a := al[0].O
		if N(a, "epoch") != N(o, "epoch") || S(a, "receiver_id") != p.ReceiverID || S(a, "owner_key") != p.OwnerKey {
			continue
		}
		for _, g := range a.M["grants"].([]any) {
			if g.(string) == S(P.O, "grant") {
				found = true
			}
		}
	}
	if !found {
		return "INVALID GRANT_NOT_IN_AUTHORITY"
	}
	if S(O(o, "effect"), "resource") != S(act, "resource") {
		return "INVALID EFFECT_MISMATCH"
	}
	return "DONE"
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}
