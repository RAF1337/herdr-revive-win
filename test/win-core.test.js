// Windows command lines, shells and paths, as lib/core.js reads them. Pure
// functions: these run on every platform.
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentKey, carriedFlags, isOneShot, isShell, hookPayload } from "../mods/revive-win/lib/core.js";

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
