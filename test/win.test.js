// lib/win.js: Windows command lines, start times, the process table and the
// program that really runs in a terminal. The pure parts run everywhere; the
// real process table only on Windows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitCommandLine, toSince, parseWinProcesses, winProcesses, effectiveForeground } from "../mods/revive-win/lib/win.js";
import { WINDOWS_ONLY } from "./helpers/platform.js";

test("command lines split by the Windows rules", () => {
  assert.deepEqual(splitCommandLine("C:\\Users\\me\\.local\\bin\\claude.exe --model opus"), ["C:\\Users\\me\\.local\\bin\\claude.exe", "--model", "opus"]);
  assert.deepEqual(splitCommandLine('"C:\\Program Files\\nodejs\\node.exe" "C:\\a b\\x.js" hook'), ["C:\\Program Files\\nodejs\\node.exe", "C:\\a b\\x.js", "hook"]);
  assert.deepEqual(splitCommandLine('x "abc" d e'), ["x", "abc", "d", "e"]);
  assert.deepEqual(splitCommandLine('x a\\\\\\b d"e f"g h'), ["x", "a\\\\\\b", "de fg", "h"]);
  assert.deepEqual(splitCommandLine('x a\\\\\\"b c d'), ["x", 'a\\"b', "c", "d"]);
  assert.deepEqual(splitCommandLine('x a\\\\\\\\"b c" d e'), ["x", "a\\\\b c", "d", "e"]);
  assert.deepEqual(splitCommandLine('x a"b"" c d'), ["x", 'ab" c d']);
  assert.deepEqual(splitCommandLine(null), []);
});

test("start times are UTC to the millisecond", () => {
  assert.equal(toSince("2026-11-16T07:16:49.0576270Z"), "2026-11-16T07:16:49.057Z");
  assert.equal(toSince("2026-11-16T07:16:49.057Z"), "2026-11-16T07:16:49.057Z");
  assert.equal(toSince("Sat Oct 31 18:49:55 2026"), null);
  assert.equal(toSince(null), null);
});

test("a parent that started after its child is not its parent", () => {
  const t = parseWinProcesses(JSON.stringify([
    { pid: 10, ppid: 5, name: "pwsh.exe", start: "2026-11-16T08:00:00.0000000Z", cmd: "pwsh.exe -NoExit" },
    { pid: 5, ppid: 1, name: "chrome.exe", start: "2026-11-16T09:00:00.0000000Z", cmd: "chrome.exe" },
  ]));
  assert.equal(t.get(10).ppid, 0);
  assert.equal(t.get(10).since, "2026-11-16T08:00:00.000Z");
  assert.deepEqual(t.get(10).argv, ["pwsh.exe", "-NoExit"]);
});

const proc = (ppid, cmd, start = "2026-11-16T08:00:00.000Z") => ({ ppid, argv: splitCommandLine(cmd), name: splitCommandLine(cmd)[0].split("\\").pop(), since: start });

test("the effective foreground on Windows", () => {
  const t = { pid: 100, cwd: "C:\\w", foreground: { pid: 100, argv: ["pwsh.exe"], cwd: "C:\\w" } };
  const idle = new Map([[100, proc(50, "pwsh.exe -NoExit")], [220, proc(100, "C:\\Windows\\System32\\conhost.exe")]]);
  assert.equal(effectiveForeground(t, idle).pid, 100);
  const claude = new Map([...idle, [200, proc(100, "C:\\bin\\claude.exe --model opus")], [300, proc(200, "bash.exe -c x")], [400, proc(300, "C:\\bin\\claude.exe -p hi")]]);
  assert.deepEqual(effectiveForeground(t, claude), { pid: 200, argv: ["C:\\bin\\claude.exe", "--model", "opus"], cwd: "C:\\w" });
  const busy = new Map([...idle, [210, proc(100, "node.exe test.js")]]);
  assert.equal(effectiveForeground(t, busy).pid, 210);
  assert.deepEqual(effectiveForeground(t, new Map()), t.foreground);
});

test("a terminal whose own program is the agent (a forked pane) has the agent in front", () => {
  const t = { pid: 100, cwd: "C:\\w", foreground: { pid: 100, argv: ["claude"], cwd: "C:\\w" } };
  const table = new Map([
    [100, proc(50, "C:\\bin\\claude.exe --model opus --resume x --fork-session")],
    [300, proc(100, "bash.exe -c hook", "2026-11-16T08:00:01.000Z")],
    [310, proc(100, "node.exe mcp-server.js", "2026-11-16T08:00:02.000Z")],
  ]);
  assert.deepEqual(effectiveForeground(t, table), { pid: 100, argv: ["C:\\bin\\claude.exe", "--model", "opus", "--resume", "x", "--fork-session"], cwd: "C:\\w" });
});

