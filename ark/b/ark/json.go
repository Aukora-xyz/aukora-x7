// Package ark is reader 2's independent reading of CONTRACT.md (v0.1).
// Written from CONTRACT.md and vectors only. Go standard library only.
package ark

import (
	"errors"
	"strconv"
	"unicode/utf8"
)

// Strict JSON values (CONTRACT section 3):
//   *Obj, []any, string, Int, Null
type Obj struct {
	Keys []string
	M    map[string]any
}
type Int uint64
type Null struct{}
type Bool bool // only produced by ParseUnsigned (C21)

var ErrJSON = errors.New("BAD_JSON")

const maxSafe = 9007199254740991

// ParseStrict parses one JSON value whose top level is an object, under the
// section 3 rules 1-6 plus a nesting limit (containers counted, top object = 1).
func ParseStrict(b []byte, maxDepth int) (*Obj, error) { return parseTop(b, maxDepth, false) }

// ParseUnsigned is ParseStrict for unsigned files (bundle, pins, request, answer, envelope file):
// per C21 a true/false parses there and is rejected later as a shape error by whoever reads the field.
func ParseUnsigned(b []byte, maxDepth int) (*Obj, error) { return parseTop(b, maxDepth, true) }

func parseTop(b []byte, maxDepth int, allowBool bool) (*Obj, error) {
	if len(b) >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF {
		return nil, ErrJSON
	}
	if !utf8.Valid(b) {
		return nil, ErrJSON
	}
	p := &parser{b: b, maxDepth: maxDepth, allowBool: allowBool}
	p.ws()
	if p.i >= len(b) || b[p.i] != '{' {
		return nil, ErrJSON
	}
	v, err := p.value()
	if err != nil {
		return nil, err
	}
	p.ws()
	if p.i != len(b) {
		return nil, ErrJSON
	}
	return v.(*Obj), nil
}

type parser struct {
	b        []byte
	i        int
	depth    int
	maxDepth  int
	allowBool bool
}

func (p *parser) ws() {
	for p.i < len(p.b) {
		switch p.b[p.i] {
		case ' ', '\t', '\n', '\r':
			p.i++
		default:
			return
		}
	}
}

func (p *parser) lit(s string) bool {
	if len(p.b)-p.i >= len(s) && string(p.b[p.i:p.i+len(s)]) == s {
		p.i += len(s)
		return true
	}
	return false
}

func (p *parser) value() (any, error) {
	p.ws()
	if p.i >= len(p.b) {
		return nil, ErrJSON
	}
	switch c := p.b[p.i]; {
	case c == '{':
		return p.object()
	case c == '[':
		return p.array()
	case c == '"':
		return p.str()
	case c >= '0' && c <= '9':
		return p.num()
	case c == 'n':
		if p.lit("null") {
			return Null{}, nil
		}
	case p.allowBool && c == 't':
		if p.lit("true") {
			return Bool(true), nil
		}
	case p.allowBool && c == 'f':
		if p.lit("false") {
			return Bool(false), nil
		}
	}
	// true/false never occur in v0.1 (rule 6); '-' and anything else: BAD_JSON
	return nil, ErrJSON
}

func (p *parser) enter() error {
	p.depth++
	if p.depth > p.maxDepth {
		return ErrJSON
	}
	return nil
}

func (p *parser) object() (any, error) {
	if err := p.enter(); err != nil {
		return nil, err
	}
	p.i++ // {
	o := &Obj{M: map[string]any{}}
	p.ws()
	if p.i < len(p.b) && p.b[p.i] == '}' {
		p.i++
		p.depth--
		return o, nil
	}
	for {
		p.ws()
		if p.i >= len(p.b) || p.b[p.i] != '"' {
			return nil, ErrJSON
		}
		k, err := p.str()
		if err != nil {
			return nil, err
		}
		if _, dup := o.M[k]; dup {
			return nil, ErrJSON
		}
		p.ws()
		if p.i >= len(p.b) || p.b[p.i] != ':' {
			return nil, ErrJSON
		}
		p.i++
		v, err := p.value()
		if err != nil {
			return nil, err
		}
		o.Keys = append(o.Keys, k)
		o.M[k] = v
		p.ws()
		if p.i >= len(p.b) {
			return nil, ErrJSON
		}
		if p.b[p.i] == ',' {
			p.i++
			continue
		}
		if p.b[p.i] == '}' {
			p.i++
			p.depth--
			return o, nil
		}
		return nil, ErrJSON
	}
}

