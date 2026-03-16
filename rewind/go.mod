module github.com/bang9/ai-tools/rewind

go 1.26

require (
	github.com/bang9/ai-tools/shared/upgrade v0.0.0
	github.com/tdewolff/minify/v2 v2.24.10
)

require github.com/tdewolff/parse/v2 v2.8.10 // indirect

replace github.com/bang9/ai-tools/shared/upgrade => ../shared/upgrade
