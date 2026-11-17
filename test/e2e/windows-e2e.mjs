// End to end on Windows: a real herdr-core of its own (HC_SESSION=revive-e2e),
// real pwsh terminals running Revive's profile block, Revive's real engine and
// hooks, and a stand-in claude.exe. Loss is a stop and start of that core.
//
// Never touches the person's herdr-core: every hc call that changes anything
// runs with HC_SESSION=revive-e2e and none of the HC_TERMINAL_* variables,
// the core's pid is checked against the default core's before any change, and
// the default core's terminals are compared before and after.
//
// Run: npm run e2e:win (Windows, with pwsh, Git Bash, Windows PowerShell and hc).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { psProfileBlock, psQuote } from "../../mods/revive-win/lib/pwsh.js";
import { safeToStop } from "./guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = resolve(HERE, "../../mods/revive-win/revive.mjs");
const SESSION = "revive-e2e";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.platform !== "win32") {
  console.log("windows-e2e: Windows only; nothing to do here.");
  process.exit(0);
}

// ── the person's core: read only ────────────────────────────────────────────

const hcDefault = (args) => spawnSync("hc", args, { encoding: "utf8", timeout: 30_000 });
const defaultStatus = hcDefault(["server", "status", "--json"]);
const defaultPid = defaultStatus.status === 0 ? JSON.parse(defaultStatus.stdout).pid : null;
const defaultAddresses = () => (defaultPid === null ? null
  : JSON.parse(hcDefault(["ls", "--json"]).stdout).terminals.map((t) => t.address).sort());
const before = defaultAddresses();

// ── a scratch world and its own core ───────────────────────────────────────

const root = mkdtempSync(join(tmpdir(), "revive-e2e-"));
const home = join(root, "home");
const appdata = join(home, "AppData", "Roaming");
const bin = join(root, "bin");
const work = join(root, "work");
const state = join(root, "state");
for (const d of [home, join(appdata, "herdr-core"), bin, work, state]) mkdirSync(d, { recursive: true });
// herdr-core gives each terminal the login session's environment (PATH and
// USERPROFILE from the registry), not the one it was started with, so the
// terminals' shell sets the test's own before Revive's block runs: the
// stand-in claude.exe first on PATH, and a scratch home for ~/.claude.
const fakes = {
  USERPROFILE: home, HOME: home,
  FAKE_CLAUDE_NODE: process.execPath, FAKE_CLAUDE_SCRIPT: join(HERE, "fake-claude.cjs"), FAKE_CLAUDE_ENGINE: ENGINE, FAKE_CLAUDE_STATE: state,
  FAKE_CODEX_SCRIPT: join(HERE, "fake-codex.cjs"),
};
const profile = join(root, "test-profile.ps1");
writeFileSync(profile, [
  `$env:PATH = ${psQuote(bin + ";")} + $env:PATH`,
  ...Object.entries(fakes).map(([k, v]) => `$env:${k} = ${psQuote(v)}`),
  "Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction Ignore",
  psProfileBlock(ENGINE),
  "",
].join("\n"));
writeFileSync(join(appdata, "herdr-core", "config.toml"), `shell = ["pwsh", "-NoProfile", "-NoExit", "-File", ${JSON.stringify(profile)}]\n`);
const compiled = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command",
  `Add-Type -TypeDefinition (Get-Content -Raw '${join(HERE, "claude-launcher.cs")}') -OutputAssembly '${join(bin, "claude.exe")}' -OutputType ConsoleApplication -ReferencedAssemblies System.Core`], { encoding: "utf8" });
