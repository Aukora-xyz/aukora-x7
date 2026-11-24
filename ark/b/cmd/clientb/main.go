// clientb: reader 2's client (CONTRACT sections 4, 9). Go standard library only.
//
//	clientb init     --home C
//	clientb propose  --home C --grant FILE --text TEXT [--op-id HEX32] [--action N] [--resource R] --out FILE
//	clientb send     --home C --receiver-home R --grant FILE --proposal FILE [--approval FILE] [--note FILE]... [--request-id ID] [--wait-ms N]
//	clientb retry    --home C --receiver-home R --op-id HEX32 [--request-id ID] [--wait-ms N]
//	clientb status   --home C --receiver-home R --op-id HEX32 [--request-id ID] [--wait-ms N]
//	clientb collect  --home C --receiver-home R --request-id ID
//	clientb pending  --home C
//	clientb keep     --home C FILE...
//	clientb export   --home C --receiver-id RID --out FILE
//
// Exit codes: 0 DONE/ok, 1 REFUSED, 2 usage or I/O, 3 UNKNOWN, 4 REJECTED.
// Rule kept here: after a send whose answer is not in, the op is UNKNOWN; propose refuses to
// make a new op_id until every sent op is settled; retry re-sends the SAME request bytes.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"arkb/ark"
)

func die(code int, f string, a ...any) {
	fmt.Fprintf(os.Stderr, "clientb: "+f+"\n", a...)
	os.Exit(code)
}

type flags struct {
	one   map[string]string
	multi map[string][]string
	pos   []string
}

func parse(args []string) flags {
	f := flags{one: map[string]string{}, multi: map[string][]string{}}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if strings.HasPrefix(a, "--") {
			if i+1 >= len(args) {
				die(2, "missing value for %s", a)
			}
			k := a[2:]
			f.one[k] = args[i+1]
			f.multi[k] = append(f.multi[k], args[i+1])
			i++
		} else {
			f.pos = append(f.pos, a)
		}
	}
	return f
}
func (f flags) need(k string) string {
	v, ok := f.one[k]
	if !ok || v == "" {
		die(2, "missing --%s", k)
	}
	return v
}

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		die(2, "random: %v", err)
	}
	return hex.EncodeToString(b)
}

func writeAtomic(path string, data []byte) {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		die(2, "write %s: %v", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		die(2, "rename %s: %v", path, err)
	}
}

func loadKey(home string) ed25519.PrivateKey {
	b, err := os.ReadFile(filepath.Join(home, "key.json"))
	if err != nil {
		die(2, "no client key in %s", home)
	}
	o, err := ark.ParseStrict(b, 8)
	if err != nil || !ark.Exact(o, "v", "seed") || !ark.IsHex64(ark.S(o, "seed")) {
		die(2, "bad key.json")
	}
	seed, _ := hex.DecodeString(ark.S(o, "seed"))
	return ed25519.NewKeyFromSeed(seed)
}

func readEnv(path string) *ark.Item {
	b, err := os.ReadFile(path)
	if err != nil {
		die(2, "read %s: %v", path, err)
	}
	it, r := ark.ParseEnvelopeFile(b)
	if r != "" {
		die(2, "%s: %s", path, r)
	}
	return it
}

// record: one file per distinct envelope (payload hash + keyid + sig).
func keep(home string, it *ark.Item) {
	dir := filepath.Join(home, "record")
	os.MkdirAll(dir, 0o700)
	name := it.Hash + "-" + ark.SHA([]byte(it.KeyID+" "+it.SigB64))[:16] + ".json"
	p := filepath.Join(dir, name)
	if _, err := os.Stat(p); err == nil {
		return
	}
	writeAtomic(p, []byte(it.EnvelopeJSON()+"\n"))
}

// op state file: <home>/ops/<op_id>.json = {"v":"0.1","op_id":..,"state":..,"request":"<b64u request bytes>"}
type opState struct{ OpID, State, Request string }

