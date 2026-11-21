// verifier: reader 2's offline verifier of record (CONTRACT section 8).
// Usage: verifier BUNDLE PINS   (also accepts --bundle F --pins F). No network.
package main

import (
	"fmt"
	"os"

	"arkb/ark"
)

func main() {
	var bundlePath, pinsPath string
	args := os.Args[1:]
	pos := []string{}
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--bundle":
			if i+1 < len(args) {
				bundlePath = args[i+1]
				i++
			}
		case "--pins":
			if i+1 < len(args) {
				pinsPath = args[i+1]
				i++
			}
		default:
			pos = append(pos, args[i])
		}
	}
	if bundlePath == "" && len(pos) > 0 {
		bundlePath, pos = pos[0], pos[1:]
	}
	if pinsPath == "" && len(pos) > 0 {
		pinsPath, pos = pos[0], pos[1:]
	}
	if bundlePath == "" || pinsPath == "" || len(pos) > 0 {
		fmt.Fprintln(os.Stderr, "usage: verifier BUNDLE PINS")
		os.Exit(2)
	}
	pb, err := os.ReadFile(pinsPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot read pins:", err)
		os.Exit(2)
	}
	pins, err := ark.ParsePins(pb)
	if err != nil {
		fmt.Fprintln(os.Stderr, "bad pins file")
		os.Exit(2)
	}
	bb, err := os.ReadFile(bundlePath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot read bundle:", err)
		os.Exit(2)
	}
	bu, err := ark.ParseBundle(bb)
	if err != nil {
		fmt.Println("pins supplied by: " + ark.EscapeHeader(pins.SuppliedBy))
		fmt.Println("integrity only; freshness and completeness not shown")
		fmt.Println("BUNDLE INVALID BAD_BUNDLE")
		os.Exit(4)
	}
	r := ark.Verify(bu, pins)
	for _, l := range r.Lines {
		fmt.Println(l)
	}
	os.Exit(r.Exit)
}
