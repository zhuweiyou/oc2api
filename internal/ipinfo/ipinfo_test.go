package ipinfo

import "testing"

func TestParseTrace(t *testing.T) {
	body := "fl=1f2\nip=203.0.113.7\nts=123.45\nloc=JP\ncolo=NRT\nwarp=on\n"
	result := parseTrace(body)
	if result.IP != "203.0.113.7" {
		t.Fatalf("ip = %q", result.IP)
	}
	if result.Warp != "on" || result.Loc != "JP" || result.Colo != "NRT" {
		t.Fatalf("meta = warp:%q loc:%q colo:%q", result.Warp, result.Loc, result.Colo)
	}
	if result.Source != "https://1.1.1.1/cdn-cgi/trace" {
		t.Fatalf("source = %q", result.Source)
	}
}

func TestFindIP(t *testing.T) {
	cases := map[string]string{
		"your ip: 198.51.100.9\n":   "198.51.100.9",
		"v6 is 2001:db8::1 here":    "2001:db8::1",
		"nothing useful":            "",
		"999.999.999.999 not an ip": "",
	}
	for input, want := range cases {
		if got := findIP(input); got != want {
			t.Fatalf("findIP(%q) = %q, want %q", input, got, want)
		}
	}
}
