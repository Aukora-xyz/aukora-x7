// vectorcheck: runs the verifier binary on every vector in expected-verdicts.json
// and compares the BUNDLE line, the OP lines, the header lines and the exit code.
// Usage: vectorcheck VERIFIER_BIN VECTORS_DIR
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

type vec struct {
	Bundle string `json:"bundle"`
	Pins   string `json:"pins"`
	Note   string `json:"note"`
	BV     struct {
		Verdict string `json:"verdict"`
		Reason  string `json:"reason"`
		Item    *int   `json:"item"`
	} `json:"bundle_verdict"`
	Ops  map[string]struct{ Verdict, Reason string } `json:"ops"`
	Exit   int                                         `json:"exit"`
	Stdout []string                                    `json:"stdout"`
}

func main() {
	bin, dir := os.Args[1], os.Args[2]
	raw, err := os.ReadFile(filepath.Join(dir, "expected-verdicts.json"))
	if err != nil {
		fmt.Println("FAIL cannot read expected-verdicts.json")
		os.Exit(1)
	}
	var ev struct{ Vectors []vec }
	if err := json.Unmarshal(raw, &ev); err != nil {
		fmt.Println("FAIL bad expected-verdicts.json")
		os.Exit(1)
	}
	match := 0
	for _, v := range ev.Vectors {
		want := []string{}
		switch {
		case v.BV.Verdict == "OK":
			want = append(want, "BUNDLE OK")
		case v.BV.Item == nil:
			want = append(want, "BUNDLE "+v.BV.Verdict+" "+v.BV.Reason)
		case v.BV.Verdict == "UNTRUSTED_KEY":
			want = append(want, fmt.Sprintf("BUNDLE UNTRUSTED_KEY item=%d", *v.BV.Item))
		default:
			want = append(want, fmt.Sprintf("BUNDLE %s %s item=%d", v.BV.Verdict, v.BV.Reason, *v.BV.Item))
		}
		ids := []string{}
		for k := range v.Ops {
			ids = append(ids, k)
		}
		sort.Strings(ids)
		for _, k := range ids {
			l := "OP " + k + " " + v.Ops[k].Verdict
			if v.Ops[k].Reason != "" {
				l += " " + v.Ops[k].Reason
			}
			want = append(want, l)
		}
		cmd := exec.Command(bin, filepath.Join(dir, v.Bundle), filepath.Join(dir, v.Pins))
		out, err := cmd.Output()
		code := 0
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			code = ee.ExitCode()
		} else if err != nil {
			code = -1
		}
		got := strings.Split(strings.TrimRight(string(out), "\n"), "\n")
		// header: coverage (omitted for BAD_BUNDLE), pins supplied by, integrity line
		hdr := 3
		if v.BV.Item == nil && v.BV.Verdict != "OK" {
			hdr = 2
		}
		ok := len(got) == hdr+len(want) && code == v.Exit &&
			strings.HasPrefix(got[hdr-2], "pins supplied by: ") &&
			got[hdr-1] == "integrity only; freshness and completeness not shown" &&
			(hdr == 2 || strings.HasPrefix(got[0], "coverage: "))
		if ok {
			for i, w := range want {
				if got[hdr+i] != w {
					ok = false
				}
			}
		}
		if ok && v.Stdout != nil { // C11 of section 11: exact stdout where given
			if len(v.Stdout) != len(got) {
				ok = false
			} else {
				for i := range got {
					if got[i] != v.Stdout[i] {
						ok = false
					}
				}
			}
		}
		if ok {
			match++
			fmt.Printf("MATCH %s (exit %d)\n", v.Bundle, code)
		} else {
			fmt.Printf("MISMATCH %s: want %q exit %d; got %q exit %d\n", v.Bundle, want, v.Exit, got, code)
		}
	}
	fmt.Printf("vectors matched: %d of %d\n", match, len(ev.Vectors))
	if match != len(ev.Vectors) {
		os.Exit(1)
	}
}
