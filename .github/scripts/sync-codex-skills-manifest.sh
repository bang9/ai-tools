#!/bin/bash
set -e

# Generates whip/skills-codex/manifest.txt from the directory contents.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SKILLS_DIR="$REPO_ROOT/whip/skills-codex"
OUTPUT="$SKILLS_DIR/manifest.txt"

if [ ! -d "$SKILLS_DIR" ]; then
    echo "Error: $SKILLS_DIR not found" >&2
    exit 1
fi

files=$(cd "$SKILLS_DIR" && find . -type f ! -name manifest.txt | sed 's|^\./||' | sort)

if [ -z "$files" ]; then
    echo "Error: no skill files found in $SKILLS_DIR" >&2
    exit 1
fi

printf '%s\n' "$files" > "$OUTPUT"
echo "Generated $OUTPUT with $(echo "$files" | wc -l | tr -d ' ') file(s)"
