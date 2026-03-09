package main

import "testing"

func TestConnectURLToken(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{name: "fragment token", raw: "https://public.example#token=abc123", want: "abc123"},
		{name: "legacy query token", raw: "https://public.example?token=abc123", want: "abc123"},
		{name: "missing token", raw: "https://public.example", want: ""},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := connectURLToken(tc.raw); got != tc.want {
				t.Fatalf("connectURLToken(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}
