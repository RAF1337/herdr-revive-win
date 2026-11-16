// Revive's PowerShell block in a Herdr terminal runs Codex with --no-daemon:
// Codex otherwise joins a shared background server that is already running,
// which runs its hooks outside the terminal. A real pwsh, a fake codex.cmd.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { psProfileBlock } from "../mods/revive-win/lib/pwsh.js";
import { WINDOWS_ONLY } from "./helpers/platform.js";

function run(lines, { inHerdr = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "revive-codexwrap-"));
  writeFileSync(join(dir, "codex.cmd"), "@echo off\r\necho ARGS:%*\r\n");
  const hc = join(dir, "hc.mjs");
  writeFileSync(hc, "process.exit(1);\n");
  const profile = join(dir, "profile.ps1");
  writeFileSync(profile, psProfileBlock(resolve("mods/revive-win/revive.mjs")) + "\n");
  const env = { ...process.env, PATH: `${dir};${process.env.PATH}`, REVIVE_HC: hc };
  for (const k of ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SCOPE", "HERDR_PANE_ID", "REVIVE_SHELL", "REVIVE_DEBUG"]) delete env[k];
  if (inHerdr) env.HC_TERMINAL_ID = "t9";
  const script = [`. '${profile}'`, ...lines].join("\n");
  const r = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-Command", script], { encoding: "utf8", env, timeout: 60_000 });
  return r.stdout.split(/\r?\n/).filter((l) => l.startsWith("ARGS:")).map((l) => l.slice(5).trim());
}

test("in a Herdr terminal codex runs with --no-daemon, except non-interactive subcommands", { skip: WINDOWS_ONLY }, () => {
  assert.deepEqual(run([
    "codex",
    "codex 'fix it'",
    "codex --yolo",
    "codex --no-daemon",
    "codex resume --last",
    "codex exec hi",
    "codex login",
  ]), ["--no-daemon", "--no-daemon \"fix it\"", "--no-daemon --yolo", "--no-daemon", "--no-daemon resume --last", "exec hi", "login"]);
});

test("outside a Herdr terminal codex is untouched", { skip: WINDOWS_ONLY }, () => {
  assert.deepEqual(run(["codex --yolo"], { inHerdr: false }), ["--yolo"]);
});
