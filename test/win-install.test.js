// install, uninstall and doctor on Windows, in a scratch home: Claude Code's
// hooks next to the person's own, the PowerShell profile block, and nothing
// for the agents Revive doesn't support on Windows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { withShellBlock, winHookCommand, shellBlock, hasCli } from "../mods/revive-win/revive.mjs";
import { PROFILE_BEGIN, PROFILE_END } from "../mods/revive-win/lib/pwsh.js";
import { WINDOWS_ONLY } from "./helpers/platform.js";

const ENGINE = resolve("mods/revive-win/revive.mjs");
const BLOCK = `${PROFILE_BEGIN}\nX\n${PROFILE_END}`;

test("a block goes into a CRLF file with CRLF, and comes out leaving the file as it was", () => {
  const original = "a\r\nb\r\n";
  const added = withShellBlock(original, { block: BLOCK });
  assert.equal(added, `a\r\nb\r\n\r\n${PROFILE_BEGIN}\r\nX\r\n${PROFILE_END}\r\n`);
  assert.equal(withShellBlock(added, { block: BLOCK }), added, "installing again changes nothing");
  assert.equal(withShellBlock(added, { remove: true, block: BLOCK }), original);
});

test("a POSIX rc file with a stray CRLF line still gets the bash/zsh block with LF", () => {
  const out = withShellBlock("a\r\nb\n");
  assert.equal(out, `a\r\nb\n\n${shellBlock()}\n`);
  assert.ok(!out.slice(out.indexOf(PROFILE_BEGIN)).includes("\r"));
});

test("the hook command names the engine by its absolute path, with forward slashes", () => {
  assert.equal(winHookCommand("C:\\Users\\me\\.config\\herdr-app\\mods\\revive-win\\revive.mjs"), 'node "C:/Users/me/.config/herdr-app/mods/revive-win/revive.mjs" hook');
});

// ── a scratch home ──────────────────────────────────────────────────────────

const PERSON = {
  hooks: {
    Notification: [{ hooks: [{ type: "command", command: 'powershell.exe -ExecutionPolicy Bypass -File "C:/Users/me/.claude/hooks/notify.ps1"' }] }],
    SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: 'powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\me\\.claude\\hooks\\state.ps1" session', timeout: 10 }] }],
  },
};

function home({ settings = PERSON, profile = null, config = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "revive-wininst-"));
  const h = join(root, "home");
  mkdirSync(join(h, ".claude"), { recursive: true });
  for (const d of [".codex", ".factory", ".cursor", join(".pi", "agent"), join(".omp", "agent")]) mkdirSync(join(h, d), { recursive: true });
  const settingsFile = join(h, ".claude", "settings.json");
  const settingsText = JSON.stringify(settings, null, 2) + "\n";
  writeFileSync(settingsFile, settingsText);
  const profileFile = join(h, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
  if (profile !== null) { mkdirSync(join(h, "Documents", "PowerShell"), { recursive: true }); writeFileSync(profileFile, profile); }
  const appdata = join(h, "AppData", "Roaming");
  mkdirSync(join(appdata, "herdr-core"), { recursive: true });
  if (config !== null) writeFileSync(join(appdata, "herdr-core", "config.toml"), config);
  const hc = join(root, "hc.mjs");
  writeFileSync(hc, [
    'const [a, b] = process.argv.slice(2);',
    'if (a === "ls") console.log(JSON.stringify({ terminals: [] }));',
    'if (a === "--version") console.log("hc 0.1.21");',
    'if (a === "server" && b === "status") { if (!process.env.FAKE_CORE_UP) process.exit(1); console.log(JSON.stringify({ pid: 4242 })); }',
  ].join("\n") + "\n");
  const engineWith = (extra, ...args) => {
    const env = { ...process.env, USERPROFILE: h, HOME: h, APPDATA: appdata, REVIVE_PROFILE: profileFile, REVIVE_HC: hc };
    for (const k of ["CLAUDE_CONFIG_DIR", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SCOPE", "CODEX_HOME", "PI_CODING_AGENT_DIR"]) delete env[k];
    return spawnSync(process.execPath, [ENGINE, ...args], { encoding: "utf8", env: { ...env, ...extra }, timeout: 60_000 });
  };
  const engine = (...args) => engineWith({}, ...args);
  return { root, h, settingsFile, settingsText, profileFile, engine, engineWith, read: (f) => readFileSync(f, "utf8") };
}

test("install adds Revive's hooks after the person's own, and backs the file up once", { skip: WINDOWS_ONLY }, () => {
  const w = home();
  const r = w.engine("install");
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(w.read(w.settingsFile));
  const ours = { hooks: [{ type: "command", command: winHookCommand(ENGINE), timeout: 10 }] };
  assert.match(ours.hooks[0].command, /^node "C:\/.*\/mods\/revive-win\/revive\.mjs" hook$/);
  assert.deepEqual(s.hooks.Notification, PERSON.hooks.Notification);
  assert.deepEqual(s.hooks.SessionStart, [...PERSON.hooks.SessionStart, ours]);
  assert.deepEqual(s.hooks.SessionEnd, [ours]);
  assert.equal(w.read(`${w.settingsFile}.revive-backup`), w.settingsText);
  assert.ok(w.read(w.profileFile).includes(PROFILE_BEGIN));
  assert.ok(w.engine("install").stdout.startsWith("Nothing to change."));
});

test("install wires nothing for the agents Revive doesn't support on Windows", { skip: WINDOWS_ONLY }, () => {
  const w = home();
  w.engine("install");
  for (const f of [join(".factory", "settings.json"), join(".factory", "hooks.json"), join(".cursor", "hooks.json"), join(".pi", "agent", "extensions"), join(".omp", "agent", "extensions")]) {
    assert.equal(existsSync(join(w.h, f)), false, f);
  }
});

test("uninstall gives back the person's profile byte for byte, and their hooks", { skip: WINDOWS_ONLY }, () => {
  const original = "\uFEFF# mine\r\nSet-Alias g git\r\n";
  const w = home({ profile: original });
  w.engine("install");
  const installed = w.read(w.profileFile);
  assert.ok(installed.startsWith(original), "the person's lines stay first, untouched");
  assert.ok(installed.includes(`\r\n${PROFILE_BEGIN}\r\n`), "the block uses the file's CRLF");
  const r = w.engine("uninstall");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(w.read(w.profileFile), original);
  assert.deepEqual(JSON.parse(w.read(w.settingsFile)), PERSON);
});

test("a UTF-16 profile (Windows PowerShell's `>`) is left alone, with a warning", { skip: WINDOWS_ONLY }, () => {
  const w = home({ profile: "" });
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("# mine\r\n", "utf16le")]);
  writeFileSync(w.profileFile, utf16);
  const r = w.engine("install");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(readFileSync(w.profileFile).equals(utf16), "the profile's bytes are unchanged");
  assert.match(r.stdout + r.stderr, /UTF-16/);
});

