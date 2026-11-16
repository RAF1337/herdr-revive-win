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