if (!existsSync(join(bin, "claude.exe"))) throw new Error(`couldn't build the stand-in claude.exe: ${compiled.stderr}`);
// The same launcher as codex.exe: it runs fake-codex.cjs (FAKE_CODEX_SCRIPT).
copyFileSync(join(bin, "claude.exe"), join(bin, "codex.exe"));
// pi the way npm installs it: pi.cmd runs node on the package's cli.js.
const piCli = join(root, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
mkdirSync(dirname(piCli), { recursive: true });
copyFileSync(join(HERE, "fake-pi.cjs"), piCli);
writeFileSync(join(bin, "pi.cmd"), `@"%FAKE_CLAUDE_NODE%" "${piCli}" %*\r\n`);

const env = { ...process.env };
for (const k of Object.keys(env)) {
  if (/^(HC_TERMINAL_ID|HC_TERMINAL_SOCKET|HC_SCOPE|CLAUDECODE|CLAUDE_PID|CLAUDE_CONFIG_DIR|CLAUDE_CODE_.*|CODEX_.*|REVIVE_.*)$/.test(k)) delete env[k];
}
// The core reads its config.toml from APPDATA; the engine run from here
// (the dialog's Resume) sees the same scratch home as the terminals.
Object.assign(env, { HC_SESSION: SESSION, APPDATA: appdata, PATH: `${bin};${process.env.PATH}`, ...fakes });

if (defaultPid === null) throw new Error("the person's herdr-core isn't answering, so this test can't tell its own core from theirs; open Herdr and run it again");
const hc = (args) => spawnSync("hc", args, { encoding: "utf8", env, timeout: 60_000 });
const status = () => { const r = hc(["server", "status", "--json"]); return r.status === 0 ? JSON.parse(r.stdout) : null; };
/** Stops the core answering this test's HC_SESSION, only when it is provably not the person's. */
function stopCore() {
  const s = status();
  if (!s) return;
  if (!safeToStop(s, defaultPid)) throw new Error("the core answering the e2e session is the person's; not stopping it");
  hc(["server", "stop"]);
}
function startCore() {
  hc(["server", "start"]);
  if (!safeToStop(status(), defaultPid)) throw new Error("the e2e core isn't separate from the person's core; stopping");
}
// A core or state left by an earlier run of this test: only ever this session's.
const coreState = join(process.env.LOCALAPPDATA, "herdr-core", SESSION);
stopCore();
rmSync(coreState, { recursive: true, force: true });
startCore();
if (JSON.parse(hc(["ls", "--json"]).stdout).terminals.length) throw new Error("the e2e core isn't empty; stopping");

const get = (t) => JSON.parse(hc(["get", t, "--json"]).stdout);
const labels = (t) => get(t).labels ?? {};
const read = (t) => hc(["read", t, "--lines", "80"]).stdout;
const send = (t, text) => hc(["send", t, text]);
async function waitFor(what, fn, ms = 45_000, screen = null) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) {
    const v = fn();
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}${screen ? `\n--- ${screen} ---\n${read(screen)}` : ""}`);
}
async function terminal() {
  const t = JSON.parse(hc(["run", "--json", "--bg", "--keep", "--cwd", work]).stdout).address;
  await waitFor(`${t}'s prompt`, () => /PS .*>/.test(read(t)));
  return t;
}
async function loss() {
  stopCore();
  await sleep(1500);
  startCore();
  await sleep(1000);
}
const engine = (...args) => spawnSync(process.execPath, [ENGINE, ...args], { encoding: "utf8", env, timeout: 60_000 });

