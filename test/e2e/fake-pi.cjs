// The end-to-end test's stand-in for pi. windows-e2e.mjs copies it to
// …\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js and runs
// it through a pi.cmd, the way npm installs pi, so the process list shows
// `node …\pi-coding-agent\…\cli.js` as it does for the real pi. It talks to
// Revive through the mod's own lib/extension.js, as pi/revive.ts does: a
// SessionStart at once (pi records a session file when it starts), and on
// `quit` a SessionEnd with "prompt_input_exit". It prints how it was started,
// then reads lines:
//   quit    SessionEnd "prompt_input_exit" (as /quit), then quits 0
//   vanish  quits 0 with no SessionEnd (as a crash)
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");

const args = process.argv.slice(2);
const at = args.indexOf("--session");
const resumed = at >= 0 ? args[at + 1] : null;
const id = resumed ?? crypto.randomUUID();
const cwd = process.cwd();
const sessions = path.join(process.env.USERPROFILE, ".pi", "agent", "sessions", "--e2e--");
fs.mkdirSync(sessions, { recursive: true });
const file = path.join(sessions, `${id}.jsonl`);
fs.appendFileSync(file, "");
const ctx = { cwd, sessionManager: { getSessionFile: () => file, getSessionId: () => id } };
const helper = pathToFileURL(path.join(path.dirname(process.env.FAKE_CLAUDE_ENGINE), "lib", "extension.js")).href;

console.log(`FAKE PI ${JSON.stringify(args)}`);
import(helper).then(async ({ revive }) => {
  const engine = revive({ agent: "pi" });
  await engine.send(ctx, { hook_event_name: "SessionStart", source: resumed ? "resume" : "startup" });
  console.log(`FAKE PI SESSION ${id}`);
  let buffered = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    buffered += chunk;
    for (let nl = buffered.indexOf("\n"); nl >= 0; nl = buffered.indexOf("\n")) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (line === "quit") {
        await engine.send(ctx, { hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
        console.log("FAKE PI BYE");
        process.exit(0);
      }
      if (line === "vanish") process.exit(0);
    }
  });
});
