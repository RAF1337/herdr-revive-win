// The hook on Windows, against a fake `hc` and a real process tree: the fake
// agents are hard links of node.exe named claude.exe, so the CIM process table
// shows them the way it shows the real Claude Code. The terminal's "shell" is
// this test process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, linkSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { WINDOWS_ONLY } from "./helpers/platform.js";

const ENGINE = resolve("mods/revive-win/revive.mjs");
const ID = "0c8b28eb-1111-4222-8333-444455556666";
const OTHER = "1d9c39fc-2222-4333-8444-555566667777";

const cleanEnv = () => {
  const env = { ...process.env };
  for (const k of ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SCOPE", "CLAUDE_CONFIG_DIR", "REVIVE_RESUME", "REVIVE_SHELL"]) delete env[k];
  return env;
};

function setup({ labels = {}, terminals = [], argv = ["--model", "opus", "fix it"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "revive-winhook-"));
  writeFileSync(join(dir, "state.json"), JSON.stringify({ labels, terminals }));
  const hc = join(dir, "hc.mjs");
  writeFileSync(hc, `import { appendFileSync, readFileSync } from "node:fs";
const dir = ${JSON.stringify(dir)};
const [cmd, t, ...rest] = process.argv.slice(2);
const state = JSON.parse(readFileSync(dir + "/state.json", "utf8"));
const pid = Number(process.env.FAKE_TERMINAL_PID);
if (cmd === "get") {
  const other = state.terminals.find((x) => x.address === t);
  console.log(JSON.stringify(other ? { address: t, state: "live", pid: 1, labels: other.labels }
    : { address: t, state: "live", pid, cwd: "C:\\\\w", labels: state.labels, status: null, foreground: { pid, argv: ["pwsh.exe"], cwd: "C:\\\\w" } }));
} else if (cmd === "ls") {
  console.log(JSON.stringify({ terminals: [{ address: "t1" }, ...state.terminals.map((x) => ({ address: x.address }))] }));
} else if (cmd === "label") {
  appendFileSync(dir + "/labels.log", JSON.stringify([t, ...rest]) + "\\n");
}
`);
  const agentJs = join(dir, "agent.cjs");
  writeFileSync(agentJs, `const { spawnSync } = require("child_process");
let input = Buffer.alloc(0);
try { input = require("fs").readFileSync(0); } catch {}
if (process.env.NESTED) {
  const r = spawnSync("cmd.exe", ["/d", "/c", process.env.NESTED, __filename, "-p", "hi"], { input, env: { ...process.env, NESTED: "" }, stdio: ["pipe", "inherit", "inherit"] });
  process.exit(r.status ?? 0);
}
const r = spawnSync(process.env.NODE_BIN, [process.env.ENGINE, "hook"], { input, stdio: ["pipe", "inherit", "inherit"] });
process.exit(r.status ?? 0);
`);
  const agent = (name) => {
    mkdirSync(join(dir, name));
    const path = join(dir, name, "claude.exe");
    try { linkSync(process.execPath, path); } catch { copyFileSync(process.execPath, path); }
    return path;
  };
  const outer = agent("outer");
  const inner = agent("inner");
  let tookMs = 0;
  const run = (payload, { nested = false, env = {} } = {}) => {
    const started = performance.now();
    const r = spawnSync(outer, [agentJs, ...argv], {
      input: typeof payload === "string" ? payload : JSON.stringify(payload),
      env: { ...cleanEnv(), HC_TERMINAL_ID: "t1", REVIVE_HC: hc, FAKE_TERMINAL_PID: String(process.pid), NODE_BIN: process.execPath, ENGINE, NESTED: nested ? inner : "", ...env },
      encoding: "utf8",
      timeout: 60_000,
    });
    tookMs = performance.now() - started;
    return r;
  };
  const calls = () => (existsSync(join(dir, "labels.log")) ? readFileSync(join(dir, "labels.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const set = (list) => Object.fromEntries(list.flatMap(([, ...args]) => args).map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
  return { run, calls, set, took: () => tookMs };
}

const start = { hook_event_name: "SessionStart", session_id: ID, cwd: "C:\\w", source: "startup" };
const end = (reason) => ({ hook_event_name: "SessionEnd", session_id: ID, reason });
const remembered = { "revive.agent": "claude", "revive.session": ID, "revive.shell": String(process.pid) };

test("the foreground agent's SessionStart is remembered on Windows, with its flags and start time", { skip: WINDOWS_ONLY }, (t) => {
  const f = setup();
  const r = f.run(start);
  assert.equal(r.status, 0, r.stderr);
  const got = f.set(f.calls());
  assert.equal(got["revive.agent"], "claude");
  assert.equal(got["revive.session"], ID);
  assert.equal(got["revive.flags"], '["--model","opus"]');
  assert.equal(got["revive.shell"], String(process.pid));
  assert.match(got["revive.since"], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  t.diagnostic(`hook wall time ${Math.round(f.took())} ms`);
});

test("a `claude -p` the agent runs as a tool records nothing on Windows", { skip: WINDOWS_ONLY }, () => {
  const f = setup();
  f.run(start, { nested: true });
  assert.deepEqual(f.calls(), []);
});

test("a `claude -p` typed in the terminal records nothing on Windows", { skip: WINDOWS_ONLY }, () => {
  const f = setup({ argv: ["-p", "summarize this"] });
  f.run(start);
  assert.deepEqual(f.calls(), []);
});

test("on Windows a signal keeps the session and /exit forgets it", { skip: WINDOWS_ONLY }, () => {
  const f = setup({ labels: remembered });
  f.run(end("other"));
  assert.deepEqual(f.calls(), []);
  f.run(end("prompt_input_exit"));
  assert.equal(f.set(f.calls())["revive.session"], "");
});

test("a resumed session is forgotten by the other terminals that held it", { skip: WINDOWS_ONLY }, () => {
  const f = setup({ terminals: [
    { address: "t2", labels: { "revive.agent": "claude", "revive.session": ID } },
    { address: "t3", labels: { "revive.agent": "claude", "revive.session": OTHER } },
  ] });
  f.run({ ...start, source: "resume" });
  const byTerminal = (t) => f.calls().filter(([addr]) => addr === t);
  assert.equal(f.set(byTerminal("t1"))["revive.session"], ID);
  assert.equal(f.set(byTerminal("t2"))["revive.session"], "");
  assert.deepEqual(byTerminal("t3"), []);
});

test("a hook given garbage exits 0 and records nothing on Windows", { skip: WINDOWS_ONLY }, () => {
  const f = setup();
  const r = f.run("not json");
  assert.equal(r.status, 0);
  assert.deepEqual(f.calls(), []);
});

test("on Windows a Codex /exit forgets its session, and another session's end changes nothing", { skip: WINDOWS_ONLY }, (t) => {
  const codex = { ...remembered, "revive.agent": "codex" };
  const f = setup({ labels: codex });
  f.run({ hook_event_name: "SessionEnd", session_id: OTHER, reason: "other" }, { nested: true });
  assert.deepEqual(f.calls(), []);
  f.run(end("other"));
  assert.equal(f.set(f.calls())["revive.session"], "");
  t.diagnostic(`end hook wall time ${Math.round(f.took())} ms`);
});

// Codex gives SessionEnd 3 seconds, and reading the process list through
// PowerShell takes most of that: an end is matched by its session id instead.
test("on Windows an end doesn't need the process list", { skip: WINDOWS_ONLY }, () => {
  const f = setup({ labels: { ...remembered, "revive.agent": "codex" } });
  const noPwsh = { PATH: [dirname(process.execPath), join(process.env.SystemRoot ?? "C:\\Windows", "System32")].join(";") };
  f.run(end("other"), { env: noPwsh });
  assert.equal(f.set(f.calls())["revive.session"], "");
});

test("a pi SessionStart on Windows is remembered with its session file, and /quit forgets it", { skip: WINDOWS_ONLY }, () => {
  const PI_ID = "01a1ebb1-b38e-717b-89d4-22638256b32c";
  const file = String.raw`C:\Users\me\.pi\agent\sessions\--w--\2026-11-17T22-47-34-031Z_` + PI_ID + ".jsonl";
  const f = setup();
  const r = f.run({ ...start, session_id: PI_ID, transcript_path: file, argv: ["pi", "--model", "x"] });
  assert.equal(r.status, 0, r.stderr);
  const got = f.set(f.calls());
  assert.equal(got["revive.agent"], "pi");
  assert.equal(got["revive.session"], PI_ID);
  assert.equal(got["revive.transcript"], file);
  assert.equal(got["revive.flags"], '["--model","x"]');
  const piRec = { "revive.agent": "pi", "revive.session": PI_ID, "revive.shell": String(process.pid) };
  const kept = setup({ labels: piRec });
  kept.run({ hook_event_name: "SessionEnd", session_id: PI_ID, reason: "other" });
  assert.deepEqual(kept.calls(), []);
  const quit = setup({ labels: piRec });
  quit.run({ hook_event_name: "SessionEnd", session_id: PI_ID, reason: "prompt_input_exit" });
  assert.equal(quit.calls().length, 1);
});
