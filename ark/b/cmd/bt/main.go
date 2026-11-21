// bt: small read-only helpers for accept/run.sh (reader 2 (Go)).
//
//	bt answer FILE                        -> line 1 "<status> <reason>", line 2 "<payload> <sig>" of the outcome or "null"
//	bt outcome-field BUNDLE OP_ID FIELD   -> a top-level or effect.<x> field of the outcome for OP_ID
//	bt flip-sig BUNDLE TYPE OUT           -> copy of BUNDLE with the first char of the first TYPE item's sig changed
package main

import (
	"fmt"
	"os"
	"strings"

	"arkb/ark"
)

func die(f string, a ...any) { fmt.Fprintf(os.Stderr, "bt: "+f+"\n", a...); os.Exit(2) }

func main() {
	if len(os.Args) < 3 {
		die("usage")
	}
	switch os.Args[1] {
	case "answer":
		b, err := os.ReadFile(os.Args[2])
		if err != nil {
			die("no answer file")
		}
		o, err := ark.ParseUnsigned(b, 8)
		if err != nil {
			die("bad answer json")
		}
		fmt.Println(ark.S(o, "status") + " " + ark.S(o, "reason"))
		if ark.IsNull(o, "outcome") {
			fmt.Println("null")
			return
		}
		it, r := ark.DecodeItem(o.M["outcome"])
		if r != "" {
			die("outcome: %s", r)
		}
		fmt.Println(it.PayloadB64 + " " + it.SigB64)
	case "outcome-field":
		b, err := os.ReadFile(os.Args[2])
		if err != nil {
			die("no bundle")
		}
		bu, err := ark.ParseBundle(b)
		if err != nil {
			die("bad bundle")
		}
		for _, v := range bu.Items {
			it, r := ark.DecodeItem(v)
			if r != "" || it.Type != "outcome" || ark.S(it.O, "op_id") != os.Args[3] {
				continue
			}
			f := os.Args[4]
			if strings.HasPrefix(f, "effect.") {
				fmt.Println(ark.S(ark.O(it.O, "effect"), strings.TrimPrefix(f, "effect.")))
			} else {
				fmt.Println(ark.S(it.O, f))
			}
			return
		}
		die("no outcome for %s", os.Args[3])
	case "flip-sig":
		b, err := os.ReadFile(os.Args[2])
		if err != nil {
			die("no bundle")
		}
		bu, err := ark.ParseBundle(b)
		if err != nil {
			die("bad bundle")
		}
		items := []string{}
		done := false
		for _, v := range bu.Items {
			it, r := ark.DecodeItem(v)
			if r != "" {
				die("item does not decode")
			}
			if !done && it.Type == os.Args[3] {
				c := "A"
				if it.SigB64[0] == 'A' {
					c = "B"
				}
				it.SigB64 = c + it.SigB64[1:]
				done = true
			}
			items = append(items, it.EnvelopeJSON())
		}
		if !done {
			die("no %s item", os.Args[3])
		}
		out := `{"v":"0.1","coverage":` + ark.JStr(bu.Coverage) + `,"items":[` + strings.Join(items, ",") + "]}\n"
		if err := os.WriteFile(os.Args[4], []byte(out), 0o600); err != nil {
			die("write: %v", err)
		}
	default:
		die("unknown")
	}
}
