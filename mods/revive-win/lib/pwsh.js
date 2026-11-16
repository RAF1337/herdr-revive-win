// The PowerShell Revive writes on Windows: quoting, the resume command, the
// notes a recovered shell prints, and the block for the person's profile.
// Pure functions like lib/core.js (whose POSIX shell versions these mirror):
// nothing here touches herdr, Node or the file system.

import { AGENTS, command, safeFlags, attendedFlags, shortId } from "./core.js";

export const PROFILE_BEGIN = "# >>> herdr-revive >>>";
export const PROFILE_END = "# <<< herdr-revive <<<";

/**
 * One word for PowerShell, always in single quotes, where nothing expands.
 * PowerShell takes ‘ ’ ‚ ‛ as single quotes too, so each is doubled like '.
 */
export const psQuote = (word) => `'${String(word).replace(/['‘’‚‛]/g, "$&$&")}'`;

/** A program and its arguments, run with the call operator. */
export const psCommand = (argv) => `& ${argv.map(psQuote).join(" ")}`;

/** Go to the session's folder; stop there when it is gone, so the agent never starts elsewhere. */
const cdPart = (rec) => (rec.cwd ? `Set-Location -LiteralPath ${psQuote(rec.cwd)} -ErrorAction Stop; ` : "");

/**
 * The line that resumes a session, or "". Unattended (after a restart, with
 * nobody watching) leaves out the flags that lift approvals or the sandbox,
 * and hands the agent's hook every carried flag in REVIVE_RESUME for this run
 * only, as lib/core.js resumeLine does, so the record keeps them.
 */
export function psResumeLine(rec, { unattended = false } = {}) {
  const argv = command(rec, "resume", { unattended });
  if (!argv) return "";
  if (!unattended) return `${cdPart(rec)}${psCommand(argv)}`;
  const context = JSON.stringify({ agent: rec.agent, session: rec.session, flags: safeFlags(rec.agent, rec.flags ?? []) });
  return `${cdPart(rec)}$env:REVIVE_RESUME = ${psQuote(context)}; ${psCommand(argv)}; Remove-Item Env:REVIVE_RESUME -ErrorAction Ignore`;
}

/** The same ANSI styles as lib/core.js, so the notes follow the terminal's theme. */
const SGR = { accent: "1;34", warn: "1;33", caution: "33", strong: "1", dim: "2" };

/**
 * A statement that prints one line of styled parts, each `[style, text]`
 * (style null for plain). Texts stay in single quotes: nothing in them runs.
 * The line goes out as UTF-8 and the shell's own encoding is put back: a
 * Herdr terminal's shell writes with its OEM code page, which has no ↻.
 */
export function psNote(parts) {
  const pieces = parts.flatMap(([style, text]) => (style
    ? [`"$([char]27)[${SGR[style]}m"`, psQuote(text), `"$([char]27)[0m"`]
    : [psQuote(text)]));
  return `& { $e = [Console]::OutputEncoding; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); try { [Console]::Out.WriteLine(-join @(${pieces.join(", ")})) } finally { [Console]::OutputEncoding = $e } }`;
}

/**
 * What a recovered shell runs, as the body of a function: say what is
 * happening, go back to the session's folder, start the agent, and mark the
 * terminal failed when the agent quits with an error within 15 seconds.
 */
export function psResumeScript(rec, engine) {
  const line = psResumeLine(rec, { unattended: true });
  if (!line) return "";
  const name = AGENTS[rec.agent].name;
  const { dropped } = attendedFlags(rec.agent, safeFlags(rec.agent, rec.flags ?? []));
  const notes = [psNote([
    ["accent", "↻ Revive"], [null, "  resuming "], ["strong", name], [null, ` session ${shortId(rec.session)}`],
    ["dim", " · REVIVE_AUTO=0 skips this"],
  ])];
  if (dropped.length) {
    notes.push(psNote([["caution", `  without ${dropped.join(", ")} (only a resume from the Revive dialog keeps ${dropped.length > 1 ? "them" : "it"})`]]));
  }
  return [
    ...notes,
    "$__revive_t = [Diagnostics.Stopwatch]::StartNew()",
    line,
    `if ($LASTEXITCODE -ne 0 -and $__revive_t.Elapsed.TotalSeconds -lt 15) { & node ${psQuote(engine)} failed }`,
    "Remove-Variable __revive_t -ErrorAction Ignore",
  ].join("\n");
}

/** The command to run by hand for a record with needs (lib/core.js needsCommand, in PowerShell). */
export function psNeedsCommand(rec) {
  const argv = command(rec, "resume");
  if (!argv) return null;
  const added = (rec.needs ?? []).filter((n) => n.startsWith("-")).map((f) => ` ${f} <folder>`).join("");
  return `${cdPart(rec)}& ${psQuote(argv[0])}${added}${argv.length > 1 ? ` ${argv.slice(1).map(psQuote).join(" ")}` : ""}`;
}

