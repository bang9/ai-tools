module github.com/bang9/ai-tools/vaultkey

go 1.26

require (
	github.com/bang9/ai-tools/shared/upgrade v0.0.0
	github.com/spf13/cobra v1.9.1
	golang.org/x/crypto v0.48.0
	golang.org/x/term v0.40.0
)

require (
	github.com/inconshreveable/mousetrap v1.1.0 // indirect
	github.com/spf13/pflag v1.0.6 // indirect
	golang.org/x/sys v0.41.0 // indirect
)

replace github.com/bang9/ai-tools/shared/upgrade => ../shared/upgrade
