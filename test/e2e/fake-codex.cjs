// The end-to-end test's stand-in for Codex, run by claude-launcher.cs as
// codex.exe. Like Codex on Windows with its background server off, it runs
// Revive's hook itself, through cmd: SessionStart at the first message (or at
// once on `codex resume <id>`), SessionEnd with reason "other" on /exit, and
// nothing when it is cut off. It prints how it was started, then reads lines:
//   any line  the first message (SessionStart, if not sent yet)
//   exit      SessionEnd "other" (as /exit), then quits 0
//   vanish    quits 0 with no SessionEnd (as a crash)
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const args = process.argv.slice(2);
const resumed = args[0] === "resume" ? args[args.length - 1] : null;
const id = resumed ?? crypto.randomUUID();
const cwd = process.cwd();
const state = process.env.FAKE_CLAUDE_STATE;
const engine = process.env.FAKE_CLAUDE_ENGINE.replace(/\\/g, "/");
function hook(payload) {
  const started = Date.now();
  spawnSync(`node "${engine}" hook`, { shell: true, input: JSON.stringify(payload), stdio: ["pipe", "ignore", "ignore"] });
  return Date.now() - started;
}

console.log(`FAKE CODEX ${JSON.stringify(args)}`);
let started = false;
function start() {
  if (started) return;
  started = true;
  const ms = hook({ hook_event_name: "SessionStart", session_id: id, cwd, source: resumed ? "resume" : "startup" });
  fs.appendFileSync(path.join(state, "codex-hook-ms.log"), `${ms}\n`);
  console.log(`FAKE CODEX SESSION ${id} hook=${ms}ms`);
}
if (resumed) start();

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  for (let nl = buffered.indexOf("\n"); nl >= 0; nl = buffered.indexOf("\n")) {
    const line = buffered.slice(0, nl).trim();
    buffered = buffered.slice(nl + 1);
    if (line === "exit") {
      hook({ hook_event_name: "SessionEnd", session_id: id, reason: "other" });
      console.log("FAKE CODEX BYE");
      process.exit(0);
    }
    if (line === "vanish") process.exit(0);
    if (line) start();
  }
});
