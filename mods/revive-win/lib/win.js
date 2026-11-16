// Windows: the process table and the program that really runs in a terminal.
// Engine only (Node APIs); the dialog never imports this file.
//
// Windows has no `ps`, so the table comes from CIM through PowerShell. It also
// has no foreground process group: herdr-core reports the terminal's shell as
// its foreground even while Claude Code runs in it. `effectiveForeground`
// reads the process tree instead, so "is an agent running here" and "is the
// shell idle" mean on Windows what they mean on macOS and Linux.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { agentKey } from "./core.js";
import { psQuote } from "./pwsh.js";

const execFileAsync = promisify(execFile);

/**
 * A Windows command line split into words the way CommandLineToArgvW does:
 * the program name ends at whitespace, or at its closing quote, and keeps its
 * backslashes; after it, whitespace separates words outside quotes, 2n
 * backslashes before a quote give n and toggle quoting, 2n+1 give n and a
 * literal quote, other backslashes are literal, and `""` inside quotes is a
 * literal quote.
 */
export function splitCommandLine(line) {
  const s = String(line ?? "");
  const words = [];
  let i = 0;
  while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  if (i >= s.length) return words;
  if (s[i] === '"') {
    const end = s.indexOf('"', i + 1);
    words.push(end < 0 ? s.slice(i + 1) : s.slice(i + 1, end));
    i = end < 0 ? s.length : end + 1;
  } else {
    let j = i;
    while (j < s.length && s[j] !== " " && s[j] !== "\t") j++;
    words.push(s.slice(i, j));
    i = j;
  }
  let word = "", inWord = false, quoted = false;
  while (i < s.length) {
    const c = s[i];
    if ((c === " " || c === "\t") && !quoted) {
      if (inWord) { words.push(word); word = ""; inWord = false; }
      i++;
      continue;
    }
    inWord = true;
    if (c === "\\") {
      let n = 0;
      while (s[i] === "\\") { n++; i++; }
      if (s[i] === '"') {
        word += "\\".repeat(Math.floor(n / 2));
        if (n % 2) { word += '"'; i++; }
      } else {
        word += "\\".repeat(n);
      }
      continue;
    }
    if (c === '"') {
      if (quoted && s[i + 1] === '"') { word += '"'; i += 2; continue; }
      quoted = !quoted;
      i++;
      continue;
    }
    word += c;
    i++;
  }
  if (inWord) words.push(word);
  return words;
}

/**
 * A start time as Revive keeps it on Windows: UTC, to the millisecond. Takes
 * .NET's culture-invariant `ToString('o')` (seven fraction digits) or an ISO
 * time with fewer; anything else is null.
 */
export function toSince(value) {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,7}))?Z$/.exec(String(value ?? ""));
  return m ? `${m[1]}.${(m[2] ?? "").padEnd(3, "0").slice(0, 3)}Z` : null;
}

/** Every process, as PowerShell prints it for `parseWinProcesses`. */
export const PROCESS_QUERY = [
  "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,CommandLine,Name |",
  "  ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name;",
  "    start = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }; cmd = $_.CommandLine } } |",
  "  ConvertTo-Json -Compress -AsArray",
].join("\n");

/**
 * pid → { ppid, since, argv, name }, from PROCESS_QUERY's output. Windows
 * keeps a dead parent's pid on its children and reuses pids, so a "parent"
 * that started after its child is not its parent: its ppid becomes 0.
 */
export function parseWinProcesses(json) {
  const table = new Map();
  let rows;
  try { rows = JSON.parse(json || "[]"); } catch { return table; }
  for (const p of Array.isArray(rows) ? rows : [rows]) {
    const pid = Number(p?.pid);
    if (!pid) continue;
    const name = String(p.name ?? "");
    const argv = p.cmd ? splitCommandLine(p.cmd) : name ? [name] : [];
    table.set(pid, { ppid: Number(p.ppid) || 0, since: toSince(p.start), argv, name });
  }
  for (const proc of table.values()) {
    const parent = table.get(proc.ppid);
    if (parent?.since && proc.since && parent.since > proc.since) proc.ppid = 0;
  }
  return table;
}