test("the real process table lists this process", { skip: WINDOWS_ONLY }, async () => {
  const table = await winProcesses();
  const me = table.get(process.pid);
  assert.match(me.argv[0], /node(\.exe)?"?$/i);
  assert.match(me.since, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});

// Claude Code installed with npm: the package's bin is the native claude.exe,
// started by npm's claude.cmd (through cmd.exe) or claude.ps1 (directly), or,
// when install scripts were skipped, by `node cli-wrapper.cjs`.
const NPM_EXE = String.raw`C:\Users\me\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`;
test("Claude Code started through npm's claude.cmd is in front, with its flags", () => {
  const t = { pid: 100, cwd: String.raw`C:\w`, foreground: { pid: 100, argv: ["pwsh.exe"], cwd: String.raw`C:\w` } };
  const table = new Map([
    [100, proc(50, "pwsh.exe -NoExit")],
    [110, proc(100, String.raw`C:\Windows\system32\cmd.exe /d /s /c "C:\Users\me\AppData\Roaming\npm\claude.cmd --model opus"`)],
    [120, proc(110, `"${NPM_EXE}" --model opus`)],
  ]);
  assert.deepEqual(effectiveForeground(t, table), { pid: 120, argv: [NPM_EXE, "--model", "opus"], cwd: String.raw`C:\w` });
});

test("Claude Code started by npm's node fallback wrapper is in front", () => {
  const t = { pid: 100, cwd: String.raw`C:\w`, foreground: { pid: 100, argv: ["pwsh.exe"], cwd: String.raw`C:\w` } };
  const table = new Map([
    [100, proc(50, "pwsh.exe -NoExit")],
    [110, proc(100, String.raw`"C:\Program Files\nodejs\node.exe" "C:\Users\me\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli-wrapper.cjs" --model opus`)],
    [120, proc(110, String.raw`C:\Users\me\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code-win32-x64\claude.exe --model opus`)],
  ]);
  assert.equal(effectiveForeground(t, table).pid, 120);
});

// Codex installed with npm: npm's codex.ps1 starts `node …\codex\bin\codex.js`,
// which starts the vendored codex.exe; that one may start Codex's shared
// background server and its sandbox helper, which are never the session.
const CODEX_JS = String.raw`C:\Users\me\AppData\Roaming\npm/node_modules/@openai/codex/bin/codex.js`;
const CODEX_EXE = String.raw`C:\Users\me\AppData\Roaming\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`;
const CODEX_DAEMON = String.raw`\?\C:\Users\me\.codex\packages\app-server-daemon\releases\0.169.0-x86_64-pc-windows-msvc\bin\codex.exe`;
test("Codex started through npm is in front, not its background server", () => {
  const t = { pid: 10, cwd: String.raw`C:\w`, foreground: { pid: 10, argv: ["pwsh.exe"], cwd: String.raw`C:\w` } };
  const table = new Map([
    [10, proc(5, "pwsh.exe -NoExit")],
    [11, proc(10, `"C:\Program Files\nodejs\node.exe" ${CODEX_JS} --yolo`)],
    [12, proc(11, `${CODEX_EXE} --yolo`)],
    [13, proc(12, `"${CODEX_DAEMON}" app-server --listen unix:// --managed-daemon`, "2026-11-16T08:00:05.000Z")],
    [14, proc(12, String.raw`"C:\Users\me\.codex\packages\app-server-daemon\releases\0.169.0-x86_64-pc-windows-msvc\codex-resources\codex-windows-sandbox-setup.exe" eyJ2ZXJzaW9uIjo1fQ==`, "2026-11-16T08:00:06.000Z")],
  ]);
  assert.deepEqual(effectiveForeground(t, table), { pid: 12, argv: [CODEX_EXE, "--yolo"], cwd: String.raw`C:\w` });
});

test("pi started through npm is in front", () => {
  const PI_JS = String.raw`C:\Users\me\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js`;
  const t = { pid: 10, cwd: String.raw`C:\w`, foreground: { pid: 10, argv: ["pwsh.exe"], cwd: String.raw`C:\w` } };
  const table = new Map([
    [10, proc(5, "pwsh.exe -NoExit")],
    [11, proc(10, `"C:\Windows\system32\cmd.exe" /d /s /c "pi.cmd --model x"`)],
    [12, proc(11, `"C:\Program Files\nodejs\node.exe" ${PI_JS} --model x`)],
  ]);
  assert.equal(effectiveForeground(t, table).pid, 12);
});
