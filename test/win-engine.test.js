// The engine on Windows: the folder rule, `check` (what a recovered shell runs),
// the dialog's Resume and list, and adopt, against a fake `hc` and real
// processes standing in for the terminal's shell and its agent.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, linkSync, copyFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { folderOwners, winProcesses } from "../mods/revive-win/lib/win.js";
import { needsHint } from "../mods/revive-win/lib/core.js";
import { psNeedsCommand } from "../mods/revive-win/lib/pwsh.js";
import { WINDOWS_ONLY } from "./helpers/platform.js";

const ENGINE = resolve("mods/revive-win/revive.mjs");
const ID = "0c8b28eb-1111-4222-8333-444455556666";
const dashed = (p) => p.replace(/[^A-Za-z0-9]/g, "-");

test("the hint for a session with needs ends with the PowerShell command", () => {
  const rec = { agent: "claude", session: ID, cwd: "C:\\w", flags: [], needs: ["CLAUDE_CONFIG_DIR"] };
  assert.ok(needsHint(rec, psNeedsCommand).endsWith(`then run: Set-Location -LiteralPath 'C:\\w' -ErrorAction Stop; & 'claude' '--resume' '${ID}'`));
});

test("a folder is the person's when they, Administrators or SYSTEM own it", { skip: WINDOWS_ONLY }, async () => {
  const mine = mkdtempSync(join(tmpdir(), "revive-owner-"));
  const missing = join(mine, "gone");
  const owners = await folderOwners([mine, "C:\\Windows", missing]);
  assert.equal(owners.get(mine), true);
  assert.equal(owners.get("C:\\Windows"), false);
  assert.equal(owners.get(missing), false);
});

// ── a world: a fake hc, a Claude folder, and real processes ───────────────

const kids = [];
after(() => { for (const pid of kids) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); });

/** A long-running process standing in for a terminal's shell, optionally with a child (an agent, or anything busy). */
function shell(child = null) {
  const script = child
    ? `require("child_process").spawn(${JSON.stringify(child)}, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); setInterval(() => {}, 1000);`
    : "setInterval(() => {}, 1000);";
  const p = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
  kids.push(p.pid);
  return p;
}
/** Waits until `p` (from shell()) runs, and its child too when it was given one; returns the child's pid or null. */
async function settle(p, { child = false } = {}) {
  for (let i = 0; i < 30; i++) {
    const table = await winProcesses();
    const kid = [...table].find(([, proc]) => proc.ppid === p.pid)?.[0] ?? null;
    if (table.has(p.pid) && (!child || kid)) return kid;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`process ${p.pid} didn't start${child ? " its child" : ""}`);
}

function world({ labels = {}, terminalPid = 4321 } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "revive-wineng-")));
  const folder = join(root, "work");
  const claude = join(root, "claude-home");
  mkdirSync(folder);
  mkdirSync(join(claude, "projects", dashed(folder)), { recursive: true });
  mkdirSync(join(claude, "sessions"), { recursive: true });
  writeFileSync(join(claude, "projects", dashed(folder), `${ID}.jsonl`), JSON.stringify({ cwd: folder }) + "\n");
  const state = join(root, "state.json");
  const save = (s) => writeFileSync(state, JSON.stringify(s));
  save({ labels, pid: terminalPid });
  const hc = join(root, "hc.mjs");
  writeFileSync(hc, `import { appendFileSync, readFileSync } from "node:fs";
const [cmd, t, ...rest] = process.argv.slice(2);
const s = JSON.parse(readFileSync(${JSON.stringify(state)}, "utf8"));
if (cmd === "get") console.log(JSON.stringify({ address: t, state: "live", pid: s.pid, cwd: ${JSON.stringify(folder)}, labels: s.labels, status: null, foreground: { pid: s.pid, argv: ["pwsh.exe"], cwd: ${JSON.stringify(folder)} } }));
else if (cmd === "ls") console.log(JSON.stringify({ terminals: [{ address: "t1" }] }));
else appendFileSync(${JSON.stringify(join(root, "hc.log"))}, JSON.stringify({ args: [cmd, t, ...rest], hcTerminalId: process.env.HC_TERMINAL_ID ?? null }) + "\\n");
`);
  const engineWith = (extra, ...args) => {
    const env = { ...process.env, HC_TERMINAL_ID: "t1", REVIVE_HC: hc, CLAUDE_CONFIG_DIR: claude, ...extra };
    for (const k of ["HC_TERMINAL_SOCKET", "HC_SCOPE", "REVIVE_SHELL", "REVIVE_DEBUG"]) delete env[k];
    return spawnSync(process.execPath, [ENGINE, ...args], { encoding: "utf8", env, timeout: 60_000 });
  };
  const engine = (...args) => engineWith({}, ...args);
  const calls = () => (existsSync(join(root, "hc.log")) ? readFileSync(join(root, "hc.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const labelled = () => Object.fromEntries(calls().filter((c) => c.args[0] === "label").flatMap((c) => c.args.slice(2)).map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
  const linkedClaude = () => {
    const path = join(root, "claude.exe");
    if (!existsSync(path)) { try { linkSync(process.execPath, path); } catch { copyFileSync(process.execPath, path); } }
    return path;
  };
  return { root, folder, claude, save, engine, engineWith, calls, labelled, linkedClaude };
}

const record = (cwd, extra = {}) => ({ "revive.agent": "claude", "revive.session": ID, "revive.cwd": cwd, "revive.flags": '["--model","opus"]', "revive.shell": "1234", "revive.since": "2026-01-01T00:00:00.000Z", ...extra });

test("check prints the PowerShell resume for a lost session and marks the terminal first", { skip: WINDOWS_ONLY }, () => {
  const w = world();
  w.save({ labels: record(w.folder), pid: 4321 });
  const r = w.engine("check", "--shell", "4321", "--since", "2026-11-16T07:16:49.0576270Z");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`Set-Location -LiteralPath '${w.folder}'`), r.stdout);
  assert.ok(r.stdout.includes("& 'claude' '--model' 'opus' '--resume' '" + ID + "'"), r.stdout);
  const got = w.labelled();
  assert.equal(got["revive.shell"], "4321");
  assert.equal(got["revive.since"], "2026-11-16T07:16:49.057Z");
  assert.match(got["revive.resumed"], /^\d+$/);
});

