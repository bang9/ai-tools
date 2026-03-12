package vaultkey

import "testing"

func TestRedactURLCredentials(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "token only",
			input: "https://ghp_secret123@github.com/example/secrets.git",
			want:  "https://***@github.com/example/secrets.git",
		},
		{
			name:  "username and password",
			input: "fatal: could not read from https://user:secret@github.com/example/secrets.git",
			want:  "fatal: could not read from https://***@github.com/example/secrets.git",
		},
		{
			name:  "ssh url unchanged",
			input: "git@github.com:example/secrets.git",
			want:  "git@github.com:example/secrets.git",
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			if got := RedactURLCredentials(tt.input); got != tt.want {
				t.Fatalf("RedactURLCredentials(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}
