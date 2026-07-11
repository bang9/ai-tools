// OSC 52 — "Manipulate Selection Data". xterm.js does not implement this
// handler, so TUIs (tmux, neovim, fzf) that copy to the host clipboard over
// the PTY need an app-registered handler.
//
// Wire format (xterm strips the leading `\x1b]52;` and trailing BEL/ST before
// handing us the payload string):
//
//     Pc ; Pd
//
// Pc is one or more selection-kind letters ("c"=clipboard, "p"=primary, …);
// Pd is base64-encoded UTF-8. If Pd is "?" the TUI is *querying* the clipboard
// — we deliberately ignore that (clipboard-read exfil vector).
//
// Ported from orca osc52-clipboard.ts. Grove writes silently (no toast, no
// opt-in setting) and swallows clipboard-write rejections — WKWebView (Tauri)
// may gesture-gate a write that originates from PTY output, not a user click.

export type Osc52ParseResult =
  | { kind: "write"; selections: string; text: string }
  | { kind: "query" }
  | { kind: "invalid"; reason: string };

const MAX_OSC52_BYTES = 128 * 1024;

export function parseOsc52(data: string): Osc52ParseResult {
  const semi = data.indexOf(";");
  if (semi === -1) {
    return { kind: "invalid", reason: "missing selection/data separator" };
  }
  const selections = data.slice(0, semi);
  const payload = data.slice(semi + 1);

  // Why reject empty selections: the spec defaults to "s0", but every TUI we
  // care about emits at least one letter, and treating empty as "clipboard"
  // would let malformed payloads mutate the clipboard by accident.
  if (selections.length === 0) {
    return { kind: "invalid", reason: "empty selection list" };
  }
  if (!/^[cpqs0-7]+$/.test(selections)) {
    return { kind: "invalid", reason: "unknown selection kind" };
  }

  // Why ignore the query form: replying with clipboard contents to anything
  // writing the PTY is a data-exfil vector.
  if (payload === "?") {
    return { kind: "query" };
  }

  // Why cap size: a legitimate clipboard write is rarely more than a screenful;
  // any multi-MB payload is almost certainly a bug or abuse.
  if (payload.length > MAX_OSC52_BYTES) {
    return { kind: "invalid", reason: "payload exceeds size limit" };
  }

  const decoded = decodeBase64Utf8(payload);
  if (decoded === null) {
    return { kind: "invalid", reason: "payload is not valid base64" };
  }
  return { kind: "write", selections, text: decoded };
}

export type Osc52ClipboardRequestOptions = {
  /** Writes text to the host clipboard; may reject under a gesture-gate. */
  writeClipboardText: (text: string) => Promise<void>;
  /** Reports a swallowed write rejection (devtools log). */
  onWriteError?: (error: unknown) => void;
};

/**
 * Handle a decoded OSC 52 payload. Always returns true so xterm treats the
 * sequence as consumed (there is no built-in OSC 52 handler to fall through
 * to). Query and invalid forms are silently dropped.
 */
export function handleOsc52ClipboardRequest(
  data: string,
  options: Osc52ClipboardRequestOptions,
): boolean {
  const parsed = parseOsc52(data);
  if (parsed.kind !== "write") {
    return true;
  }

  void options.writeClipboardText(parsed.text).catch((error) => {
    options.onWriteError?.(error);
  });
  return true;
}

function decodeBase64Utf8(b64: string): string | null {
  // Why tolerate whitespace: some TUIs line-wrap the base64 payload, and atob
  // rejects whitespace. Reject anything else off the base64 alphabet so we do
  // not silently accept garbage.
  const stripped = normalizeBase64Payload(b64);
  if (stripped === null) {
    return null;
  }
  try {
    const binary = atob(stripped);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

function normalizeBase64Payload(value: string): string | null {
  let stripped = "";
  let sawWhitespace = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (isWhitespaceCode(code)) {
      if (!sawWhitespace) {
        stripped = value.slice(0, index);
        sawWhitespace = true;
      }
      continue;
    }
    if (!isBase64Code(code)) {
      return null;
    }
    if (sawWhitespace) {
      stripped += value[index];
    }
  }
  return sawWhitespace ? stripped : value;
}

function isBase64Code(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 ||
    code === 47 ||
    code === 61
  );
}

function isWhitespaceCode(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13);
}