test("check stays quiet in the same shell, and resumes when an old pid has a new start time", { skip: WINDOWS_ONLY }, () => {
  const same = world();
  same.save({ labels: record(same.folder), pid: 1234 });
  assert.equal(same.engine("check", "--shell", "1234", "--since", "2026-01-01T00:00:00.0000000Z").stdout, "");
  const reused = world();
  reused.save({ labels: record(reused.folder), pid: 1234 });
  assert.match(reused.engine("check", "--shell", "1234", "--since", "2026-11-16T07:16:49.0576270Z").stdout, /--resume/);
});

test("check does nothing in a shell that isn't the terminal's", { skip: WINDOWS_ONLY }, () => {
  const w = world();
  w.save({ labels: record(w.folder), pid: 4321 });
  assert.equal(w.engine("check", "--shell", "999", "--since", "2026-11-16T07:16:49.0576270Z").stdout, "");
  assert.deepEqual(w.calls(), []);
});

test("check won't resume into a folder that isn't the person's, says so once and marks it failed", { skip: WINDOWS_ONLY }, () => {
  const w = world();
  w.save({ labels: record("C:\\Windows"), pid: 4321 });
  const r = w.engine("check", "--shell", "4321", "--since", "2026-11-16T07:16:49.0576270Z");
  assert.match(r.stdout, /not resuming Claude Code session 0c8b28eb/);
  assert.match(r.stdout, /^& \{ .*\[Console\]::Out\.WriteLine\(/, "a PowerShell statement, not printf");
  assert.doesNotMatch(r.stdout, /--resume/);
  assert.match(w.labelled()["revive.failed"], /^\d+$/);
});

test("Resume refuses a terminal whose shell is busy, and types into an idle one", { skip: WINDOWS_ONLY }, async () => {
  const w = world();
  const busy = shell(process.execPath);
  const idle = shell();
  await settle(busy, { child: true });
  await settle(idle);
  w.save({ labels: record(w.folder), pid: busy.pid });
  const refused = w.engine("resume", "t1");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /busy/);
  assert.ok(!w.calls().some((c) => c.args[0] === "send"));
  w.save({ labels: record(w.folder), pid: idle.pid });
  const ok = w.engine("resume", "t1");
  assert.equal(ok.status, 0, ok.stderr);
  const send = w.calls().find((c) => c.args[0] === "send");
  assert.equal(send.hcTerminalId, null);
  assert.ok(send.args[2].startsWith(`Set-Location -LiteralPath '${w.folder}' -ErrorAction Stop; & 'claude'`), send.args[2]);
});

test("without the process list Resume types nothing, and list says it can't tell", { skip: WINDOWS_ONLY }, async () => {
  const w = world();
  const idle = shell();
  await settle(idle);
  w.save({ labels: record(w.folder), pid: idle.pid });
  // No pwsh on PATH: the process table can't be read.
  const noPwsh = { PATH: `${dirname(process.execPath)};C:\\Windows\\System32` };
  const r = w.engineWith(noPwsh, "resume", "t1");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /can't tell what runs in t1/);
  assert.ok(!w.calls().some((c) => c.args[0] === "send"));
  const l = w.engineWith(noPwsh, "list");
  assert.equal(l.status, 1);
  assert.match(l.stderr, /PowerShell 7 \(pwsh\) is required: https:\/\/aka\.ms\/powershell/, "says what is missing, not just that it failed");
});

test("Resume refuses a session that is already running", { skip: WINDOWS_ONLY }, async () => {
  const w = world();
  const s = shell(w.linkedClaude());
  await settle(s, { child: true });
  w.save({ labels: record(w.folder), pid: s.pid });
  const r = w.engine("resume", "t1");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already running/);
});

test("list shows a running session as running, and gives a session with needs its PowerShell command", { skip: WINDOWS_ONLY }, async () => {
  const w = world();
  const s = shell(w.linkedClaude());
  await settle(s, { child: true });
  w.save({ labels: record(w.folder), pid: s.pid });
  const running =JSON.parse(w.engine("list", "--focus", "t1").stdout).entries[0];
  assert.equal(running.state, "running");
  w.save({ labels: record(w.folder, { "revive.needs": '["CLAUDE_CONFIG_DIR"]' }), pid: 4321 });
  const needs = JSON.parse(w.engine("list").stdout).entries[0];
  assert.ok(needs.byHand.startsWith(`Set-Location -LiteralPath '${w.folder}' -ErrorAction Stop; & 'claude'`), needs.byHand);
});

test("adopt --dry-run finds a running Claude Code session nobody recorded", { skip: WINDOWS_ONLY }, async () => {
  const w = world();
  const s = shell(w.linkedClaude());
  const claudePid = await settle(s, { child: true });
  writeFileSync(join(w.claude, "sessions", `${claudePid}.json`), JSON.stringify({ pid: claudePid, sessionId: ID, cwd: w.folder }));
  w.save({ labels: {}, pid: s.pid });
  const r = w.engine("adopt", "--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Would remember 1 running session/);
  assert.ok(r.stdout.includes(w.folder), r.stdout);
});