func opPath(home, op string) string { return filepath.Join(home, "ops", op+".json") }
func saveOp(home string, s opState) {
	os.MkdirAll(filepath.Join(home, "ops"), 0o700)
	writeAtomic(opPath(home, s.OpID), []byte(`{"v":"0.1","op_id":`+ark.JStr(s.OpID)+`,"state":`+ark.JStr(s.State)+
		`,"request":`+ark.JStr(s.Request)+"}\n"))
}
func loadOp(home, op string) (opState, bool) {
	b, err := os.ReadFile(opPath(home, op))
	if err != nil {
		return opState{}, false
	}
	o, err := ark.ParseStrict(b, 8)
	if err != nil {
		die(2, "corrupt op state %s", op)
	}
	return opState{ark.S(o, "op_id"), ark.S(o, "state"), ark.S(o, "request")}, true
}
func allOps(home string) []opState {
	es, _ := os.ReadDir(filepath.Join(home, "ops"))
	var out []opState
	for _, e := range es {
		if strings.HasSuffix(e.Name(), ".json") {
			if s, ok := loadOp(home, strings.TrimSuffix(e.Name(), ".json")); ok {
				out = append(out, s)
			}
		}
	}
	return out
}

// request map: <home>/requests/<request_id> = "<kind> <op_id>"
func mapRequest(home, rid, kind, op string) {
	os.MkdirAll(filepath.Join(home, "requests"), 0o700)
	writeAtomic(filepath.Join(home, "requests", rid), []byte(kind+" "+op+"\n"))
}

var reqID = func(s string) bool {
	if len(s) < 1 || len(s) > 80 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	return true
}

func putRequest(rhome, rid string, body []byte) {
	inbox := filepath.Join(rhome, "inbox")
	if _, err := os.Stat(inbox); err != nil {
		die(2, "no inbox at %s", inbox)
	}
	final := filepath.Join(inbox, rid+".req.json")
	if _, err := os.Stat(final); err == nil {
		die(2, "request id %s already used", rid)
	}
	writeAtomic(final, body)
}

// answer handling ----------------------------------------------------------

type answer struct {
	Kind, RequestID, Status, Reason string
	Outcome, Authority             *ark.Item
}

func readAnswer(path string) (*answer, bool, string) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, false, ""
	}
	o, err := ark.ParseUnsigned(b, 8)
	if err != nil || !ark.Exact(o, "v", "kind", "request_id", "status", "reason", "outcome", "authority") ||
		ark.S(o, "v") != "0.1" {
		return nil, true, "answer file is not a contract answer"
	}
	a := &answer{Kind: ark.S(o, "kind"), RequestID: ark.S(o, "request_id"), Status: ark.S(o, "status"),
		Reason: ark.S(o, "reason")}
	for _, k := range []string{"outcome", "authority"} {
		if ark.IsNull(o, k) {
			continue
		}
		it, r := ark.DecodeItem(o.M[k])
		if r != "" {
			return nil, true, k + " in answer: " + r
		}
		if k == "outcome" {
			a.Outcome = it
		} else {
			a.Authority = it
		}
	}
	return a, true, ""
}

func exitFor(status string) int {
	switch status {
	case "DONE", "ACCEPTED":
		return 0
	case "REFUSED":
		return 1
	case "UNKNOWN":
		return 3
	case "REJECTED":
		return 4
	}
	return 2
}

// settle applies an answer to the client's record and op state; prints and exits.
func settle(home, rid string, a *answer) {
	if a.Outcome != nil {
		if a.Outcome.Type != "outcome" {
			die(2, "answer outcome is a %s", a.Outcome.Type)
		}
		keep(home, a.Outcome)
	}
	if a.Authority != nil {
		keep(home, a.Authority)
	}
	m, _ := os.ReadFile(filepath.Join(home, "requests", rid))
	parts := strings.Fields(string(m))
	if len(parts) == 2 && parts[1] != "-" {
		if s, ok := loadOp(home, parts[1]); ok {
			switch a.Status {
			case "DONE", "REFUSED":
				if a.Outcome == nil || ark.S(a.Outcome.O, "op_id") != s.OpID {
					die(2, "answer %s has no outcome for op %s", rid, s.OpID)
				}
				s.State = a.Status
			case "REJECTED":
				if s.State == "UNKNOWN" {
					s.State = "REJECTED"
				}
			}
			saveOp(home, s)
		}
	}
	fmt.Printf("%s %s %s\n", a.Status, a.Reason, rid)
	os.Exit(exitFor(a.Status))
}