/**
 * The block for the person's PowerShell profile. In a Herdr terminal's own
 * shell, with a session remembered on it, it asks the engine for the resume
 * function, defines it as `__revive` and types `__revive` into its own
 * terminal, so PSReadLine runs it at the first prompt as if the person had.
 * A native program started from the profile's prompt function would get no
 * console of its own; typed at the prompt it does.
 */
/** Codex subcommands that never start an interactive session: run as typed. */
export const CODEX_PLAIN = ["exec", "e", "login", "logout", "mcp", "mcp-server", "app-server", "app", "completion", "sandbox", "debug", "apply", "a", "cloud", "features", "help", "remote-control"];

export function psProfileBlock(engine) {
  return [
    PROFILE_BEGIN,
    "# Resume the Claude Code session a Herdr terminal lost to a restart or reboot.",
    "# REVIVE_DEBUG=1 says why it did or didn't.",
    "# In a Herdr terminal Codex runs without its shared background server (--no-daemon):",
    "# that server would run Codex's hooks outside the terminal, and Revive couldn't remember it.",
    "if ($env:HC_TERMINAL_ID -and -not $env:HERDR_PANE_ID) {",
    "  function global:codex {",
    "    $real = Get-Command codex -CommandType ExternalScript, Application -ErrorAction Ignore | Select-Object -First 1",
    "    if (-not $real) { Write-Error 'codex is not installed'; return }",
    `    $quiet = @(${CODEX_PLAIN.map(psQuote).join(", ")})`,
    "    if ($args -contains '--no-daemon' -or ($args.Count -and \"$($args[0])\" -in $quiet)) { & $real @args } else { & $real --no-daemon @args }",
    "  }",
    "}",
    "& {",
    "  if (-not $env:HC_TERMINAL_ID) { return }",
    "  $why = $null",
    "  try {",
    "    if ($env:HERDR_PANE_ID) { $why = 'a herdr TUI pane'; return }",
    "    if ($env:REVIVE_AUTO -eq '0') { $why = 'REVIVE_AUTO=0'; return }",
    "    if ([Environment]::GetCommandLineArgs() | Where-Object { $_ -match '^-noni' }) { $why = 'not an interactive shell'; return }",
    `    $engine = ${psQuote(engine)}`,
    "    if (-not (Test-Path -LiteralPath $engine) -or -not (Get-Command node -CommandType Application -ErrorAction Ignore)) { $why = 'no engine or no node'; return }",
    "    if ($env:REVIVE_SHELL) {",
    "      $p = $PID",
    "      for ($i = 0; $i -lt 8 -and $p; $i++) {",
    "        $p = (Get-Process -Id $p -ErrorAction Ignore).Parent.Id",
    "        if (\"$p\" -eq $env:REVIVE_SHELL) { $why = \"a shell started inside the terminal's own shell\"; return }",
    "      }",
    "    }",
    "    $hc = if ($env:REVIVE_HC) { $env:REVIVE_HC } else { 'hc' }",
    "    $hcRun = if ($hc -match '\\.[cm]?js$') { { & node $hc @args } } else { { & $hc @args } }",
    "    $enc = [Console]::OutputEncoding",
    "    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
    "    try {",
    "      try { $j = (@(& $hcRun get $env:HC_TERMINAL_ID --json 2>$null) -join \"`n\") | ConvertFrom-Json -ErrorAction Stop }",
    "      catch { $why = 'hc did not answer'; return }",
    "      if (-not $j.labels.'revive.session') { $why = \"nothing remembered on $env:HC_TERMINAL_ID\"; return }",
    "      if (\"$($j.pid)\" -ne \"$PID\") { $why = \"not the terminal's own shell\"; return }",
    "      $since = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o')",
    "      $out = if ($env:REVIVE_DEBUG) { & node $engine check --shell $PID --since $since } else { & node $engine check --shell $PID --since $since 2>$null }",
    "      $body = (@($out) -join \"`n\").Trim()",
    "    } finally { [Console]::OutputEncoding = $enc }",
    "    if (-not $body) { $why = 'nothing to resume'; return }",
    "    Set-Item function:global:__revive ([scriptblock]::Create($body + \"`nRemove-Item function:global:__revive -ErrorAction Ignore\"))",
    "    $t = $env:HC_TERMINAL_ID",
    "    Remove-Item Env:HC_TERMINAL_ID",
    "    try { & $hcRun send $t '__revive' *> $null } finally { $env:HC_TERMINAL_ID = $t }",
    "    $why = 'resuming at the first prompt'",
    "  } catch { $why = \"error: $_\" }",
    "  finally {",
    "    $env:REVIVE_SHELL = \"$PID\"",
    "    $global:LASTEXITCODE = 0",
    "    if ($env:REVIVE_DEBUG -and $why) { [Console]::Error.WriteLine(\"revive: $why\") }",
    "  }",
    "}",
    PROFILE_END,
  ].join("\n");
}
