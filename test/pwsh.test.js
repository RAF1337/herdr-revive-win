// lib/pwsh.js: the PowerShell Revive writes on Windows. The strings are
// checked everywhere; running them needs pwsh, so those tests are Windows only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { psQuote, psCommand, psResumeLine, psResumeScript, psProfileBlock, psNeedsCommand, psNote, PROFILE_BEGIN, PROFILE_END } from "../mods/revive-win/lib/pwsh.js";
import { WINDOWS_ONLY } from "./helpers/platform.js";

const ID = "0c8b28eb-1111-4222-8333-444455556666";
const rec = { agent: "claude", session: ID, cwd: "C:\\Users\\me\\O'Brien æble", flags: ["--dangerously-skip-permissions", "--model", "opus"], needs: [] };

test("PowerShell quoting", () => {
  assert.equal(psQuote("it's"), "'it''s'");
  assert.equal(psQuote("a’b"), "'a’’b'");
  assert.equal(psQuote("$HOME;`x"), "'$HOME;`x'");
  assert.equal(psQuote(""), "''");
  assert.equal(psCommand(["claude", "--resume", ID]), `& 'claude' '--resume' '${ID}'`);
});

test("the resume line, by hand and unattended", () => {
  assert.equal(psResumeLine(rec), `Set-Location -LiteralPath 'C:\\Users\\me\\O''Brien æble' -ErrorAction Stop; & 'claude' '--dangerously-skip-permissions' '--model' 'opus' '--resume' '${ID}'`);
  const auto = psResumeLine(rec, { unattended: true });
  assert.match(auto, /^Set-Location -LiteralPath '.*' -ErrorAction Stop; \$env:REVIVE_RESUME = '\{.*\}'; & 'claude' '--model' 'opus' '--resume' '0c8b28eb[^']*'; Remove-Item Env:REVIVE_RESUME -ErrorAction Ignore$/);
  assert.equal(psResumeLine({ ...rec, session: "bad id" }), "");
});

test("the command to run by hand for a session with needs", () => {
  const cmd = psNeedsCommand({ ...rec, flags: [], needs: ["CLAUDE_CONFIG_DIR"] });
  assert.equal(cmd, `Set-Location -LiteralPath 'C:\\Users\\me\\O''Brien æble' -ErrorAction Stop; & 'claude' '--resume' '${ID}'`);
});

test("the profile block sits between Revive's markers", () => {
  const block = psProfileBlock("C:\\Users\\me\\.config\\herdr-app\\mods\\revive-win\\revive.mjs");
  assert.ok(block.startsWith(`${PROFILE_BEGIN}\n`));
  assert.ok(block.endsWith(PROFILE_END));
  assert.match(block, /'C:\\Users\\me\\\.config\\herdr-app\\mods\\revive-win\\revive\.mjs'/);
});

// ── running it ──────────────────────────────────────────────────────────────

