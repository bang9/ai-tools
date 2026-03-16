#!/bin/bash
set -e

# Generates skills-codex/manifest.txt for each tool that has a skills-codex/ directory.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
generated=0

for skills_dir in "$REPO_ROOT"/*/skills-codex; do
    [ -d "$skills_dir" ] || continue

    output="$skills_dir/manifest.txt"
    tool_name="$(basename "$(dirname "$skills_dir")")"

    files=$(cd "$skills_dir" && find . -type f ! -name manifest.txt | sed 's|^\./||' | sort)

    if [ -z "$files" ]; then
        echo "Warning: no skill files found in $skills_dir, skipping" >&2
        continue
    fi

    printf '%s\n' "$files" > "$output"
    count=$(echo "$files" | wc -l | tr -d ' ')
    echo "Generated $output with $count file(s)"
    generated=$((generated + 1))
done

if [ "$generated" -eq 0 ]; then
    echo "No skills-codex directories found" >&2
fi
