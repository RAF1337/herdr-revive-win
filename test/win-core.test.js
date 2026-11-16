// Windows command lines, shells and paths, as lib/core.js reads them. Pure
// functions: these run on every platform.
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentKey, carriedFlags, isOneShot, isShell, hookPayload, endAction } from "../mods/revive-win/lib/core.js";

const CLAUDE = "C:\\Users\\me\\.local\\bin\\claude.exe";

test("Windows program paths are known by name", () => {
  assert.equal(agentKey(null, [CLAUDE, "--model", "opus"]), "claude");
  assert.equal(agentKey(null, ["C:\\tools\\claude.cmd"]), "claude");
  assert.equal(agentKey(null, ["/usr/local/bin/claude"]), "claude");
  assert.deepEqual(carriedFlags("claude", [CLAUDE, "--model", "opus", "fix it"]), ["--model", "opus"]);
  assert.equal(isOneShot("claude", [CLAUDE, "-p", "x"]), true);
});

test("Windows shells are shells", () => {
  for (const argv of [["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-NoExit"], ["powershell.exe"], ["C:\\Windows\\System32\\cmd.exe"], ["/bin/zsh"]]) {
    assert.equal(isShell(argv), true, argv[0]);
  }
  assert.equal(isShell(["C:\\Program Files\\nodejs\\node.exe"]), false);
});

test("a Windows transcript path names Claude Code, and the payload keeps its source", () => {
  const p = hookPayload({ hook_event_name: "SessionStart", session_id: "x", transcript_path: "C:\\Users\\me\\.claude\\projects\\C--w\\x.jsonl", source: "resume" });
  assert.equal(p.agent, "claude");
  assert.equal(p.source, "resume");
  assert.equal(hookPayload({}).source, null);
});

test("npm's vendored codex.exe is Codex, with its flags", () => {
  const exe = String.raw`C:\Users\me\AppData\Roaming\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`;
  assert.equal(agentKey(null, [exe, "--yolo", "-m", "gpt-5"]), "codex");
  assert.deepEqual(carriedFlags("codex", [exe, "--yolo", "-m", "gpt-5"]), ["--yolo", "-m", "gpt-5"]);
  assert.equal(isOneShot("codex", [exe, "exec", "hi"]), true);
  assert.equal(isOneShot("codex", [exe, "--yolo"]), false);
});

// Codex on Windows sends SessionEnd only when the person ends the session
// (`/exit` says "other"); a closed pane or a killed Codex sends nothing.
test("on Windows Codex's \"other\" means the person ended it", { skip: process.platform !== "win32" && "Windows only" }, () => {
  assert.equal(endAction("codex", "other"), "forget");
  assert.equal(endAction("codex", "clear"), "ignore");
  assert.equal(endAction("codex", "resume"), "ignore");
  assert.equal(endAction("claude", "other"), "keep");
});
