package model

import (
	"encoding/json"
	"testing"
)

func TestWithProxyOptionsPreservesOtherOptions(t *testing.T) {
	raw := `{"host_key_fingerprint":"SHA256:test","terminal":{"font_size":14}}`
	updated, err := WithProxyOptions(raw, ProxyConfig{Type: ProxyTypeSOCKS5, Host: "proxy.local", Port: 1080, Username: "alice", HasPassword: true})
	if err != nil {
		t.Fatal(err)
	}
	proxy := ParseProxyOptions(updated)
	if proxy.Type != ProxyTypeSOCKS5 || proxy.Host != "proxy.local" || proxy.Port != 1080 || proxy.HasPassword {
		t.Fatalf("unexpected proxy: %+v", proxy)
	}
	var options map[string]any
	if err := json.Unmarshal([]byte(updated), &options); err != nil {
		t.Fatal(err)
	}
	if options["host_key_fingerprint"] != "SHA256:test" || options["terminal"] == nil {
		t.Fatalf("unrelated options lost: %s", updated)
	}

	direct, err := WithProxyOptions(updated, DirectProxyConfig())
	if err != nil {
		t.Fatal(err)
	}
	if ParseProxyOptions(direct).Type != ProxyTypeDirect {
		t.Fatalf("proxy was not removed: %s", direct)
	}
}

func TestParseProxyOptionsFallsBackToDirect(t *testing.T) {
	for _, raw := range []string{"", "not-json", `{}`} {
		if got := ParseProxyOptions(raw); got.Type != ProxyTypeDirect {
			t.Fatalf("ParseProxyOptions(%q) = %+v", raw, got)
		}
	}
}