const UTF8 = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ";
const cleanEnv = (extra = {}) => {
  const env = { ...process.env };
  for (const k of ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SCOPE", "REVIVE_SHELL", "REVIVE_AUTO", "REVIVE_DEBUG", "REVIVE_HC", "HERDR_PANE_ID", "REVIVE_RESUME"]) delete env[k];
  return { ...env, ...extra };
};
const pwsh = (command, { env = cleanEnv(), flags = [] } = {}) => spawnSync("pwsh", ["-NoLogo", "-NoProfile", ...flags, "-Command", command], { encoding: "utf8", env, timeout: 60_000 });

test("quoted words reach a program unchanged", { skip: WINDOWS_ONLY }, () => {
  const words = ["a b", "it's", "$HOME", "x;y", "’q’", "æøå", ""];
  const r = pwsh(UTF8 + psCommand([process.execPath, "-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...words]));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), words);
});

test("a note prints ↻ even where the console's code page has no such character", { skip: WINDOWS_ONLY }, () => {
  // A Herdr terminal's shell writes with its OEM code page (850 here), which has no ↻.
  const oem = "[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(850); ";
  const r = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-Command", `${oem}& { ${psNote([["accent", "↻ Revive"], [null, " æøå"]])} }; [Console]::OutputEncoding.CodePage`], { env: cleanEnv(), timeout: 60_000 });
  const out = r.stdout.toString("utf8");
  assert.match(out, /↻ Revive/);
  assert.match(out, /æøå/);
  assert.equal(Number(out.trim().split(/\r?\n/).pop()), 850, "the shell's own encoding is put back");
});

/** A folder, a fake `claude.cmd` on PATH that records how it ran, and an engine stub that logs `failed`. */
function resumeWorld() {
  const root = mkdtempSync(join(tmpdir(), "revive-pwsh-"));
  const folder = join(root, "it's æ dir");
  const bin = join(root, "bin");
  mkdirSync(folder);
  mkdirSync(bin);
  writeFileSync(join(root, "fake-claude.cjs"), `require("fs").writeFileSync(${JSON.stringify(join(root, "ran.json"))}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), resume: process.env.REVIVE_RESUME ?? null }));
process.exit(Number(process.env.FAKE_EXIT || 0));
`);
  writeFileSync(join(bin, "claude.cmd"), `@"${process.execPath}" "${join(root, "fake-claude.cjs")}" %*\r\n`);
  const engine = join(root, "engine.mjs");
  writeFileSync(engine, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(join(root, "engine.log"))}, process.argv.slice(2).join(" ") + "\\n");\n`);
  const run = (exit) => pwsh(UTF8 + `& { ${psResumeScript({ ...rec, cwd: folder }, engine)} }; 'AFTER=' + [bool]$env:REVIVE_RESUME`,
    { env: cleanEnv({ PATH: `${bin};${process.env.PATH}`, FAKE_EXIT: String(exit) }) });
  const ran = () => JSON.parse(readFileSync(join(root, "ran.json"), "utf8"));
  const engineLog = () => (existsSync(join(root, "engine.log")) ? readFileSync(join(root, "engine.log"), "utf8") : "");
  return { folder, run, ran, engineLog };
}

test("the resume script runs the agent in its folder, without bypass flags, and marks a quick failure", { skip: WINDOWS_ONLY }, () => {
  const w = resumeWorld();
  const ok = w.run(0);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /resuming .*Claude Code.* session 0c8b28eb/);
  assert.match(ok.stdout, /without --dangerously-skip-permissions/);
  assert.match(ok.stdout, /AFTER=False/);
  assert.deepEqual(w.ran().argv, ["--model", "opus", "--resume", ID]);
  assert.equal(w.ran().cwd, w.folder);
  assert.deepEqual(JSON.parse(w.ran().resume), { agent: "claude", session: ID, flags: rec.flags });
  assert.equal(w.engineLog(), "");
  w.run(1);
  assert.equal(w.engineLog(), "failed\n");
});

/** A fake `hc` and engine stub for the profile block, and a way to run the block in a fresh pwsh. */
function blockWorld({ labels = {}, pidIsCaller = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "revive-block-"));
  writeFileSync(join(root, "state.json"), JSON.stringify({ labels, pidIsCaller }));
  const hc = join(root, "hc.mjs");
  writeFileSync(hc, `import { appendFileSync, readFileSync } from "node:fs";
const dir = ${JSON.stringify(root)};
const args = process.argv.slice(2);
appendFileSync(dir + "/hc.log", JSON.stringify({ args, hcTerminalId: process.env.HC_TERMINAL_ID ?? null }) + "\\n");
const state = JSON.parse(readFileSync(dir + "/state.json", "utf8"));
if (args[0] === "get") process.stdout.write(JSON.stringify({ address: args[1], pid: state.pidIsCaller ? process.ppid : 999, labels: state.labels }));
`);
  const engine = join(root, "engine.mjs");
  writeFileSync(engine, `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(root, "engine.log"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write("Write-Output 'resumed æ'\\n");
`);
  const block = join(root, "block.ps1");
  writeFileSync(block, psProfileBlock(engine));
  const run = ({ env = {}, flags = [], after = "" } = {}) => pwsh(
    UTF8 + `. '${block}'; if (Get-Command __revive -ErrorAction Ignore) { 'DEFINED' }; 'SHELL=' + $env:REVIVE_SHELL; 'PID=' + $PID; 'LEC=' + $LASTEXITCODE; ${after}`,
    { env: cleanEnv({ HC_TERMINAL_ID: "t1", REVIVE_HC: hc, ...env }), flags });
  const lines = (f) => (existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { run, hcCalls: () => lines("hc.log"), engineCalls: () => lines("engine.log") };
}

const remembered = { "revive.agent": "claude", "revive.session": ID };

test("the block does nothing where nothing is remembered", { skip: WINDOWS_ONLY }, () => {
  const w = blockWorld();
  const r = w.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(w.engineCalls().length, 0);
  assert.ok(!w.hcCalls().some((c) => c.args[0] === "send"));
  assert.doesNotMatch(r.stdout, /DEFINED/);
});

test("the block resumes in the terminal's own shell by typing __revive into it", { skip: WINDOWS_ONLY }, () => {
  const w = blockWorld({ labels: remembered });
  const r = w.run({ after: "__revive" });
  assert.equal(r.status, 0, r.stderr);
  const pid = /PID=(\d+)/.exec(r.stdout)[1];
  const [call] = w.engineCalls();
  assert.deepEqual(call.slice(0, 3), ["check", "--shell", pid]);
  assert.equal(call[3], "--since");
  assert.match(call[4], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z$/);
  const send = w.hcCalls().find((c) => c.args[0] === "send");
  assert.deepEqual(send, { args: ["send", "t1", "__revive"], hcTerminalId: null });
  assert.match(r.stdout, /DEFINED/);
  assert.match(r.stdout, /resumed æ/);
  assert.match(r.stdout, new RegExp(`SHELL=${pid}\\b`));
  assert.match(r.stdout, /LEC=0/);
});

test("the block stays out of the way when told to, and in shells that aren't the terminal's", { skip: WINDOWS_ONLY }, () => {
  const cases = [
    ["REVIVE_AUTO=0", { env: { REVIVE_AUTO: "0" } }],
    ["a herdr TUI pane", { env: { HERDR_PANE_ID: "1" } }],
    ["-NonInteractive", { flags: ["-NonInteractive"] }],
    ["a shell started inside the terminal's own", { env: { REVIVE_SHELL: String(process.pid) } }],
  ];
  for (const [why, opts] of cases) {
    const w = blockWorld({ labels: remembered });
    const r = w.run(opts);
    assert.equal(r.status, 0, `${why}: ${r.stderr}`);
    assert.deepEqual(w.hcCalls(), [], why);
    assert.deepEqual(w.engineCalls(), [], why);
  }
  const other = blockWorld({ labels: remembered, pidIsCaller: false });
  other.run();
  assert.equal(other.engineCalls().length, 0, "not the terminal's pid");
});

test("pi resumes and forks by session id, with its flags, in a quoted folder", async () => {
  const { command } = await import("../mods/revive-win/lib/core.js");
  const rec = { agent: "pi", session: ID, cwd: String.raw`C:\it's`, flags: ["--model", "x"] };
  assert.equal(psResumeLine(rec), String.raw`Set-Location -LiteralPath 'C:\it''s' -ErrorAction Stop; & 'pi' '--model' 'x' '--session' '` + ID + "'");
  const script = psResumeScript(rec, "C:\m\revive.mjs");
  assert.match(script, /resuming /);
  assert.match(script, /'pi'/);
  assert.ok(script.includes("& 'pi' '--model' 'x' '--session'"), script);
  assert.deepEqual(command(rec, "fork"), ["pi", "--model", "x", "--fork", ID]);
});
