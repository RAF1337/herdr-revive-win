// test/run.mjs on Windows: nothing in a test run may reach the person's own
// files or herdr-core, whatever their environment says.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WINDOWS_ONLY } from "./helpers/platform.js";

test("the Windows test run sees only scratch settings", { skip: WINDOWS_ONLY }, () => {
  const home = process.env.USERPROFILE;
  assert.match(home, /revive-test-home-/, "USERPROFILE is scratch");
  assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(process.env.CODEX_HOME, undefined);
  assert.ok(process.env.REVIVE_HC.startsWith(home), "REVIVE_HC points nowhere real");
  assert.ok(process.env.REVIVE_PROFILE.startsWith(home), "REVIVE_PROFILE is scratch");
  for (const k of ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SCOPE", "REVIVE_SHELL", "REVIVE_AUTO", "REVIVE_RESUME"]) assert.equal(process.env[k], undefined, k);
});
