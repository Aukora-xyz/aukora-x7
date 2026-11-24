package ark

// exact: the object has exactly these keys (rule 7).
func exact(o *Obj, names ...string) bool {
	if len(o.Keys) != len(names) {
		return false
	}
	for _, n := range names {
		if _, ok := o.M[n]; !ok {
			return false
		}
	}
	return true
}
func Exact(o *Obj, names ...string) bool { return exact(o, names...) }

func S(o *Obj, k string) string { s, _ := o.M[k].(string); return s }
func N(o *Obj, k string) uint64 { n, _ := o.M[k].(Int); return uint64(n) }
func O(o *Obj, k string) *Obj   { x, _ := o.M[k].(*Obj); return x }
func IsNull(o *Obj, k string) bool {
	_, ok := o.M[k].(Null)
	return ok
}

func str(o *Obj, k string, f func(string) bool) bool {
	s, ok := o.M[k].(string)
	return ok && f(s)
}
func intMin(o *Obj, k string, min uint64) bool {
	n, ok := o.M[k].(Int)
	return ok && uint64(n) >= min
}
func eq(v string) func(string) bool { return func(s string) bool { return s == v } }
func oneOf(vs ...string) func(string) bool {
	return func(s string) bool {
		for _, v := range vs {
			if s == v {
				return true
			}
		}
		return false
	}
}
func isCode(s string) bool { return reCode.MatchString(s) }

// CheckSchema applies section 4 (and section 3 rule 7). Returns the type.
func CheckSchema(o *Obj) (string, bool) {
	if !str(o, "v", eq("0.1")) {
		return "", false
	}
	t, ok := o.M["type"].(string)
	if !ok {
		return "", false
	}
	switch t {
	case "grant":
		if !exact(o, "v", "type", "grant_id", "owner_key", "client_key", "receiver_id", "scope", "not_after") {
			return "", false
		}
		sc := O(o, "scope")
		return t, str(o, "grant_id", IsHex32) && str(o, "owner_key", IsHex64) && str(o, "client_key", IsHex64) &&
			str(o, "receiver_id", IsRid) && sc != nil && exact(sc, "action", "resource") &&
			str(sc, "action", IsAname) && str(sc, "resource", IsRes) && intMin(o, "not_after", 0)
	case "authority":
		if !exact(o, "v", "type", "owner_key", "receiver_id", "epoch", "grants") {
			return "", false
		}
		gs, ok := o.M["grants"].([]any)
		if !ok || len(gs) > 64 {
			return "", false
		}
		seen := map[string]bool{}
		for _, g := range gs {
			s, ok := g.(string)
			if !ok || !IsHex64(s) || seen[s] {
				return "", false
			}
			seen[s] = true
		}
		return t, str(o, "owner_key", IsHex64) && str(o, "receiver_id", IsRid) && intMin(o, "epoch", 1)
	case "proposal":
		if !exact(o, "v", "type", "op_id", "grant", "action", "created_at") {
			return "", false
		}
		a := O(o, "action")
		return t, str(o, "op_id", IsHex32) && str(o, "grant", IsHex64) && a != nil &&
			exact(a, "name", "resource", "text") && str(a, "name", IsAname) && str(a, "resource", IsRes) &&
			str(a, "text", IsLine) && intMin(o, "created_at", 0)
	case "approval":
		if !exact(o, "v", "type", "proposal", "receiver_id", "epoch", "decision", "not_after") {
			return "", false
		}
		return t, str(o, "proposal", IsHex64) && str(o, "receiver_id", IsRid) && intMin(o, "epoch", 1) &&
			str(o, "decision", oneOf("approve", "refuse")) && intMin(o, "not_after", 0)
	case "outcome":
		if !exact(o, "v", "type", "receiver_id", "op_id", "proposal", "approval", "epoch", "status", "reason",
			"effect", "seq", "prev", "at") {
			return "", false
		}
		apOK := IsNull(o, "approval") || str(o, "approval", IsHex64)
		efOK := IsNull(o, "effect")
		if e := O(o, "effect"); e != nil {
			efOK = exact(e, "resource", "before_sha256", "after_sha256") && str(e, "resource", IsRes) &&
				str(e, "before_sha256", IsHex64) && str(e, "after_sha256", IsHex64)
		}
		return t, str(o, "receiver_id", IsRid) && str(o, "op_id", IsHex32) && str(o, "proposal", IsHex64) &&
			apOK && intMin(o, "epoch", 0) && str(o, "status", oneOf("DONE", "REFUSED")) &&
			str(o, "reason", isCode) && (S(o, "status") != "DONE" || S(o, "reason") == "OK") && efOK && intMin(o, "seq", 1) && str(o, "prev", IsHex64) &&
			intMin(o, "at", 0)
	case "note":
		if !exact(o, "v", "type", "about", "label", "grants", "text") {
			return "", false
		}
		return t, str(o, "about", IsHex64) && str(o, "label", oneOf("assessment", "summary")) &&
			str(o, "grants", eq("none")) && str(o, "text", func(s string) bool { return textRule(s, 1000) })
	}
	return "", false
}

// RoleOK: section 4 role rule.
func RoleOK(role, typ string) bool {
	switch role {
	case "owner":
		return typ == "grant" || typ == "authority" || typ == "approval" || typ == "note"
	case "receiver":
		return typ == "outcome" || typ == "note"
	case "client":
		return typ == "proposal" || typ == "note"
	}
	return false
}