test("a profile Revive created is removed again by uninstall", { skip: WINDOWS_ONLY }, () => {
  const w = home();
  w.engine("install");
  assert.ok(existsSync(w.profileFile));
  w.engine("uninstall");
  assert.equal(existsSync(w.profileFile), false);
});

test("doctor reports Claude Code, the pwsh block and herdr-core's settings", { skip: WINDOWS_ONLY }, () => {
  const w = home();
  w.engine("install");
  const d = JSON.parse(w.engine("doctor").stdout);
  assert.equal(d.claude, true);
  assert.deepEqual(d.shell, { pwsh: true });
  assert.equal(d.platform, "win32");
  assert.equal(d.restoreScreen, false);
  assert.equal(d.coreShell, null);
  assert.equal(d.codex, true);
  assert.equal(d.codexDaemon, "off");
  for (const k of ["droid", "cursor", "pi", "omp"]) assert.equal(d[k], null, k);
  assert.equal(JSON.parse(home({ config: "restore_screen = true\n" }).engine("doctor").stdout).restoreScreen, true);
  const nu = home({ config: 'shell = ["nu"]\n' });
  assert.equal(JSON.parse(nu.engine("doctor").stdout).coreShell, "nu");
  const out = nu.engine("install");
  assert.match(out.stdout + out.stderr, /\bnu\b/);
});

test("doctor says when pwsh, hc or herdr-core is missing, without hanging", { skip: WINDOWS_ONLY }, () => {
  const w = home();
  const bare = { PATH: `${dirname(process.execPath)};C:\\Windows\\System32`, REVIVE_HC: join(w.root, "no-hc.exe") };
  const started = Date.now();
  const r = w.engineWith(bare, "doctor");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - started < 15_000, "doctor answers within 15 s");
  const d = JSON.parse(r.stdout);
  assert.equal(d.pwshInstalled, false);
  assert.equal(d.hc, false);
  assert.equal(d.core, false);
  const i = w.engineWith(bare, "install");
  assert.match(i.stdout + i.stderr, /PowerShell 7 \(pwsh\) is required: https:\/\/aka\.ms\/powershell/);
});

test("doctor says pwsh, hc and herdr-core are there when they are", { skip: WINDOWS_ONLY }, () => {
  const w = home();
  const d = JSON.parse(w.engineWith({ FAKE_CORE_UP: "1" }, "doctor").stdout);
  assert.equal(d.pwshInstalled, true);
  assert.equal(d.hc, true);
  assert.equal(d.core, true);
  assert.equal(JSON.parse(w.engine("doctor").stdout).core, false, "a core that doesn't answer");
});

test("a settings.json saved with a BOM and CRLF gets the hooks, and keeps its BOM", { skip: WINDOWS_ONLY }, () => {
  const w = home();
  writeFileSync(w.settingsFile, "\uFEFF" + JSON.stringify(PERSON, null, 2).replace(/\n/g, "\r\n") + "\r\n");
  const r = w.engine("install");
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /not valid JSON/);
  let text = w.read(w.settingsFile);
  assert.ok(text.startsWith("\uFEFF"), "BOM kept on install");
  assert.ok(text.includes("revive.mjs"), "hooks added");
  assert.equal(w.engine("uninstall").status, 0);
  text = w.read(w.settingsFile);
  assert.ok(text.startsWith("\uFEFF"), "BOM kept on uninstall");
  assert.ok(!text.includes("revive.mjs"), "hooks removed");
});