func waitAnswer(home, rhome, rid string, waitMs int) {
	path := filepath.Join(rhome, "outbox", rid+".ans.json")
	if waitMs == 0 {
		fmt.Printf("SENT %s\n", rid)
		os.Exit(3)
	}
	deadline := time.Now().Add(time.Duration(waitMs) * time.Millisecond)
	for {
		if a, present, bad := readAnswer(path); present {
			if bad != "" {
				die(2, "%s", bad)
			}
			settle(home, rid, a)
		}
		if time.Now().After(deadline) {
			fmt.Printf("UNKNOWN NO_ANSWER %s\n", rid)
			os.Exit(3)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func waitMs(f flags) int {
	s, ok := f.one["wait-ms"]
	if !ok {
		return 10000
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 0 {
		die(2, "bad --wait-ms")
	}
	return n
}
func requestID(f flags) string {
	rid, ok := f.one["request-id"]
	if !ok {
		rid = "b-" + randHex(8)
	}
	if !reqID(rid) {
		die(2, "bad request id")
	}
	return rid
}

// commands -------------------------------------------------------------------

func cmdInit(f flags) {
	home := f.need("home")
	if _, err := os.Stat(filepath.Join(home, "key.json")); err == nil {
		die(2, "%s already has a key", home)
	}
	os.MkdirAll(home, 0o700)
	seed := make([]byte, 32)
	if _, err := rand.Read(seed); err != nil {
		die(2, "random: %v", err)
	}
	writeAtomic(filepath.Join(home, "key.json"), []byte(`{"v":"0.1","seed":"`+hex.EncodeToString(seed)+"\"}\n"))
	pub := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)
	fmt.Printf("client_key %s\n", hex.EncodeToString(pub))
}

func cmdPropose(f flags) {
	home := f.need("home")
	for _, s := range allOps(home) {
		if s.State == "UNKNOWN" {
			die(2, "op %s is UNKNOWN (sent, no answer); settle it with status or retry it; no new op_id is made", s.OpID)
		}
	}
	priv := loadKey(home)
	g := readEnv(f.need("grant"))
	if g.Type != "grant" {
		die(2, "--grant is a %s", g.Type)
	}
	sc := ark.O(g.O, "scope")
	op, ok := f.one["op-id"]
	if !ok {
		op = randHex(16)
	}
	name, ok := f.one["action"]
	if !ok {
		name = ark.S(sc, "action")
	}
	res, ok := f.one["resource"]
	if !ok {
		res = ark.S(sc, "resource")
	}
	text := f.need("text")
	if !ark.IsHex32(op) || !ark.IsAname(name) || !ark.IsRes(res) || !ark.IsLine(text) {
		die(2, "op id, action, resource or text breaks the contract patterns")
	}
	payload := `{"v":"0.1","type":"proposal","op_id":"` + op + `","grant":"` + g.Hash + `","action":{"name":` +
		ark.JStr(name) + `,"resource":` + ark.JStr(res) + `,"text":` + ark.JStr(text) + `},"created_at":` +
		strconv.FormatInt(time.Now().UnixMilli(), 10) + `}`
	it := ark.Sign(priv, []byte(payload))
	// self-check through our own pass 1 before writing
	if _, r := ark.ParseEnvelopeFile([]byte(it.EnvelopeJSON())); r != "" {
		die(2, "internal: proposal fails pass 1: %s", r)
	}
	writeAtomic(f.need("out"), []byte(it.EnvelopeJSON()+"\n"))
	keep(home, it)
	fmt.Printf("op_id %s proposal %s\n", op, it.Hash)
}

func cmdSend(f flags) {
	home, rhome := f.need("home"), f.need("receiver-home")
	loadKey(home)
	g, p := readEnv(f.need("grant")), readEnv(f.need("proposal"))
	if g.Type != "grant" || p.Type != "proposal" {
		die(2, "--grant/--proposal have the wrong type")
	}
	ap := "null"
	var a *ark.Item
	if path, ok := f.one["approval"]; ok {
		a = readEnv(path)
		ap = a.EnvelopeJSON()
	}
	notes := []string{}
	var nitems []*ark.Item
	for _, path := range f.multi["note"] {
		n := readEnv(path)
		nitems = append(nitems, n)
		notes = append(notes, n.EnvelopeJSON())
	}
	body := []byte(`{"v":"0.1","kind":"submit","grant":` + g.EnvelopeJSON() + `,"proposal":` + p.EnvelopeJSON() +
		`,"approval":` + ap + `,"notes":[` + strings.Join(notes, ",") + "]}\n")
	op := ark.S(p.O, "op_id")
	s, had := loadOp(home, op)
	if had && s.State == "UNKNOWN" && s.Request != ark.B64u(body) {
		die(2, "op %s is UNKNOWN with different request bytes; use retry", op)
	}
	if !had || s.State == "UNKNOWN" {
		s = opState{OpID: op, State: "UNKNOWN", Request: ark.B64u(body)}
	} else {
		s.Request = ark.B64u(body) // replay of a settled op: keep its state
	}
	for _, it := range append([]*ark.Item{g, p}, nitems...) {
		keep(home, it)
	}
	if a != nil {
		keep(home, a)
	}
	rid := requestID(f)
	saveOp(home, s)
	mapRequest(home, rid, "submit", op)
	putRequest(rhome, rid, body)
	waitAnswer(home, rhome, rid, waitMs(f))
}

func cmdRetry(f flags) {
	home, rhome, op := f.need("home"), f.need("receiver-home"), f.need("op-id")
	s, ok := loadOp(home, op)
	if !ok {
		die(2, "no sent op %s", op)
	}
	body, ok2 := ark.B64uDecode(s.Request)
	if !ok2 {
		die(2, "corrupt stored request")
	}
	rid := requestID(f)
	mapRequest(home, rid, "submit", op)
	putRequest(rhome, rid, body)
	waitAnswer(home, rhome, rid, waitMs(f))
}

func cmdStatus(f flags) {
	home, rhome, op := f.need("home"), f.need("receiver-home"), f.need("op-id")
	if !ark.IsHex32(op) {
		die(2, "bad op id")
	}
	rid := requestID(f)
	mapRequest(home, rid, "status", op)
	putRequest(rhome, rid, []byte(`{"v":"0.1","kind":"status","op_id":"`+op+"\"}\n"))
	waitAnswer(home, rhome, rid, waitMs(f))
}

func cmdCollect(f flags) {
	home, rhome, rid := f.need("home"), f.need("receiver-home"), f.need("request-id")
	a, present, bad := readAnswer(filepath.Join(rhome, "outbox", rid+".ans.json"))
	if !present {
		fmt.Printf("UNKNOWN NO_ANSWER %s\n", rid)
		os.Exit(3)
	}
	if bad != "" {
		die(2, "%s", bad)
	}
	settle(home, rid, a)
}

func cmdPending(f flags) {
	home := f.need("home")
	ops := allOps(home)
	sort.Slice(ops, func(i, j int) bool { return ops[i].OpID < ops[j].OpID })
	for _, s := range ops {
		fmt.Printf("%s %s\n", s.OpID, s.State)
	}
}

func cmdKeep(f flags) {
	home := f.need("home")
	n := 0
	for _, path := range f.pos {
		b, err := os.ReadFile(path)
		if err != nil {
			die(2, "read %s: %v", path, err)
		}
		if bu, err := ark.ParseBundle(b); err == nil {
			for i, v := range bu.Items {
				it, r := ark.DecodeItem(v)
				if r != "" {
					die(2, "%s item %d: %s", path, i, r)
				}
				keep(home, it)
				n++
			}
			continue
		}
		it, r := ark.ParseEnvelopeFile(b)
		if r != "" {
			die(2, "%s: %s", path, r)
		}
		keep(home, it)
		n++
	}
	fmt.Printf("kept %d\n", n)
}

func cmdExport(f flags) {
	home, rid, out := f.need("home"), f.need("receiver-id"), f.need("out")
	if !ark.IsRid(rid) {
		die(2, "bad receiver id")
	}
	es, _ := os.ReadDir(filepath.Join(home, "record"))
	names := []string{}
	for _, e := range es {
		if strings.HasSuffix(e.Name(), ".json") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	if len(names) == 0 {
		die(2, "empty record")
	}
	items := []string{}
	for _, n := range names {
		b, _ := os.ReadFile(filepath.Join(home, "record", n))
		items = append(items, strings.TrimSpace(string(b)))
	}
	cov := "This bundle covers only actions mediated by receiver " + rid +
		": appending one line to notes/demo.txt. Nothing else the client or its agent did is covered."
	writeAtomic(out, []byte(`{"v":"0.1","coverage":`+ark.JStr(cov)+`,"items":[`+strings.Join(items, ",")+"]}\n"))
	fmt.Printf("exported %d items\n", len(items))
}

func main() {
	if len(os.Args) < 2 {
		die(2, "usage: clientb init|propose|send|retry|status|collect|pending|keep|export ...")
	}
	f := parse(os.Args[2:])
	switch os.Args[1] {
	case "init":
		cmdInit(f)
	case "propose":
		cmdPropose(f)
	case "send":
		cmdSend(f)
	case "retry":
		cmdRetry(f)
	case "status":
		cmdStatus(f)
	case "collect":
		cmdCollect(f)
	case "pending":
		cmdPending(f)
	case "keep":
		cmdKeep(f)
	case "export":
		cmdExport(f)
	default:
		die(2, "unknown command %s", os.Args[1])
	}
}
