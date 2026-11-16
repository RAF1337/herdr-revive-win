// Codex's config.toml: the one line Revive adds so that Codex runs its hooks
// from the terminal's own process. With Codex's shared background server on
// (`[features] daemon_auto_start`, true by default), that server runs the
// hooks, outside the terminal, and they can't tell which terminal a session
// is in. Engine only; the dialog never imports this file.
//
// A careful line edit, not a TOML parser: everything else in the file stays
// as it is, byte for byte, comments and line endings included. A setting the
// person wrote themselves, in any of TOML's forms, is never changed. Text
// inside multi-line strings and arrays is never read as a table or a key.

export const REVIVE_LINE = "daemon_auto_start = false # added by Revive (herdr-revive-win)";
/** The same, for a file that sets its features with top-level dotted keys (`features.x = …`). */
export const REVIVE_DOTTED_LINE = `features.${REVIVE_LINE}`;

const F = String.raw`(?:"features"|'features'|features)`;
const D = String.raw`(?:"daemon_auto_start"|'daemon_auto_start'|daemon_auto_start)`;
const HEADER = /^\s*\[\s*(?:"([^"]*)"|'([^']*)'|([^\][#"']*?))\s*\]\s*(#.*)?$/;
const FEATURE_KEY = new RegExp(String.raw`^\s*${D}\s*=\s*(true|false)?`);
const DOTTED_KEY = new RegExp(String.raw`^\s*${F}\s*\.\s*${D}\s*=\s*(true|false)?`);
const DOTTED_ANY = new RegExp(String.raw`^\s*${F}\s*\.`);
const INLINE_KEY = new RegExp(String.raw`^\s*${F}\s*=\s*\{.*?[{,\s]${D}\s*=\s*(true|false)?`);
const INLINE_ANY = new RegExp(String.raw`^\s*${F}\s*=\s*\{`);

const strip = (line) => line.replace(/\r?\n$/, "");
const isRevive = (line) => [REVIVE_LINE, REVIVE_DOTTED_LINE].includes(strip(line).trim());

/**
 * Where a line leaves the parser: inside a multi-line string (its delimiter)
 * or not, and how many array brackets are open. Strings on one line and
 * comments are skipped; a header line's own brackets don't count.
 */
function scan(line, from, depth, header) {
  for (let i = from; i < line.length;) {
    const c = line[i];
    const ml = line.startsWith('"""', i) ? '"""' : line.startsWith("'''", i) ? "'''" : null;
    if (ml) {
      const close = line.indexOf(ml, i + 3);
      if (close < 0) return { ml, depth };
      i = close + 3;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') j += line[j] === "\\" ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (c === "'") { const j = line.indexOf("'", i + 1); i = j < 0 ? line.length : j + 1; continue; }
    if (c === "#") break;
    if (!header && c === "[") depth++;
    if (!header && c === "]") depth = Math.max(0, depth - 1);
    i++;
  }
  return { ml: null, depth };
}

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
  let dotted = -1;
  let inline = false;
  let ml = null;
  let depth = 0;
  lines.forEach((line, i) => {
    const s = strip(line);
    let from = 0;
    if (ml) {
      const close = s.indexOf(ml);
      if (close < 0) return;
      ml = null;
      from = close + 3;
    } else if (depth === 0) {
      const array = s.trim().startsWith("[[");
      const header = array ? null : HEADER.exec(s);
      if (array || header) {
        table = array ? "[[array]]" : header[1] ?? header[2] ?? header[3];
        if (table === "features" && features < 0) features = i;
        return;
      }
      if (table === null) {
        const m = DOTTED_KEY.exec(s) ?? INLINE_KEY.exec(s);
        if (isRevive(line)) revive = i;
        else if (m) own = m[1] ?? "true";
        if (DOTTED_ANY.test(s)) dotted = i;
        if (INLINE_ANY.test(s)) inline = true;
      } else if (table === "features") {
        if (isRevive(line)) revive = i;
        else {
          const m = FEATURE_KEY.exec(s);
          if (m) own = m[1] ?? "true";
        }
      }
    }
    ({ ml, depth } = scan(s, from, depth, false));
  });
  return { bom, lines, eol, features, revive, own, dotted, inline };
}

/** `"off"` when Revive's line or the person's own `false` is there, else `"on"`. */
export function daemonSetting(text) {
  const { revive, own } = parse(String(text ?? ""));
  return own === "false" || (own === null && revive >= 0) ? "off" : "on";
}

/**
 * The file with Revive's line added (once, and only when the person has no
 * setting of their own), or with `remove` taken out again, together with a
 * `[features]` table Revive had to create for it. A file whose features are
 * an inline table (`features = { … }`) is left as it is: Revive can't add a
 * key there without rewriting the person's line.
 */
export function withDaemonOff(text, { remove = false } = {}) {
  const src = String(text ?? "");
  const { bom, lines, eol, features, revive, own, dotted, inline } = parse(src);
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
  if (own !== null || revive >= 0 || inline) return src;
  // A second way of writing the same table is invalid TOML: Codex wouldn't start.
  const at = features >= 0 ? features : dotted;
  if (at >= 0) {
    const out = [...lines];
    if (!out[at].endsWith("\n")) out[at] += eol;
    out.splice(at + 1, 0, (features >= 0 ? REVIVE_LINE : REVIVE_DOTTED_LINE) + eol);
    return bom + out.join("");
  }
  let body = lines.join("");
  if (body && !body.endsWith("\n")) body += eol;
  return `${bom}${body}${body ? eol : ""}[features]${eol}${REVIVE_LINE}${eol}`;
}
