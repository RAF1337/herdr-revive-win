// Codex's config.toml: the one line Revive adds so that Codex runs its hooks
// from the terminal's own process. With Codex's shared background server on
// (`[features] daemon_auto_start`, true by default), that server runs the
// hooks, outside the terminal, and they can't tell which terminal a session
// is in. Engine only; the dialog never imports this file.
//
// A careful line edit, not a TOML parser: everything else in the file stays
// as it is, byte for byte, comments and line endings included. A setting the
// person wrote themselves, in any of TOML's forms, is never changed.

export const REVIVE_LINE = "daemon_auto_start = false # added by Revive (herdr-revive-win)";

const HEADER = /^\s*\[\s*([^\]]*?)\s*\]\s*(#.*)?$/;
const FEATURE_KEY = /^\s*daemon_auto_start\s*=\s*(true|false)?/;
const DOTTED_KEY = /^\s*features\s*\.\s*daemon_auto_start\s*=\s*(true|false)?/;
const INLINE_TABLE = /^\s*features\s*=\s*\{.*\bdaemon_auto_start\s*=\s*(true|false)?/;

const strip = (line) => line.replace(/\r?\n$/, "");
const isRevive = (line) => strip(line).trim() === REVIVE_LINE;

/** The file split into lines that keep their own line ending, and what's around them. */
function parse(text) {
  const bom = text.startsWith("﻿") ? "﻿" : "";
  const body = text.slice(bom.length);
  const lines = body ? body.split(/(?<=\n)/) : [];
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  let table = null;
  let features = -1;
  let revive = -1;
  let own = null;
  lines.forEach((line, i) => {
    const s = strip(line);
    const header = HEADER.exec(s);
    if (header && !s.trim().startsWith("[[")) {
      table = header[1];
      if (table === "features" && features < 0) features = i;
      return;
    }
    if (s.trim().startsWith("[[")) { table = "[[array]]"; return; }
    if (table === null) {
      const m = DOTTED_KEY.exec(s) ?? INLINE_TABLE.exec(s);
      if (m) own = m[1] ?? "true";
    } else if (table === "features") {
      if (isRevive(line)) { revive = i; return; }
      const m = FEATURE_KEY.exec(s);
      if (m) own = m[1] ?? "true";
    }
  });
  return { bom, lines, eol, features, revive, own };
}

/** `"off"` when Revive's line or the person's own `false` is there, else `"on"`. */
export function daemonSetting(text) {
  const { revive, own } = parse(String(text ?? ""));
  return own === "false" || (own === null && revive >= 0) ? "off" : "on";
}

/**
 * The file with Revive's line added (once, and only when the person has no
 * setting of their own), or with `remove` taken out again, together with a
 * `[features]` table Revive had to create for it.
 */
export function withDaemonOff(text, { remove = false } = {}) {
  const src = String(text ?? "");
  const { bom, lines, eol, features, revive, own } = parse(src);
  if (remove) {
    if (revive < 0) return src;
    const out = [...lines];
    out.splice(revive, 1);
    // The table Revive created: a bare `[features]` header, now empty, and the
    // last table in the file, after the blank line Revive put before it.
    const h = revive - 1;
    const rest = out.slice(h + 1);
    if (h >= 0 && strip(out[h]).trim() === "[features]" && rest.every((l) => !strip(l).trim())) {
      out.splice(h);
      if (out.length && !strip(out[out.length - 1]).trim()) out.pop();
    }
    return bom + out.join("");
  }
  if (own !== null || revive >= 0) return src;
  if (features >= 0) {
    const out = [...lines];
    if (!out[features].endsWith("\n")) out[features] += eol;
    out.splice(features + 1, 0, REVIVE_LINE + eol);
    return bom + out.join("");
  }
  let body = lines.join("");
  if (body && !body.endsWith("\n")) body += eol;
  return `${bom}${body}${body ? eol : ""}[features]${eol}${REVIVE_LINE}${eol}`;
}
