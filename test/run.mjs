// Runs the test suite. On Windows, Node's homedir() follows USERPROFILE, not
// HOME, so a test that points HOME at a scratch folder would still install
// into the person's real home. Every Windows run therefore gets a scratch
// USERPROFILE, HOME and APPDATA, and no link to the herdr terminal it was
// started from. Elsewhere the suite runs exactly as before.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync("test").filter((f) => f.endsWith(".test.js")).sort().map((f) => join("test", f));

const env = { ...process.env };
let scratch = null;
if (process.platform === "win32") {
  scratch = mkdtempSync(join(tmpdir(), "revive-test-home-"));
  Object.assign(env, { USERPROFILE: scratch, HOME: scratch, APPDATA: join(scratch, "AppData", "Roaming") });
  // Nothing of the person's own: their herdr terminal, their agents' config
  // folders, their Revive settings.
  for (const name of Object.keys(env)) {
    if (/^(HC_TERMINAL_ID|HC_TERMINAL_SOCKET|HC_SCOPE|CLAUDE_CONFIG_DIR|CODEX_HOME|PI_CODING_AGENT_DIR|PI_CODING_AGENT_SESSION_DIR|ZDOTDIR|REVIVE_.*)$/.test(name)) delete env[name];
  }
  // No test may reach the person's herdr-core: a test that wants one brings
  // its own fake through REVIVE_HC.
  env.REVIVE_HC = join(scratch, "no-hc-in-tests");
  // pwsh finds $PROFILE through the Documents folder, not USERPROFILE.
  env.REVIVE_PROFILE = join(scratch, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
  env.HC_SESSION = "revive-test-unreachable";
}

const r = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit", env });
if (scratch) rmSync(scratch, { recursive: true, force: true });
process.exit(r.status ?? 1);
