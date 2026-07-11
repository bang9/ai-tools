// OSC 7 — "report current working directory". Shells (bash/zsh via
// PROMPT_COMMAND / precmd) emit
//
//     \x1b]7;file://<host>/<percent-encoded-path>\x07   (or ST terminator)
//
// on every prompt so the emulator can track the live cwd. xterm's parser
// strips the leading `\x1b]7;` and trailing BEL/ST before handing us the
// payload, so `data` here is just the `file://...` URI.
//
// Ported from orca src/renderer/src/components/terminal-pane/parse-osc7.ts
// (posix branch only — grove targets macOS). Pure: no DOM, no platform.

const OSC7_URI = /^file:\/\/([^/]*)(\/.*)$/;

/**
 * Parse an OSC 7 payload and return the decoded POSIX path, or null if the
 * payload is not a recognizable `file://host/path` URI. The host is accepted
 * but discarded — on a local macOS host the path is what a spawn `cwd` needs.
 */
export function parseOsc7Cwd(data: string): string | null {
  const match = OSC7_URI.exec(data);
  if (!match) {
    return null;
  }
  let path: string;
  try {
    path = decodeURIComponent(match[2]);
  } catch {
    // Malformed percent-encoding — treat as no-op rather than feeding garbage.
    return null;
  }
  return path.length > 0 ? path : null;
}
