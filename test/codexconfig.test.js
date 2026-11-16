// lib/codexconfig.js: the line in Codex's config.toml that turns its shared
// background server off. Pure text edits: these run on every platform.
import { test } from "node:test";
import assert from "node:assert/strict";
import { REVIVE_LINE, withDaemonOff, daemonSetting } from "../mods/revive-win/lib/codexconfig.js";

test("Revive's line is exactly the documented one", () => {
  assert.equal(REVIVE_LINE, "daemon_auto_start = false # added by Revive (herdr-revive-win)");
});

test("an empty or missing config gets a [features] table with Revive's line", () => {
  assert.equal(withDaemonOff(""), `[features]\n${REVIVE_LINE}\n`);
  assert.equal(withDaemonOff('model = "o3"\n'), `model = "o3"\n\n[features]\n${REVIVE_LINE}\n`);
  assert.equal(withDaemonOff('model = "o3"'), `model = "o3"\n\n[features]\n${REVIVE_LINE}\n`);
});

test("an existing [features] table gets the line first, in the file's line ending", () => {
  assert.equal(withDaemonOff("[features]\r\nfoo = true\r\n"), `[features]\r\n${REVIVE_LINE}\r\nfoo = true\r\n`);
  assert.equal(withDaemonOff("[tui]\nx = 1\n\n[features] # mine\nfoo = true\n"), `[tui]\nx = 1\n\n[features] # mine\n${REVIVE_LINE}\nfoo = true\n`);
});

test("a BOM is kept", () => {
  assert.ok(withDaemonOff("﻿[features]\r\nfoo = true\r\n").startsWith(`﻿[features]\r\n${REVIVE_LINE}`));
  assert.ok(withDaemonOff("﻿").startsWith("﻿[features]"));
});

test("the person's own setting, in any form, is left alone", () => {
  for (const value of ["true", "false"]) {
    for (const text of [
      `[features]\ndaemon_auto_start = ${value}\n`,
      `[features]\n  daemon_auto_start=${value} # mine\n`,
      `model = "o3"\nfeatures.daemon_auto_start = ${value}\n`,
      `features = { daemon_auto_start = ${value} }\n`,
    ]) {
      assert.equal(withDaemonOff(text), text, text);
      assert.equal(daemonSetting(text), value === "true" ? "on" : "off", text);
    }
  }
});

test("Revive's line counts as off, a missing key as on", () => {
  assert.equal(daemonSetting(withDaemonOff("")), "off");
  assert.equal(daemonSetting(""), "on");
  assert.equal(daemonSetting("[features]\nfoo = true\n"), "on");
});

test("a key in another table is not the setting", () => {
  const text = "[tui]\ndaemon_auto_start = true\n";
  assert.equal(daemonSetting(text), "on");
  assert.equal(withDaemonOff(text), `${text}\n[features]\n${REVIVE_LINE}\n`);
});

const CASES = ["", 'model = "o3"\n', "[features]\r\nfoo = true\r\n", "﻿[tui]\r\nx = 1\r\n", "[tui]\ndaemon_auto_start = true\n"];

test("adding twice changes nothing more", () => {
  for (const x of CASES) assert.equal(withDaemonOff(withDaemonOff(x)), withDaemonOff(x), JSON.stringify(x));
});

test("removing gives back the text from before", () => {
  for (const x of CASES) assert.equal(withDaemonOff(withDaemonOff(x), { remove: true }), x, JSON.stringify(x));
});

test("removing never takes out the person's own line or table", () => {
  const own = "[features]\ndaemon_auto_start = false\n";
  assert.equal(withDaemonOff(own, { remove: true }), own);
  const theirs = `[features]\nfoo = true\n`;
  assert.equal(withDaemonOff(theirs, { remove: true }), theirs);
  const emptyTheirs = "[features]\n\n[tui]\nx = 1\n";
  assert.equal(withDaemonOff(emptyTheirs, { remove: true }), emptyTheirs);
});
