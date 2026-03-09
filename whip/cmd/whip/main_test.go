package main

import (
	"bytes"
	"testing"
)

func TestHelloCmd(t *testing.T) {
	root := newRootCmd()
	var stdout bytes.Buffer
	root.SetOut(&stdout)
	root.SetErr(&stdout)
	root.SetArgs([]string{"hello"})

	if err := root.Execute(); err != nil {
		t.Fatalf("Execute: %v", err)
	}

	if got := stdout.String(); got != "hello world\n" {
		t.Fatalf("stdout = %q, want %q", got, "hello world\n")
	}
}

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
