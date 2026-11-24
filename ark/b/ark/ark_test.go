package ark

import (
	"fmt"
	"testing"
)

func TestDSSEPAEShape(t *testing.T) {
	// DSSE spec vector shape: "DSSEv1 29 http://example.com/HelloWorld 11 hello world"
	pt, pl := "http://example.com/HelloWorld", "hello world"
	got := fmt.Sprintf("DSSEv1 %d %s %d %s", len(pt), pt, len(pl), pl)
	if got != "DSSEv1 29 http://example.com/HelloWorld 11 hello world" {
		t.Fatal(got)
	}
	if string(PAE([]byte("x"))) != "DSSEv1 36 "+PayloadType+" 1 x" {
		t.Fatal(string(PAE([]byte("x"))))
	}
}

func TestStrictJSON(t *testing.T) {
	bad := []string{`{"a":1,"a":2}`, `{"a":1.0}`, `{"a":-1}`, `{"a":01}`, `{"a":1e3}`, `{"a":true}`,
		`{"a":"\ud800"}`, `{"a":"\udc00"}`, `{} x`, "\xef\xbb\xbf{}", `[1]`, `{"a":9007199254740992}`,
		`{"a":[[[[[[[[1]]]]]]]]}`, "{\"a\":\"\x01\"}"}
	for _, s := range bad {
		if _, err := ParseStrict([]byte(s), MaxDepth); err == nil {
			t.Errorf("accepted %q", s)
		}
	}
	good := []string{`{}`, ` {"a":0,"b":[1,"x",null],"c":{"d":"😀"}} `, `{"a":9007199254740991}`}
	for _, s := range good {
		if _, err := ParseStrict([]byte(s), MaxDepth); err != nil {
			t.Errorf("rejected %q", s)
		}
	}
}

func TestB64u(t *testing.T) {
	for _, s := range []string{"QQ==", "QR", "Q", "Q+", "Q/", "QQ\n"} {
		if _, ok := B64uDecode(s); ok {
			t.Errorf("accepted %q", s)
		}
	}
	if b, ok := B64uDecode("QQ"); !ok || string(b) != "A" {
		t.Error("rejected QQ")
	}
}