/** The process table, or an empty one when PowerShell can't give it. */
export async function winProcesses({ run = execFileAsync, pwsh = "pwsh" } = {}) {
  try {
    const { stdout } = await run(pwsh, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PROCESS_QUERY],
      { maxBuffer: 32 * 1024 * 1024, timeout: 15_000, windowsHide: true });
    return parseWinProcesses(stdout);
  } catch {
    return new Map();
  }
}

/** Owners that another non-admin account can't be: BUILTIN\Administrators and SYSTEM. */
export const TRUSTED_OWNERS = ["S-1-5-32-544", "S-1-5-18"];

/**
 * Which folders are the person's own, path → true or false: owned by their
 * account, by Administrators or by SYSTEM. Windows gives every signed-in
 * account Modify on folders made under a drive root (C:\Projects\…), so
 * write permissions are not checked: only who owns the folder. A folder that
 * is missing or can't be read is not the person's. One PowerShell for all.
 */
export async function folderOwners(paths, { run = execFileAsync, pwsh = "pwsh" } = {}) {
  const out = new Map();
  if (!paths.length) return out;
  const script = [
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
    "$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    `$owners = foreach ($p in @(${paths.map(psQuote).join(", ")})) { try { [string](Get-Acl -LiteralPath $p -ErrorAction Stop).GetOwner([Security.Principal.SecurityIdentifier]).Value } catch { '' } }`,
    "[pscustomobject]@{ me = $me; owners = @($owners) } | ConvertTo-Json -Compress",
  ].join("\n");
  let me = null, owners = [];
  try {
    const { stdout } = await run(pwsh, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { timeout: 15_000, windowsHide: true });
    ({ me, owners } = JSON.parse(stdout));
  } catch { /* no answer: nothing is the person's */ }
  paths.forEach((p, i) => {
    const owner = owners?.[i];
    out.set(p, Boolean(owner) && (owner === me || TRUSTED_OWNERS.includes(owner)));
  });
  return out;
}

/** Console plumbing a terminal's shell may own: never "something running". */
const PLUMBING = new Set(["conhost.exe", "openconsole.exe"]);
const nameOf = (proc) => (proc.name || String(proc.argv?.[0] ?? "").split(/[\\/]/).pop()).toLowerCase();

/**
 * What runs in terminal `t` (from `hc get`), from the process table: the
 * agent closest under its shell (the newest one on a tie), else the shell's
 * newest child, else the shell itself. Without the shell in the table, the
 * terminal's own report stands.
 */
export function effectiveForeground(t, table) {
  if (!t?.pid || !table.has(t.pid)) return t?.foreground ?? null;
  const cwd = t.foreground?.cwd ?? t.cwd ?? null;
  // A terminal whose own program is the agent (a forked pane, `hc run -- claude`):
  // its children are the agent's tools and hooks, never in front of it.
  if (agentKey(null, table.get(t.pid).argv)) return { pid: t.pid, argv: table.get(t.pid).argv, cwd };
  const children = new Map();
  for (const [pid, proc] of table) {
    if (!children.has(proc.ppid)) children.set(proc.ppid, []);
    children.get(proc.ppid).push(pid);
  }
  const newer = (a, b) => String(table.get(a).since ?? "") > String(table.get(b).since ?? "");
  let agent = null, agentDepth = Infinity;
  const queue = [[t.pid, 0]];
  while (queue.length) {
    const [pid, depth] = queue.shift();
    if (depth >= 4) continue;
    for (const child of children.get(pid) ?? []) {
      const proc = table.get(child);
      if (PLUMBING.has(nameOf(proc))) continue;
      if (agentKey(null, proc.argv)) {
        if (depth + 1 < agentDepth || (depth + 1 === agentDepth && newer(child, agent))) { agent = child; agentDepth = depth + 1; }
      }
      queue.push([child, depth + 1]);
    }
  }
  const pick = agent ?? (children.get(t.pid) ?? []).filter((c) => !PLUMBING.has(nameOf(table.get(c))))
    .reduce((best, c) => (best === null || newer(c, best) ? c : best), null);
  const pid = pick ?? t.pid;
  return { pid, argv: table.get(pid).argv, cwd };
}
