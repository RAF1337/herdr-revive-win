// The end-to-end test's stand-in for Claude Code, run by claude-launcher.cs.
// It writes a transcript and sessions/<pid>.json the way Claude Code does,
// runs Revive's hook through Git Bash the way Claude Code does on Windows,
// prints one line saying how it was started, and then waits:
//   exit    SessionEnd with reason prompt_input_exit (as /exit), then quits 0
//   vanish  quits 0 with no SessionEnd (as a crash that leaves the shell)
// With <state>/fail-resume present, a resume quits 1 at once (a session that
// can't be found).
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const args = process.argv.slice(2);
const at = args.indexOf("--resume");
const resumed = at >= 0 ? args[at + 1] : null;
const state = process.env.FAKE_CLAUDE_STATE;
if (resumed && fs.existsSync(path.join(state, "fail-resume"))) {
  console.log(`FAKE CLAUDE FAILING ${resumed}`);
  process.exit(1);
}

const id = resumed ?? crypto.randomUUID();
const cwd = process.cwd();
const claude = path.join(os.homedir(), ".claude");
const project = path.join(claude, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(path.join(claude, "sessions"), { recursive: true });
const transcript = path.join(project, `${id}.jsonl`);
if (!fs.existsSync(transcript)) fs.writeFileSync(transcript, JSON.stringify({ cwd }) + "\n");
// The launcher (claude.exe) is the process Claude Code's own file is named after.
fs.writeFileSync(path.join(claude, "sessions", `${process.ppid}.json`), JSON.stringify({ pid: process.ppid, sessionId: id, cwd }));

const BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const engine = process.env.FAKE_CLAUDE_ENGINE.replace(/\\/g, "/");
function hook(payload) {
  const started = Date.now();
  spawnSync(BASH, ["-c", `node "${engine}" hook`], { input: JSON.stringify(payload), stdio: ["pipe", "ignore", "ignore"] });
  return Date.now() - started;
}

const ms = hook({ hook_event_name: "SessionStart", session_id: id, cwd, source: resumed ? "resume" : "startup", transcript_path: transcript });
fs.appendFileSync(path.join(state, "hook-ms.log"), `${ms}\n`);
console.log(`FAKE CLAUDE ${id} ${JSON.stringify(args)} hook=${ms}ms`);

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  for (let nl = buffered.indexOf("\n"); nl >= 0; nl = buffered.indexOf("\n")) {
    const line = buffered.slice(0, nl).trim();
    buffered = buffered.slice(nl + 1);
    if (line === "exit") {
      hook({ hook_event_name: "SessionEnd", session_id: id, reason: "prompt_input_exit" });
      console.log("FAKE CLAUDE BYE");
      process.exit(0);
    }
    if (line === "vanish") process.exit(0);
  }
});