after(async () => {
  stopCore();
  await sleep(1500);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  rmSync(coreState, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

// ── the cases ───────────────────────────────────────────────────────────────

let t1, first, t2, third;

test("a Claude Code session is remembered with its flags", async () => {
  t1 = await terminal();
  send(t1, "claude --model opus");
  first = await waitFor("a record", () => labels(t1)["revive.session"], 45_000, t1);
  assert.equal(labels(t1)["revive.flags"], '["--model","opus"]');
  assert.match(read(t1), new RegExp(`FAKE CLAUDE ${first}`));
});

test("after a loss it comes back in the same terminal, with its flags", async () => {
  await loss();
  await waitFor("the resume", () => read(t1).includes(`FAKE CLAUDE ${first} ["--model","opus","--resume","${first}"]`), 45_000, t1);
  assert.match(labels(t1)["revive.resumed"] ?? "", /^\d+$/);
  assert.ok(read(t1).includes(`↻ Revive  resuming Claude Code session ${first.slice(0, 8)}`), read(t1));
});

test("the dialog's Resume won't type into a running session", async () => {
  const r = engine("resume", t1);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already running|busy/);
  await sleep(1000);
  assert.ok(!read(t1).includes("Set-Location"), "nothing typed");
});

test("a session ended with /exit stays ended after a loss", async () => {
  send(t1, "exit");
  await waitFor("the record to go", () => !labels(t1)["revive.session"]);
  await loss();
  await sleep(15_000);
  assert.ok(!read(t1).includes("FAKE CLAUDE"), read(t1));
});

test("a resume that fails is tried once, not at every start", async () => {
  send(t1, "claude");
  const second = await waitFor("a new record", () => labels(t1)["revive.session"]);
  writeFileSync(join(state, "fail-resume"), "");
  await loss();
  await waitFor("the failed mark", () => labels(t1)["revive.failed"]);
  rmSync(join(state, "fail-resume"));
  await loss();
  await sleep(15_000);
  assert.ok(!read(t1).includes(`FAKE CLAUDE ${second}`), read(t1));
});

test("a shell started inside the terminal's own doesn't resume again", async () => {
  t2 = await terminal();
  send(t2, "claude");
  third = await waitFor("a record", () => labels(t2)["revive.session"]);
  await loss();
  await waitFor("the resume", () => read(t2).includes(`FAKE CLAUDE ${third} ["--resume","${third}"]`));
  send(t2, "vanish");
  await waitFor("the prompt", () => /PS .*>\s*$/.test(read(t2).trimEnd() + " "));
  send(t2, `$env:REVIVE_DEBUG = '1'; pwsh -NoProfile -NoExit -File '${profile}'`);
  await waitFor("the nested block's reason", () => read(t2).includes("revive: a shell started inside the terminal's own shell"), 30_000);
  const resumes = read(t2).split(`FAKE CLAUDE ${third}`).length - 1;
  await sleep(5000);
  assert.equal(read(t2).split(`FAKE CLAUDE ${third}`).length - 1, resumes);
  send(t2, "exit");
});

test("the dialog's Resume types into an idle shell, with every flag", async () => {
  await sleep(1500);
  const r = engine("resume", t2);
  assert.equal(r.status, 0, r.stderr);
  await waitFor("the manual resume", () => read(t2).split(`FAKE CLAUDE ${third}`).length - 1 >= 2);
});

let t3, codexId;

// Typed in a Herdr terminal, codex runs through Revive's wrapper, with --no-daemon.
test("a Codex session is remembered at its first message", async () => {
  t3 = await terminal();
  send(t3, "codex --yolo");
  await waitFor("Codex", () => read(t3).includes('FAKE CODEX ["--no-daemon","--yolo"]'), 45_000, t3);
  await sleep(1000);
  assert.equal(labels(t3)["revive.session"] ?? "", "", "nothing before the first message");
  send(t3, "hi");
  codexId = await waitFor("a Codex record", () => labels(t3)["revive.session"], 45_000, t3);
  assert.equal(labels(t3)["revive.agent"], "codex");
  assert.equal(labels(t3)["revive.flags"], '["--no-daemon","--yolo"]');
});

test("after a loss Codex comes back, without the approval-lifting flag", async () => {
  await loss();
  await waitFor("the Codex resume", () => read(t3).includes(`FAKE CODEX ["resume","--no-daemon","${codexId}"]`), 45_000, t3);
  assert.ok(read(t3).includes(`↻ Revive  resuming Codex session ${codexId.slice(0, 8)}`), read(t3));
});

test("a Codex session ended with /exit is forgotten", async () => {
  send(t3, "exit");
  await waitFor("the Codex record to go", () => !labels(t3)["revive.session"], 30_000, t3);
});

let t4, piId;

test("a pi session is remembered with its session file", async () => {
  t4 = await terminal();
  send(t4, "pi --model x");
  piId = await waitFor("a pi record", () => labels(t4)["revive.session"], 45_000, t4);
  assert.equal(labels(t4)["revive.agent"], "pi");
  assert.equal(labels(t4)["revive.flags"], '["--model","x"]');
  assert.ok(labels(t4)["revive.transcript"].endsWith(`${piId}.jsonl`), labels(t4)["revive.transcript"]);
});

test("the dialog shows the pi session as running, and won't type into it", async () => {
  const r = engine("list", "--focus", t4);
  assert.equal(r.status, 0, r.stderr);
  const entry = JSON.parse(r.stdout).entries.find((e) => e.address === t4);
  assert.equal(entry?.state, "running", r.stdout);
  const resume = engine("resume", t4);
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /already running/);
});

test("after a loss pi comes back with its flags", async () => {
  await loss();
  await waitFor("the pi resume", () => read(t4).includes(`FAKE PI ["--model","x","--session","${piId}"]`), 45_000, t4);
  assert.ok(read(t4).includes(`↻ Revive  resuming pi session ${piId.slice(0, 8)}`), read(t4));
});

test("a pi session ended with /quit is forgotten", async () => {
  await waitFor("the resumed pi's record", () => read(t4).includes(`FAKE PI SESSION ${piId}`), 30_000, t4);
  send(t4, "quit");
  await waitFor("the pi record to go", () => !labels(t4)["revive.session"], 30_000, t4);
});

test("the hook's time, and the person's herdr-core unchanged", (t) => {
  const ms = readFileSync(join(state, "hook-ms.log"), "utf8").trim().split("\n").map(Number).sort((a, b) => a - b);
  t.diagnostic(`hook wall time (ms): ${ms.join(", ")}; median ${ms[Math.floor(ms.length / 2)]}`);
  assert.deepEqual(defaultAddresses(), before);
});