func (p *parser) array() (any, error) {
	if err := p.enter(); err != nil {
		return nil, err
	}
	p.i++ // [
	a := []any{}
	p.ws()
	if p.i < len(p.b) && p.b[p.i] == ']' {
		p.i++
		p.depth--
		return a, nil
	}
	for {
		v, err := p.value()
		if err != nil {
			return nil, err
		}
		a = append(a, v)
		p.ws()
		if p.i >= len(p.b) {
			return nil, ErrJSON
		}
		if p.b[p.i] == ',' {
			p.i++
			continue
		}
		if p.b[p.i] == ']' {
			p.i++
			p.depth--
			return a, nil
		}
		return nil, ErrJSON
	}
}

func hex4(b []byte) (rune, bool) {
	if len(b) < 4 {
		return 0, false
	}
	var r rune
	for _, c := range b[:4] {
		r <<= 4
		switch {
		case c >= '0' && c <= '9':
			r |= rune(c - '0')
		case c >= 'a' && c <= 'f':
			r |= rune(c-'a') + 10
		case c >= 'A' && c <= 'F':
			r |= rune(c-'A') + 10
		default:
			return 0, false
		}
	}
	return r, true
}

func (p *parser) str() (string, error) {
	p.i++ // opening quote
	out := make([]byte, 0, 32)
	for {
		if p.i >= len(p.b) {
			return "", ErrJSON
		}
		c := p.b[p.i]
		switch {
		case c == '"':
			p.i++
			return string(out), nil
		case c < 0x20:
			return "", ErrJSON
		case c == '\\':
			if p.i+1 >= len(p.b) {
				return "", ErrJSON
			}
			e := p.b[p.i+1]
			p.i += 2
			switch e {
			case '"':
				out = append(out, '"')
			case '\\':
				out = append(out, '\\')
			case '/':
				out = append(out, '/')
			case 'b':
				out = append(out, '\b')
			case 'f':
				out = append(out, '\f')
			case 'n':
				out = append(out, '\n')
			case 'r':
				out = append(out, '\r')
			case 't':
				out = append(out, '\t')
			case 'u':
				r, ok := hex4(p.b[p.i:])
				if !ok {
					return "", ErrJSON
				}
				p.i += 4
				if r >= 0xDC00 && r <= 0xDFFF {
					return "", ErrJSON // lone low surrogate
				}
				if r >= 0xD800 && r <= 0xDBFF {
					if p.i+6 > len(p.b) || p.b[p.i] != '\\' || p.b[p.i+1] != 'u' {
						return "", ErrJSON
					}
					lo, ok := hex4(p.b[p.i+2:])
					if !ok || lo < 0xDC00 || lo > 0xDFFF {
						return "", ErrJSON
					}
					p.i += 6
					r = 0x10000 + (r-0xD800)<<10 + (lo - 0xDC00)
				}
				out = utf8.AppendRune(out, r)
			default:
				return "", ErrJSON
			}
		default:
			out = append(out, c)
			p.i++
		}
	}
}

func (p *parser) num() (any, error) {
	start := p.i
	if p.b[p.i] == '0' {
		p.i++
	} else {
		for p.i < len(p.b) && p.b[p.i] >= '0' && p.b[p.i] <= '9' {
			p.i++
		}
	}
	if p.i < len(p.b) {
		switch p.b[p.i] {
		case '.', 'e', 'E', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '-', '+':
			return nil, ErrJSON
		}
	}
	n, err := strconv.ParseUint(string(p.b[start:p.i]), 10, 64)
	if err != nil || n > maxSafe {
		return nil, ErrJSON
	}
	return Int(n), nil
}