test("hasCli finds a .cmd in a folder on a semicolon-separated PATH", { skip: WINDOWS_ONLY }, () => {
  const dir = mkdtempSync(join(tmpdir(), "revive-path-"));
  writeFileSync(join(dir, "fakecli.cmd"), "@echo off\r\n");
  const saved = process.env.PATH;
  try {
    process.env.PATH = `C:\\Windows\\System32;${dir}`;
    assert.equal(hasCli("fakecli"), true);
    assert.equal(hasCli("nothere"), false);
  } finally { process.env.PATH = saved; }
});

// ── Codex ───────────────────────────────────────────────────────────────────

const NOTICE = "Codex: turned off its shared background server (daemon_auto_start = false in ~/.codex/config.toml) so Revive can see which pane a session runs in. Uninstall turns it back.";
const LINE = "daemon_auto_start = false # added by Revive (herdr-revive-win)";

test("install sets up Codex: its hooks, and the line that turns its background server off", { skip: WINDOWS_ONLY }, () => {
  const w = home();
  const config = join(w.h, ".codex", "config.toml");
  writeFileSync(config, '[tui]\r\nscreen_reader_detection_done = true\r\n');
  const r = w.engine("install");
  assert.equal(r.status, 0, r.stderr);
  const hooks = JSON.parse(w.read(join(w.h, ".codex", "hooks.json"))).hooks;
  const command = winHookCommand(ENGINE);
  assert.deepEqual(hooks.SessionStart, [{ matcher: "", hooks: [{ type: "command", command, timeout: 10 }] }]);
  assert.deepEqual(hooks.SessionEnd, [{ matcher: "", hooks: [{ type: "command", command, timeout: 3 }] }]);
  assert.equal(w.read(config), `[tui]\r\nscreen_reader_detection_done = true\r\n\r\n[features]\r\n${LINE}\r\n`);
  assert.equal(w.read(`${config}.revive-backup`), '[tui]\r\nscreen_reader_detection_done = true\r\n');
  assert.ok(r.stdout.includes(NOTICE), r.stdout);
  const again = w.engine("install");
  assert.ok(!again.stdout.includes(".codex"), again.stdout);
  assert.ok(!again.stdout.includes(NOTICE));
});

test("install --no-codex leaves Codex alone", { skip: WINDOWS_ONLY }, () => {
  const w = home();
  w.engine("install", "--no-codex");
  assert.equal(existsSync(join(w.h, ".codex", "hooks.json")), false);
  assert.equal(existsSync(join(w.h, ".codex", "config.toml")), false);
});

test("the person's own daemon_auto_start = true is left, with a warning", { skip: WINDOWS_ONLY }, () => {
  const w = home();
  const config = join(w.h, ".codex", "config.toml");
  writeFileSync(config, "[features]\ndaemon_auto_start = true\n");
  const r = w.engine("install");
  assert.equal(w.read(config), "[features]\ndaemon_auto_start = true\n");
  assert.ok(r.stderr.includes(`Codex's daemon_auto_start is true in ${config}: Codex sessions won't be remembered.`), r.stderr);
  assert.equal(JSON.parse(w.engine("doctor").stdout).codexDaemon, "on");
});

test("CODEX_HOME is where Codex's files are", { skip: WINDOWS_ONLY }, () => {
  const w = home();
  const other = join(w.root, "codex-home");
  mkdirSync(other);
  w.engineWith({ CODEX_HOME: other }, "install");
  assert.ok(existsSync(join(other, "hooks.json")));
  assert.ok(w.read(join(other, "config.toml")).includes(LINE));
  assert.equal(existsSync(join(w.h, ".codex", "hooks.json")), false);
  assert.equal(existsSync(join(w.h, ".codex", "config.toml")), false);
});

test("uninstall takes Revive's line and hooks out of Codex again", { skip: WINDOWS_ONLY }, () => {
  const w = home();
  const config = join(w.h, ".codex", "config.toml");
  writeFileSync(config, 'model = "o3"\n');
  w.engine("install");
  w.engine("uninstall");
  assert.equal(w.read(config), 'model = "o3"\n');
  assert.equal(JSON.parse(w.read(join(w.h, ".codex", "hooks.json"))).hooks, undefined);
  // Also when Revive's hooks file is gone already.
  w.engine("install");
  rmSync(join(w.h, ".codex", "hooks.json"));
  w.engine("uninstall");
  assert.equal(w.read(config), 'model = "o3"\n');
});

test("no Codex folder: nothing for Codex, and doctor says null", { skip: WINDOWS_ONLY }, () => {
  const w = home();
  rmSync(join(w.h, ".codex"), { recursive: true });
  w.engine("install");
  assert.equal(existsSync(join(w.h, ".codex")), false);
  const d = JSON.parse(w.engine("doctor").stdout);
  assert.equal(d.codex, null);
  assert.equal(d.codexDaemon, null);
});
