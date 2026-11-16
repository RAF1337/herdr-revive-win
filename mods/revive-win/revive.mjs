#!/usr/bin/env node
// Revive's engine. The mod can't run for a terminal while the app is closed or
// the machine is rebooting, so the work happens where the session lives:
//
//   revive.mjs hook [--agent K]   an agent's SessionStart and SessionEnd (Claude Code, Codex,
//                                 Droid, Cursor, pi's through pi/revive.ts and omp's through
//                                 omp/revive.ts): remember the
//                                 session on its terminal, or forget it
//   revive.mjs check --shell PID  from the shell's rc file: print the commands that
//                                 resume a session lost to a restart, or nothing
//   revive.mjs failed             the resume printed by `check` gave up at once
//   revive.mjs list [--focus T]   every remembered session, as JSON, for the dialog
//   revive.mjs resume T           resume T's session in T's shell
//   revive.mjs auto T on|off      allow or stop automatic resume for T
//   revive.mjs adopt [T] [--dry-run]
//                                 remember the running Claude Code sessions
//                                 nobody recorded (started before Revive was
//                                 installed), or only T's; --dry-run says what
//                                 it would write
//   revive.mjs install [--zsh] [--bash] [--no-shell] [--no-codex] [--no-pi] [--no-omp] [--no-droid] [--no-cursor]
//   revive.mjs uninstall
//   revive.mjs doctor             what is installed, as JSON
//
// Hooks never fail an agent: every error is swallowed and the exit code is 0.

import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, copyFileSync, mkdirSync, renameSync, realpathSync, rmSync, statSync, lstatSync, symlinkSync, chmodSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  AGENTS, agentKey, carriedFlags, safeFlags, hookOwner, hookPayload, endAction, isOneShot, readRecord, labelArgs, clearArgs, resumedArgs,
  stateOf, shouldResume, ownShell, promptShell, idleWrappedShell, resumeScript, resumeLine, shQuote, shJoin, validId, needsOf, shortId, needsHint, unresumable,
  printfLine,
} from "./lib/core.js";
import { agentDirs, claudeStartFolder, findSession } from "./lib/sessions.js";
import { winProcesses, effectiveForeground, folderOwners, toSince } from "./lib/win.js";
import { psResumeScript, psResumeLine, psNote, psNeedsCommand, psProfileBlock } from "./lib/pwsh.js";
import { withDaemonOff, daemonSetting } from "./lib/codexconfig.js";

const run = promisify(execFile);
export const ENGINE = fileURLToPath(import.meta.url);
const HC = process.env.REVIVE_HC || "hc";
/** Windows: no `ps`, no foreground process group, PowerShell instead of a POSIX shell (lib/win.js, lib/pwsh.js). */
const WIN = process.platform === "win32";

/**
 * How `hc` is started: REVIVE_HC may name a JavaScript file (a test's fake
 * `hc`, which Windows can't run by its shebang), run with this Node.
 */
export const hcInvocation = (args) => (/\.[cm]?js$/.test(HC) ? [process.execPath, [HC, ...args]] : [HC, args]);

// ── herdr-core ──────────────────────────────────────────────────────────────

/**
 * The environment `hc` runs in, without the agent's own variables. An `hc`
 * that finds no core starts one, which keeps the environment it was started
 * in and hands it to every terminal: CLAUDE_CODE_CHILD_SESSION there makes
 * each Claude Code after it think it is nested, and it stops saving transcripts.
 */
export const hcEnv = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("CLAUDE_CODE_") && k !== "CLAUDECODE"));

async function hc(args, env = process.env) {
  const [file, argv] = hcInvocation(args);
  const { stdout } = await run(file, argv, { env: hcEnv(env), maxBuffer: 8 * 1024 * 1024, timeout: 10_000 });
  return stdout;
}

/**
 * Whether herdr-core answers on the terminal's socket. An `hc` older than
 * HC_TERMINAL_SOCKET says nothing: it is taken as up, as before.
 */
function coreUp(socket = process.env.HC_TERMINAL_SOCKET) {
  if (!socket) return Promise.resolve(true);
  return new Promise((resolve) => {
    const c = createConnection(socket);
    const done = (ok) => { c.destroy(); resolve(ok); };
    c.setTimeout(1000, () => done(false));
    c.once("connect", () => done(true));
    c.once("error", () => done(false));
  });
}

const getTerminal = async (t) => JSON.parse(await hc(["get", t, "--json"]));
const label = (t, args) => (args.length ? hc(["label", t, ...args]) : null);

async function listTerminals() {
  const { terminals = [] } = JSON.parse(await hc(["ls", "--json"]));
  const all = await Promise.all(terminals.map((x) => getTerminal(x.address).catch(() => null)));
  return all.filter((t) => t && t.state === "live");
}

/**
 * The agent in the terminal's foreground, or null. By its command line, or,
 * for an agent behind a wrapper with another name (`node …/cli.mjs`), by its
 * own report, which only counts while something other than the terminal's
 * shell is in the foreground: a report outlives the agent that sent it. A
 * shell at its own prompt ignores the report; one running a script keeps it.
 */
function liveAgent(t) {
  const fg = t.foreground;
  if (!fg?.argv) return null;
  return agentKey(null, fg.argv) ?? (fg.pid && fg.pid !== t.pid && !promptShell(fg.argv) ? agentKey(t.status?.app) : null);
}

// ── hooks ───────────────────────────────────────────────────────────────────

async function readStdin() {
  if (process.stdin.isTTY) return {};
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  try { return JSON.parse(text || "{}"); } catch { return {}; }
}

/**
 * Every process: pid → { ppid, since, argv }. `since` is its start time as ps
 * prints it (`lstart`, always five words), which tells a new process from an
 * old one that had the same pid before a reboot. argv is split on spaces,
 * which is enough to recognize an agent by its first two words.
 */
export function parseProcesses(text) {
  const table = new Map();
  for (const line of text.split("\n")) {
    const words = line.trim().split(/\s+/);
    if (words.length < 7) continue;
    const pid = Number(words[0]);
    if (!pid) continue;
    table.set(pid, { ppid: Number(words[1]), since: words.slice(2, 7).join(" "), argv: words.slice(7) });
  }
  return table;
}

// One -o per column: procps-ng 3.3 (Amazon Linux 2) reads "pid=,ppid=,..." as a
// single pid column titled ",ppid=,...", which leaves ppid and argv empty.
async function processes(pids = null) {
  // Windows: the whole table from CIM, `since` as UTC to the millisecond.
  if (WIN) return winProcesses();
  const args = pids ? ["-o", "pid=", "-o", "ppid=", "-o", "lstart=", "-o", "args=", "-p", pids.join(",")] : ["-A", "-o", "pid=", "-o", "ppid=", "-o", "lstart=", "-o", "args="];
  try {
    const { stdout } = await run("ps", args, { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
    return parseProcesses(stdout);
  } catch (err) {
    // ps exits 1 when none of the asked pids exist.
    return parseProcesses(err?.stdout ?? "");
  }
}

/** When a terminal's program started, or null. */
async function startOf(pid) {
  if (!pid) return null;
  return (await processes([pid])).get(pid)?.since ?? null;
}

/**
 * The terminal with its real foreground. herdr-core reports the shell as the
 * foreground on Windows even while an agent runs in it, so there it comes
 * from the process table (lib/win.js). Elsewhere the terminal is unchanged.
 */
export function withForeground(t, table) {
  if (!WIN || !t || !table) return t;
  return { ...t, foreground: effectiveForeground(t, table) ?? t.foreground };
}

/**
 * `--agent K`: the agent the hook was installed for (Droid's and Cursor's
 * hooks say so; Claude Code's and Codex's, from earlier versions, don't).
 */
const hintOf = (args) => {
  const i = args.indexOf("--agent");
  return i >= 0 && Object.prototype.hasOwnProperty.call(AGENTS, args[i + 1]) ? args[i + 1] : null;
};

async function hook(args = []) {
  const payload = hookPayload(await readStdin());
  const t = process.env.HC_TERMINAL_ID;
  const { event, session } = payload;
  if (!t || !validId(session)) return;
  // The agent ends when the core stops, and its SessionEnd comes after: with
  // no core, there is no label to change, and `hc` would start a new core.
  if (!(await coreUp())) return;
  // Windows: an end is matched by its session id alone. Codex gives SessionEnd
  // 3 seconds, and the process table (through PowerShell) takes most of that.
  // A run the agent started as a tool has a session of its own, never this one.
  if (WIN && event === "SessionEnd") {
    const rec = readRecord((await getTerminal(t))?.labels);
    if (rec?.session === session && endAction(rec.agent, payload.reason) === "forget") await label(t, clearArgs());
    return;
  }
  // Windows needs the process table to know the foreground: ask for both at once.
  const [raw, winTable] = WIN ? await Promise.all([getTerminal(t), processes()]) : [await getTerminal(t), null];
  const terminal = withForeground(raw, winTable);
  // The hook must belong to the agent in the terminal's foreground, not to a
  // `claude -p` that agent ran as a tool (it inherits HC_TERMINAL_ID too).
  const target = terminal.foreground?.pid ?? terminal.pid;
  if (!target) return;
  const table = winTable ?? await processes();
  const owner = hookOwner(table, process.ppid, target);
  if (!owner.owned) return;
  const rec = readRecord(terminal.labels);

  if (event === "SessionStart") {
    // The command line: the foreground's (exact words), else the agent
    // process the hook came from, when a wrapper with another name runs it.
    const fgArgv = terminal.foreground?.argv ?? terminal.argv ?? [];
    // pi and omp rename their process, which hides their flags: their extension sends the command line.
    const sent = payload.argv;
    const argv = sent && agentKey(null, sent) ? sent : agentKey(null, fgArgv) ? fgArgv : table.get(owner.agent)?.argv ?? fgArgv;
    // The command line first: the terminal's last OSC report may still be a
    // previous agent's, sent before this one reported anything.
    const key = agentKey(null, argv) ?? hintOf(args) ?? payload.agent ?? agentKey(terminal.status?.app);
    if (!key) return;
    // `claude -p "…"` or `codex exec` typed in the terminal: it answers and
    // quits, and its SessionEnd ("other") would leave its session on record in
    // place of the interactive one. Neither is worth bringing back.
    if (isOneShot(key, argv)) return;
    const same = rec?.session === session;
    let flags = carriedFlags(key, argv);
    try {
      const resumed = JSON.parse(process.env.REVIVE_RESUME ?? "null");
      if (resumed?.agent === key && resumed.session === session && Array.isArray(resumed.flags)) flags = safeFlags(key, resumed.flags);
    } catch { /* not an automatic resume, or malformed context: use argv */ }
    // The hook runs in the agent's environment: whether it keeps its sessions
    // somewhere else. Only the names are recorded (see `needs` in core.js).
    const needs = needsOf(key, argv, process.env);
    await label(t, labelArgs({
      agent: key,
      session,
      cwd: payload.cwd || terminal.foreground?.cwd || terminal.cwd || "",
      flags: JSON.stringify(flags),
      env: null,
      needs: needs.length ? JSON.stringify(needs) : null,
      // pi and omp keep sessions where their flags, environment or settings say: the file named is the one to check.
      transcript: EXTENSION_AGENTS.includes(key) && String(payload.transcript ?? "").startsWith("/") ? payload.transcript : null,
      shell: terminal.pid ?? "",
      since: table.get(terminal.pid)?.since ?? null,
      at: same ? rec.at ?? Date.now() : Date.now(),
      ended: null,
      failed: null,
      // The same session starting again (a resume, a compaction) keeps its
      // "resumed" mark; a new one starts without.
      resumed: same ? rec.resumed : null,
    }));
    // One session, one terminal: a session resumed here (`claude --resume` by
    // hand, or Revive) no longer belongs to a terminal that held it before,
    // or a restart would bring it back in both.
    if (WIN && payload.source === "resume") await forgetElsewhere(t, session);
    return;
  }

  if (event === "SessionEnd") {
    if (!rec || rec.session !== session) return;
    // Claude Code's reasons (Codex, Droid and pi's extension share them):
    // `/clear` (and `/resume` from inside) ends one session to start another in
    // the same process; that one's SessionStart records it, and clearing here
    // could race it and erase the new record. A signal (a crash, a kill, a
    // shutdown) reports "other": the record stays, worth bringing back. `/exit`,
    // Ctrl+C, `/logout`: the person ended it. Cursor's are in its AGENTS entry.
    if (endAction(rec.agent, payload.reason) === "forget") await label(t, clearArgs());
  }
}

/** Clears `session` from every other local terminal that has it on record. */
async function forgetElsewhere(here, session) {
  const others = (await listTerminals()).filter((x) => x.address !== here && !x.address.includes("/") && readRecord(x.labels)?.session === session);
  for (const x of others) await label(x.address, clearArgs());
}

// ── records read back ───────────────────────────────────────────────────────

/**
 * A record read from labels, with its folder checked on disk: `cd` goes to
 * the folder's real path, and only to an existing folder that belongs to this
 * user and that nobody else can write to: not anyone, and not its group,
 * unless that group is the user's own private one (a Linux umask of 002 makes
 * folders group-writable, with a group named after the user and no one else
 * in it). Otherwise `cwdRefused` names the recorded folder, and neither an
 * automatic resume nor one by hand runs.
 */
export function vetRecord(rec, { uid = process.getuid?.(), gid = process.getgid?.(), owners = null } = {}) {
  if (!rec?.cwd) return rec;
  // Windows has no mode bits worth reading: the folder must be the person's
  // by its owner (`owners`, from ownersFor). Without an answer it is refused.
  if (WIN) {
    try {
      const real = realpathSync.native(rec.cwd);
      if (statSync(real).isDirectory() && owners?.get(real) === true) return { ...rec, cwd: real };
    } catch { /* gone */ }
    return { ...rec, cwd: null, cwdRefused: rec.cwd };
  }
  try {
    const real = realpathSync(rec.cwd);
    const st = statSync(real);
    const groupOk = (st.mode & 0o020) === 0 || (uid !== undefined && st.gid === gid && gid === uid);
    if (st.isDirectory() && (uid === undefined || st.uid === uid) && (st.mode & 0o002) === 0 && groupOk) return { ...rec, cwd: real };
  } catch { /* gone */ }
  return { ...rec, cwd: null, cwdRefused: rec.cwd };
}

const loadRecord = (labels, owners = null) => vetRecord(readRecord(labels), owners ? { owners } : {});

/**
 * Windows: who owns the folders these records name, in one PowerShell, for
 * vetRecord (real path → the person's or not). Elsewhere null: vetRecord
 * reads the folders' own mode bits.
 */
async function ownersFor(cwds) {
  if (!WIN) return null;
  const real = [...new Set(cwds.filter(Boolean).map((cwd) => { try { return realpathSync.native(cwd); } catch { return null; } }).filter(Boolean))];
  return folderOwners(real);
}

/** A program's name for a message: `C:\…\node.exe` is `node.exe`. */
const programName = (word) => String(word ?? "").split(/[\\/]/).pop() || "another program";

// ── the shell ───────────────────────────────────────────────────────────────

const claudeDir = (env = process.env) => env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

/**
 * Claude Code writes a session's transcript only once it has a message, so a
 * session opened and left empty can't be resumed: `--resume` says "No
 * conversation found". Its folder is named after the cwd; other folders are
 * searched when the agent moved. Codex is not checked. Only this process's
 * `CLAUDE_CONFIG_DIR` is searched: a record with needs is never checked here
 * (see `resume`). pi and omp do the same; their record names the file, which
 * is all there is to check.
 */
export function hasTranscript(rec) {
  if (EXTENSION_AGENTS.includes(rec.agent)) return !rec.transcript || existsSync(rec.transcript);
  if (rec.agent !== "claude") return true;
  const projects = join(claudeDir(), "projects");
  const file = `${rec.session}.jsonl`;
  if (rec.cwd && existsSync(join(projects, rec.cwd.replace(/[^A-Za-z0-9]/g, "-"), file))) return true;
  try { return readdirSync(projects).some((dir) => existsSync(join(projects, dir, file))); }
  catch { return false; }
}

async function check(args) {
  const t = process.env.HC_TERMINAL_ID;
  if (!t) return;
  const shellPid = Number(args[args.indexOf("--shell") + 1]);
  const terminal = await getTerminal(t);
  const debug = (why) => { if (process.env.REVIVE_DEBUG) process.stderr.write(`revive: ${why}\n`); };
  // The terminal's own shell is the common case and needs no ps. A shell a
  // wrapper runs as its child is the terminal's too (ownShell).
  const pid = terminal.pid ?? null;
  let own = pid !== null && shellPid === pid, since = null;
  // Windows: the profile block asks only from the terminal's own shell, and
  // says when that shell started (`--since`, .NET's round-trip time).
  if (WIN && !own) { debug("not the terminal's own shell"); return; }
  const raw = readRecord(terminal.labels);
  const rec = WIN ? vetRecord(raw, { owners: await ownersFor([raw?.cwd]) }) : loadRecord(terminal.labels);
  if (WIN) {
    const at = args.indexOf("--since");
    since = at >= 0 ? toSince(args[at + 1]) : null;
  } else if (own) since = await startOf(pid);
  else if (rec && pid !== null) {
    const table = await processes();
    const verdict = ownShell(table, shellPid, pid, process.env.REVIVE_SHELL);
    if (!verdict.own) { debug(verdict.why); return; }
    own = true;
    since = table.get(pid)?.since ?? null;
  }
  // shouldResume asks whether the shell is the terminal's: it is, when `own`.
  const verdict = shouldResume(rec, { pid, since, shellPid: own ? pid : shellPid, env: process.env });
  debug(verdict.why);
  if (!verdict.go && verdict.hint) {
    // Said once: marked failed, the next shell stays quiet; the dialog offers it by hand.
    await label(t, labelArgs({ failed: Date.now() }));
    process.stdout.write(`${(WIN ? psNote : printfLine)([
      ["warn", "↻ Revive"], [null, `  not resuming ${AGENTS[rec.agent].name} session ${shortId(rec.session)}: ${verdict.why}.`],
      ["dim", " Resume it by hand from the Revive dialog."],
    ])}\n`);
    return;
  }
  if (!verdict.go) return;
  if (!hasTranscript(rec)) { debug("the session has no transcript; forgot it"); await label(t, clearArgs()); return; }
  // Mark it first: a second shell started from this one must not resume it again.
  await label(t, resumedArgs({ pid, since }));
  process.stdout.write((WIN ? psResumeScript(rec, ENGINE) : resumeScript(rec, ENGINE)) + "\n");
}

async function failed() {
  const t = process.env.HC_TERMINAL_ID;
  if (t) await label(t, labelArgs({ failed: Date.now() }));
}

// ── the dialog ──────────────────────────────────────────────────────────────

/** Claude Code keeps `sessions/<pid>.json` for each interactive process. */
function claudeSessionFor(pid) {
  const dir = join(claudeDir(), "sessions");
  try {
    const id = JSON.parse(readFileSync(join(dir, `${pid}.json`), "utf8")).sessionId;
    return validId(id) ? id : null;
  } catch { return null; }
}

/**
 * Whether a running session can be forked: a fork resumes it, so it needs a
 * transcript. Only a sure "no" says false. A record without the agent's
 * config folder (one from before Revive kept it) is checked against this
 * process's folder only when the agent's own `sessions/<pid>.json` is there,
 * which proves it is the same folder; otherwise the answer is unknown (null)
 * and the fork is let through.
 */
function forkable(rec, fgPid) {
  if (EXTENSION_AGENTS.includes(rec.agent)) return hasTranscript(rec);
  if (rec.agent !== "claude") return true;
  const known = fgPid && claudeSessionFor(fgPid) !== null;
  if (!known) return null;
  return hasTranscript(rec);
}

/** A `ps` start time (`Sat Oct 31 18:49:55 2026`, in LC_ALL=C) in ms, or null. */
const startMs = (since) => { const ms = Date.parse(since ?? ""); return Number.isFinite(ms) ? ms : null; };

/**
 * The session a live agent nobody recorded holds, from the files it writes
 * (lib/sessions.js), and the folder to resume or fork it in: `{ session, cwd }`,
 * with `why` when Claude Code's start folder can't be told (`cwd` is then the
 * one it runs in now), or null.
 */
function runningSession(t, agent, fgSince) {
  if (!t.foreground?.pid) return null;
  const dirs = agentDirs();
  const now = t.foreground.cwd ?? t.cwd ?? null;
  const session = findSession(agent, { dirs, pid: t.foreground.pid, cwd: now, startedMs: startMs(fgSince) });
  if (!session) return null;
  // Claude Code files a conversation under the folder it started in, and
  // finds it only from there; the agent may have moved since.
  if (agent !== "claude") return { session, cwd: now };
  const start = claudeStartFolder({ dirs, session, cwd: now });
  return start.why ? { session, cwd: now, why: start.why } : { session, cwd: start.cwd };
}

function describe(t, since, focus, fgSince = null, owners = null) {
  const rec = loadRecord(t.labels, owners);
  const live = liveAgent(t);
  const entry = {
    address: t.address,
    where: t.labels?.where ?? null,
    title: t.title ?? "",
    pid: t.pid ?? null,
    live,
    rec,
    state: rec ? stateOf(rec, { live: live === rec.agent, pid: t.pid ?? null, since }) : null,
  };
  // A live agent nobody recorded yet (started before Revive was installed),
  // found from the files it writes (lib/sessions.js).
  if (!rec && live) {
    const found = runningSession(t, live, fgSince);
    if (found) {
      entry.rec = { agent: live, session: found.session, cwd: found.cwd, flags: carriedFlags(live, t.foreground.argv), shell: t.pid, auto: true };
      entry.state = "running";
      entry.unrecorded = true;
      // Only Claude Code's can be remembered (`adopt`): false, with why, while
      // its start folder can't be told; absent for the others.
      if (live === "claude") entry.rememberable = !found.why;
      if (live === "claude" && found.why) entry.rememberWhy = found.why;
    }
  }
  // An agent running with nothing on record: the dialog still names it, and its folder.
  if (!entry.rec && live) entry.folder = t.foreground?.cwd ?? t.cwd ?? null;
  // Only the focused terminal's card offers Fork, so only it is checked.
  if (entry.rec && entry.state === "running" && t.address === focus) entry.forkable = forkable(entry.rec, t.foreground?.pid);
  // Windows: the dialog's Copy command is PowerShell (core.js needsCommand is POSIX).
  if (WIN && entry.rec?.needs?.length) entry.byHand = psNeedsCommand(entry.rec);
  return entry;
}

async function list(args) {
  const focus = args.includes("--focus") ? args[args.indexOf("--focus") + 1] : null;
  const raw = await listTerminals();
  const pids = raw.flatMap((t) => [t.pid, t.foreground?.pid]).filter(Boolean);
  const procs = WIN || pids.length ? await processes([...new Set(pids)]) : new Map();
  // Windows: without the process table every running session would look lost, with Resume offered.
  if (WIN && !procs.size && !pwshInstalled()) throw new Error(PWSH_REQUIRED);
  if (WIN && !procs.size) throw new Error("Revive can't read the process list right now (pwsh), so it can't tell which sessions are running.");
  const terminals = raw.map((t) => withForeground(t, procs));
  const owners = await ownersFor(terminals.map((t) => readRecord(t.labels)?.cwd));
  const since = (pid) => (pid ? procs.get(pid)?.since ?? null : null);
  const entries = terminals.map((t) => describe(t, since(t.pid), focus, since(t.foreground?.pid), owners)).filter((e) => e.rec || e.address === focus);
  // The setup only changes on install; the dialog asks for it when it opens and after.
  const out = { entries };
  if (args.includes("--setup")) out.setup = doctorReport();
  process.stdout.write(JSON.stringify(out) + "\n");
}

async function resume(args) {
  const t = args[0];
  // Windows: what runs in the terminal comes from the process table.
  const [raw, table] = WIN ? await Promise.all([getTerminal(t), processes()]) : [await getTerminal(t), null];
  // Without the process table, herdr-core's foreground (always the shell on
  // Windows) would say the terminal is idle even while Claude runs: never type then.
  if (WIN && !(raw.pid && table.has(raw.pid))) throw new Error(`Revive can't tell what runs in ${t} right now, so it won't type into it. Try again in a moment.`);
  const terminal = withForeground(raw, table);
  const rec = WIN ? vetRecord(readRecord(terminal.labels), { owners: await ownersFor([readRecord(terminal.labels)?.cwd]) }) : loadRecord(terminal.labels);
  if (!rec) throw new Error(`${t} has no remembered session.`);
  if (liveAgent(terminal) === rec.agent) throw new Error(`${AGENTS[rec.agent].name} is already running in ${t}.`);
  const fg = terminal.foreground;
  if (fg?.pid && terminal.pid && fg.pid !== terminal.pid) {
    // Windows: anything running under the shell means it isn't at its prompt.
    if (WIN) throw new Error(`${t} is busy with ${programName(fg.argv?.[0])}. Quit it first.`);
    // A wrapper's child shell is the terminal's shell too, just as in check.
    // An unrelated shell or any other foreground program is still busy.
    if (!idleWrappedShell(await processes(), fg, terminal.pid)) throw new Error(`${t} is busy with ${fg.argv?.[0] ?? "another program"}. Quit it first.`);
  }
  const line = WIN ? psResumeLine(rec) : resumeLine(rec);
  if (!line) throw new Error(`Can't build a resume command for ${t}.`);
  // Not sent without its folder (the agent would start elsewhere, with its
  // flags), nor without what it needs, and not forgotten: its sessions are
  // somewhere this shell may not look. The dialog says the same before a click.
  const why = unresumable(rec);
  if (why?.folder) throw new Error(`Won't resume: its folder ${tilde(why.folder)} is missing, not yours, or writable by others.`);
  if (why?.needs) throw new Error(`Won't resume here: it ran with ${why.needs.join(", ")}, which Revive doesn't carry. ${needsHint(rec, WIN ? psNeedsCommand : undefined)}`);
  if (!hasTranscript(rec)) {
    await label(t, clearArgs());
    throw new Error("That session never got a message, so there is nothing to resume. Forgot it.");
  }
  await label(t, resumedArgs({ pid: terminal.pid, since: WIN ? table.get(terminal.pid)?.since ?? null : await startOf(terminal.pid) }));
  // Run from inside a herdr terminal, `hc send` delivers the text as a note from
  // that terminal (`<hc from="t3">…</hc>`), which the shell can't run.
  const { HC_TERMINAL_ID: _, ...env } = process.env;
  await hc(["send", t, line], env);
}

async function auto(args) {
  const [t, value] = args;
  await label(t, labelArgs({ auto: value === "off" ? "off" : null }));
}

// ── adopt ───────────────────────────────────────────────────────────────────

/**
 * What adopting a terminal would record: `{ agent, session, fields }`, the
 * labels its SessionStart hook would have written; `{ agent, why }` for an
 * agent Revive won't record; or null (no agent, or one already on record).
 * Every value comes from the agent's own process: its session file in this
 * user's Claude folder, its live command line, the transcript `--resume`
 * reads. A label is only asked whether a record exists, so none can make
 * adopt record anything, and what it writes is read back through the same
 * filters as a hook's (readRecord, vetRecord).
 */
function adoption(t, procs, owners = null) {
  if (readRecord(t.labels)) return null;
  const agent = liveAgent(t);
  if (!agent) return null;
  const argv = t.foreground?.argv ?? [];
  // `claude -p` typed in the terminal: it answers and quits, as for the hook.
  if (isOneShot(agent, argv)) return { agent, why: "a one-shot run, with no session to bring back" };
  // Only Claude Code's sessions/<pid>.json names its session for sure. The
  // others are found by the newest file in their folder's store, good enough
  // to show but not to keep as a record.
  if (agent !== "claude") return { agent, why: "only a running Claude Code session can be remembered; start it again to record it" };
  const found = runningSession(t, agent, procs.get(t.foreground?.pid)?.since);
  if (!found || !validId(found.session)) return { agent, why: "Revive can't find its session from its files" };
  const { session, cwd } = found;
  if (found.why) return { agent, session, why: found.why };
  // The folder a resume would `cd` to, checked now as it will be then.
  if (vetRecord({ cwd }, owners ? { owners } : {}).cwdRefused) return { agent, session, why: `its folder ${tilde(cwd)} is missing, not yours, or writable by others` };
  // The session was found in the folder this process's variables name, so the
  // agent ran with the same ones: names only, as the hook records them.
  const needs = needsOf(agent, argv, process.env);
  return {
    agent,
    session,
    fields: {
      agent,
      session,
      cwd,
      flags: JSON.stringify(carriedFlags(agent, argv)),
      env: null,
      needs: needs.length ? JSON.stringify(needs) : null,
      // Only pi and omp name a session file.
      transcript: null,
      shell: t.pid ?? "",
      since: procs.get(t.pid)?.since ?? null,
      at: Date.now(),
      ended: null,
      failed: null,
      resumed: null,
    },
  };
}

/**
 * Adopts every local live terminal (or only `only`) running an agent nobody
 * recorded. One session, one terminal: an id already on record elsewhere, or
 * found in two terminals, would come back in two panes, so it is skipped.
 * Returns one result per agent, written unless `dry`.
 */
async function adoptRunning({ only = null, dry = false } = {}) {
  const all = await listTerminals();
  const reported = all.filter((t) => !t.address.includes("/") && (!only || t.address === only));
  if (only && !reported.length) throw new Error(`${only} is not a live terminal on this computer.`);
  const pids = reported.flatMap((t) => [t.pid, t.foreground?.pid]).filter(Boolean);
  const procs = WIN || pids.length ? await processes([...new Set(pids)]) : new Map();
  const local = reported.map((t) => withForeground(t, procs));
  // Windows: the owners of the folders the running sessions started in, in one go.
  const owners = await ownersFor(local.map((t) => (!readRecord(t.labels) && liveAgent(t) === "claude"
    ? runningSession(t, "claude", procs.get(t.foreground?.pid)?.since)?.cwd : null)));
  const results = [];
  for (const t of local) {
    const plan = adoption(t, procs, owners);
    if (only && !plan) throw new Error(readRecord(t.labels) ? `${only} already has a remembered session.` : `No agent session in ${only}.`);
    if (plan) results.push({ address: t.address, where: t.labels?.where ?? null, ...plan });
  }
  const taken = new Set(all.map((t) => readRecord(t.labels)?.session).filter(Boolean));
  const seen = new Map();
  for (const r of results) if (r.fields) seen.set(r.session, (seen.get(r.session) ?? 0) + 1);
  for (const r of results) {
    if (!r.fields) continue;
    r.why = taken.has(r.session) ? "its session is already remembered in another terminal"
      : seen.get(r.session) > 1 ? "another terminal holds the same session" : undefined;
    if (r.why) { delete r.fields; continue; }
    if (dry) continue;
    try { await label(r.address, labelArgs(r.fields)); }
    catch (err) { r.why = `hc label failed: ${String(err?.stderr || err?.message || err).trim()}`; r.failed = true; delete r.fields; }
  }
  if (only && results[0]?.why) throw new Error(`Won't remember ${AGENTS[results[0].agent].name} in ${only}: ${results[0].why}.`);
  return results;
}

/** What adopt did, or would do, as text: the sessions, and each agent left out with why. */
function adoptReport(results, { dry = false } = {}) {
  const at = (r) => (r.where ? `${r.address} (${r.where})` : r.address);
  const done = results.filter((r) => r.fields);
  const left = results.filter((r) => r.why);
  const lines = [];
  if (!done.length) lines.push("No running session to remember.");
  else {
    lines.push(`${dry ? "Would remember" : "Remembered"} ${done.length} running session${done.length === 1 ? "" : "s"}:`);
    for (const r of done) {
      lines.push(`  ${at(r)}  ${AGENTS[r.agent].name} ${shortId(r.session)}  ${tilde(r.fields.cwd)}`);
      if (dry) lines.push(`    ${shJoin([HC, "label", r.address, ...labelArgs(r.fields)])}`);
    }
  }
  if (left.length) lines.push("Not remembered:", ...left.map((r) => `  ${at(r)}  ${AGENTS[r.agent].name}: ${r.why}`));
  return `${lines.join("\n")}\n`;
}

async function adopt(args) {
  const dry = args.includes("--dry-run");
  const only = args.find((a) => !a.startsWith("-")) ?? null;
  const results = await adoptRunning({ only, dry });
  process.stdout.write(adoptReport(results, { dry }));
  if (results.some((r) => r.failed)) throw new Error("Some sessions weren't remembered: see above.");
}

/**
 * `doctor`: what is installed, and how many running sessions `adopt` could
 * remember (null when hc wasn't asked or failed). The dialog's setup is
 * doctorReport() alone: it lists the sessions itself.
 */
async function doctor() {
  let count = null;
  try { count = await unremembered(); } catch { /* no hc, or no core: unknown, said as null */ }
  process.stdout.write(JSON.stringify({ ...doctorReport(), unremembered: count }, null, 2) + "\n");
}

// ── install ─────────────────────────────────────────────────────────────────

/**
 * The engine as a hook runs it. Under the home folder it is written as
 * `"$HOME/…"` (Claude Code runs hooks through a shell): a settings file kept in
 * a dotfiles repository and copied to another machine, where home is another
 * folder, still finds the engine there. Elsewhere it is the quoted path.
 */
export function engineWord(engine = ENGINE, home = homedir()) {
  const rest = home && engine.startsWith(`${home}/`) ? engine.slice(home.length) : null;
  return rest !== null && /^[A-Za-z0-9_@%+=:,./ -]+$/.test(rest) ? `"$HOME${rest}"` : shQuote(engine);
}
/**
 * The engine as Claude Code's hook runs it on Windows: through Git Bash, so
 * the absolute path with forward slashes, in double quotes (cmd reads it too).
 */
export const winHookCommand = (engine = ENGINE) => `node "${engine.replace(/\\/g, "/")}" hook`;
const HOOK_COMMAND = `node ${shQuote(ENGINE)} hook`;
const PORTABLE_HOOK_COMMAND = `node ${engineWord()} hook`;
const hookCommand = (agent = null, portable = false) => {
  const base = WIN ? winHookCommand() : portable ? PORTABLE_HOOK_COMMAND : HOOK_COMMAND;
  return agent ? `${base} --agent ${agent}` : base;
};
const claudeSettings = () => join(claudeDir(), "settings.json");
const codexDir = () => process.env.CODEX_HOME || join(homedir(), ".codex");
const codexHooks = () => join(codexDir(), "hooks.json");
const codexConfig = () => join(codexDir(), "config.toml");
/** The agents Revive supports on Windows. */
const WIN_AGENTS = ["claude", "codex"];
/** What install says when it turns Codex's background server off, naming the file it changed. */
export const codexNotice = (file) => `Codex: turned off its shared background server (daemon_auto_start = false in ${file}) so Revive can see which pane a session runs in. Uninstall turns it back.`;
const piDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
// omp reads PI_CODING_AGENT_DIR too, but a pi setup sets it for pi: omp's own folder is assumed.
const ompDir = () => join(homedir(), ".omp", "agent");
/**
 * pi and omp have no hooks file: their hooks come from an extension, kept in
 * the mod and linked where each loads extensions. It finds the engine from its
 * own place. `marker` is its first line; a copy placed by something else (a
 * Nix store path) counts too.
 */
const EXTENSIONS = {
  pi: { dir: piDir, flag: "--no-pi", source: join(dirname(ENGINE), "pi", "revive.ts"), marker: "herdr-revive: pi extension" },
  omp: { dir: ompDir, flag: "--no-omp", source: join(dirname(ENGINE), "omp", "revive.ts"), marker: "herdr-revive: omp extension" },
};
const EXTENSION_AGENTS = Object.keys(EXTENSIONS);
const extensionPath = (key) => join(EXTENSIONS[key].dir(), "extensions", "herdr-revive.ts");
const isExtension = (key, path) => readText(path).includes(EXTENSIONS[key].marker);
const factoryDir = () => agentDirs({ ...process.env, HOME: homedir() }).factory;
const cursorDir = () => agentDirs({ ...process.env, HOME: homedir() }).cursor;

/**
 * Whether a CLI is installed: on PATH, or in ~/.local/bin, where the Droid and
 * cursor-agent installers put it. The Herdr app may run Revive with a shorter
 * PATH than the person's shell has, hence the fallback.
 */
export const hasCli = (bin) => [...(process.env.PATH ?? "").split(delimiter).filter(Boolean), join(homedir(), ".local", "bin")]
  .some((dir) => (WIN ? ["", ".exe", ".cmd", ".bat"] : [""]).some((ext) => existsSync(join(dir, bin + ext))));

/**
 * On macOS herdr-core starts terminals as login shells (`zsh -l`, `bash -l`).
 * zsh reads .zshrc either way; a login bash reads the first of .bash_profile,
 * .bash_login and .profile, and not .bashrc. Creating .bash_profile where
 * only .profile exists would stop bash from reading .profile, so the block
 * goes into whichever bash reads.
 * On Linux herdr-core starts bash without `-l` (herdrdev/herdr-core#99): an
 * interactive bash that is no login shell reads only .bashrc, so the block
 * goes there. A login bash on Linux usually reaches it too: Debian's and
 * Ubuntu's .profile source .bashrc.
 */
const BASH_LOGIN = [".bash_profile", ".bash_login", ".profile"];
const bashLogin = () => {
  const found = BASH_LOGIN.map((f) => join(homedir(), f)).find((p) => existsSync(p));
  return found ?? join(homedir(), ".bash_profile");
};
const bashRc = (platform = process.env.REVIVE_PLATFORM || process.platform) => (platform === "darwin" ? bashLogin() : join(homedir(), ".bashrc"));
/**
 * zsh reads .zshrc from $ZDOTDIR, which people often set in ~/.zshenv. The
 * dialog's Install runs from the app, whose environment never read that
 * file, so zsh itself is asked: `zsh -c` reads .zshenv and nothing else.
 */
let zdotdir;
function zshDir() {
  if (zdotdir !== undefined) return zdotdir;
  zdotdir = process.env.ZDOTDIR || null;
  if (!zdotdir) {
    try {
      const out = execFileSync("zsh", ["-c", 'print -r -- "${ZDOTDIR:-$HOME}"'], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (out.startsWith("/")) zdotdir = out;
    } catch { /* no zsh: its rc file is moot */ }
  }
  zdotdir ||= homedir();
  return zdotdir;
}
const RC = { zsh: () => join(zshDir(), ".zshrc"), bash: () => bashRc() };
// Every file a block may be in, for uninstall.
const ALL_RC = () => [RC.zsh(), ...BASH_LOGIN.map((f) => join(homedir(), f)), join(homedir(), ".bashrc")];
const BEGIN = "# >>> herdr-revive >>>";
const END = "# <<< herdr-revive <<<";
const EVENTS = ["SessionStart", "SessionEnd"];

const isOurs = (h) => typeof h?.command === "string" && h.command.includes("revive.mjs") && /\bhook\b/.test(h.command);

export function shellBlock(engine = ENGINE) {
  const q = shQuote(engine);
  return [
    BEGIN,
    "# Resume the coding agent a herdr terminal lost to a restart or reboot.",
    "# REVIVE_DEBUG=1 says why it did or didn't.",
    `if [ -n "$HC_TERMINAL_ID" ] && [ -f ${q} ] && command -v node >/dev/null 2>&1; then`,
    `  __revive_j="$("\${REVIVE_HC:-hc}" get "$HC_TERMINAL_ID" --json 2>/dev/null)"`,
    // Two cheap tests before starting node: a session is remembered here, and
    // this shell wasn't started by hand from one that ran this block (its
    // REVIVE_SHELL). Whether it is the terminal's own (its program, or the
    // shell a wrapper runs as its child), `check` decides from the processes.
    `  case "$__revive_j" in *'"revive.session"'*) __revive_has=1 ;; *) __revive_has= ;; esac`,
    `  if [ -z "$__revive_has" ]; then`,
    `    if [ -n "$REVIVE_DEBUG" ]; then echo "revive: nothing remembered on $HC_TERMINAL_ID" >&2; fi`,
    `  elif [ "$REVIVE_SHELL" = "$PPID" ]; then`,
    `    if [ -n "$REVIVE_DEBUG" ]; then echo "revive: a shell started inside the terminal's own shell" >&2; fi`,
    `  else`,
    `    if [ -n "$REVIVE_DEBUG" ]; then __revive="$(node ${q} check --shell $$)"`,
    `    else __revive="$(node ${q} check --shell $$ 2>/dev/null)"; fi`,
    // The agent is interactive: start it at the first prompt, once the rc
    // files are done and the terminal is the shell's again (an instant
    // prompt, for one, holds on to it while they run).
    `    if [ -z "$__revive" ]; then unset __revive`,
    `    elif [ -n "$ZSH_VERSION" ]; then`,
    `      __revive_run() { add-zsh-hook -d precmd __revive_run; eval "$__revive"; unset __revive; unfunction __revive_run; }`,
    `      autoload -Uz add-zsh-hook && add-zsh-hook precmd __revive_run`,
    `    elif [ -n "$BASH_VERSION" ]; then`,
    `      __revive_run() { PROMPT_COMMAND="\${PROMPT_COMMAND#__revive_run;}"; eval "$__revive"; unset __revive; unset -f __revive_run; }`,
    `      PROMPT_COMMAND="__revive_run;\${PROMPT_COMMAND}"`,
    `    else eval "$__revive"; unset __revive; fi`,
    `  fi`,
    `  unset __revive_j __revive_has`,
    // Shells started from this one know it ran here (see ownShell).
    `  REVIVE_SHELL=$$; export REVIVE_SHELL`,
    `fi`,
    END,
  ].join("\n");
}

/**
 * Adds (or, with remove, takes out) Revive's SessionStart/SessionEnd hooks, in
 * Claude Code's format, which Codex and Factory Droid share. An event that already has exactly Revive's hook is left as it is, wherever
 * it sits: other tools write this file too, and moving Revive's group back to
 * the end each time would rewrite it for nothing. `timeouts` sets an event's
 * timeout (Codex clamps SessionEnd to 3 seconds and warns about more).
 */
export function withHooks(settings, { remove = false, matcher = false, timeouts = {}, agent = null, portable = false } = {}) {
  const out = structuredClone(settings ?? {});
  out.hooks ??= {};
  const command = hookCommand(agent, portable);
  for (const event of EVENTS) {
    const timeout = timeouts[event] ?? 10;
    const ours = (out.hooks[event] ?? []).flatMap((g) => (g.hooks ?? []).filter(isOurs));
    if (!remove && ours.length === 1 && ours[0].command === command && ours[0].timeout === timeout) continue;
    const groups = (out.hooks[event] ?? [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length);
    if (!remove) groups.push({ ...(matcher ? { matcher: "" } : {}), hooks: [{ type: "command", command, timeout }] });
    if (groups.length) out.hooks[event] = groups;
    else delete out.hooks[event];
  }
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}

export const hasHooks = (settings) => EVENTS.every((e) => (settings?.hooks?.[e] ?? []).some((g) => (g.hooks ?? []).some(isOurs)));

/**
 * Droid's standalone `~/.factory/hooks.json` holds the same event map with no
 * `hooks` wrapper around it.
 */
const unwrapped = (fn) => (doc, opts) => fn({ hooks: doc ?? {} }, opts).hooks ?? {};
const withBareHooks = unwrapped(withHooks);
const hasBareHooks = (doc) => hasHooks({ hooks: doc ?? {} });

/**
 * Cursor's `~/.cursor/hooks.json`: `{ version: 1, hooks: { sessionStart:
 * [{ command }], … } }`, camelCase events and no groups. No timeout is
 * written: the docs don't give its unit. Revive's entry, already right, is
 * left where it is.
 */
const CURSOR_EVENTS = ["sessionStart", "sessionEnd"];
export function withCursorHooks(doc, { remove = false } = {}) {
  const out = structuredClone(doc ?? {});
  if (!remove) out.version ??= 1;
  out.hooks ??= {};
  const command = hookCommand("cursor");
  for (const event of CURSOR_EVENTS) {
    const ours = (out.hooks[event] ?? []).filter(isOurs);
    if (!remove && ours.length === 1 && ours[0].command === command) continue;
    const list = (out.hooks[event] ?? []).filter((h) => !isOurs(h));
    if (!remove) list.push({ command });
    if (list.length) out.hooks[event] = list;
    else delete out.hooks[event];
  }
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}
export const hasCursorHooks = (doc) => CURSOR_EVENTS.every((e) => (doc?.hooks?.[e] ?? []).some(isOurs));

export function withShellBlock(text, { remove = false, block = null } = {}) {
  if (remove && !text.includes(BEGIN)) return text;
  // A PowerShell profile (the Windows block, given as `block`) with Windows
  // line ends keeps them, and taking the block out gives back exactly what was
  // there before. A POSIX rc file always gets the LF block, as upstream.
  if (block !== null && text.includes("\r\n")) {
    const crlf = new RegExp(`(?:\\r\\n){0,2}${BEGIN}[\\s\\S]*?${END}(?:\\r\\n)?`, "g");
    const stripped = text.replace(crlf, "\r\n");
    if (remove) return stripped;
    return `${stripped.replace(/(?:\r\n)*$/, "")}\r\n\r\n${(block ?? shellBlock()).replace(/\r?\n/g, "\r\n")}\r\n`;
  }
  const pattern = new RegExp(`\\n?${BEGIN}[\\s\\S]*?${END}\\n?`, "g");
  const stripped = text.replace(pattern, "\n").replace(/\n{3,}$/, "\n\n");
  if (remove) return stripped;
  return `${stripped.replace(/\n*$/, "")}\n\n${block ?? shellBlock()}\n`;
}

/**
 * pwsh 7's profile for its console host, the one a Herdr terminal's shell
 * reads. Asked from pwsh itself: Documents may be redirected (OneDrive).
 * REVIVE_PROFILE names another file, for tests.
 */
let profileFile = null;
export function profilePath() {
  if (process.env.REVIVE_PROFILE) return process.env.REVIVE_PROFILE;
  if (profileFile) return profileFile;
  try {
    profileFile = execFileSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $PROFILE.CurrentUserCurrentHost"],
    { encoding: "utf8", timeout: 15_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { /* below */ }
  if (!profileFile) throw new Error("pwsh (PowerShell 7) isn't on PATH: Revive resumes sessions from its profile.");
  return profileFile;
}

/**
 * What herdr-core's own settings say (`%APPDATA%\herdr-core\config.toml`):
 * the shell it starts terminals with, when not its default (pwsh), and
 * whether a lost program's last screen is shown above the new shell.
 */
function coreConfig() {
  const appdata = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  const text = readText(join(appdata, "herdr-core", "config.toml"));
  return {
    shell: /^\s*shell\s*=\s*\[\s*"([^"]*)"/m.exec(text)?.[1] ?? null,
    restoreScreen: /^\s*restore_screen\s*=\s*true\b/m.test(text),
  };
}
/** Windows: whether PowerShell 7 starts at all (Revive resumes from its profile). */
function pwshInstalled() {
  try { execFileSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"], { stdio: "ignore", timeout: 10_000, windowsHide: true }); return true; }
  catch { return false; }
}

/** Whether `hc` runs these arguments and exits 0 within 10 s: `--version` (installed), `server status --json` (the core answers; it never starts one). */
function hcAnswers(args) {
  try { const [file, argv] = hcInvocation(args); execFileSync(file, argv, { stdio: "ignore", timeout: 10_000, windowsHide: true, env: hcEnv(process.env) }); return true; }
  catch { return false; }
}

export const PWSH_REQUIRED = "PowerShell 7 (pwsh) is required: https://aka.ms/powershell";

const isPwsh = (shell) => /^pwsh(\.exe)?$/i.test(String(shell).split(/[\\/]/).pop());

function readJson(path) {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8").replace(/^﻿/, "");
  if (!text.trim()) return {};
  try { return JSON.parse(text); }
  catch { throw new InvalidJson(path); }
}

class InvalidJson extends Error {
  constructor(path) {
    super(`${path} is not valid JSON; fix it first, Revive won't overwrite it.`);
    this.path = path;
  }
}

const tilde = (path) => (path.startsWith(`${homedir()}/`) || path.startsWith(`${homedir()}\\`) ? `~${path.slice(homedir().length)}` : path);

/**
 * Writes a file atomically. The first time Revive changes it, the person's
 * original is copied to `<file>.revive-backup`; later changes keep that copy.
 * A symlinked file (a dotfiles repository) is written where the link points,
 * so the link stays; the file keeps its permissions.
 */
function save(path, text) {
  let target = path;
  try { target = realpathSync(path); } catch { /* not there yet */ }
  mkdirSync(dirname(target), { recursive: true });
  let mode = null;
  if (existsSync(target)) {
    if (readFileSync(target, "utf8") === text) return false;
    mode = statSync(target).mode & 0o7777;
    const backup = `${path}.revive-backup`;
    if (!existsSync(backup)) copyFileSync(target, backup);
  }
  const tmp = `${target}.revive-${process.pid}.tmp`;
  // Created with the file's own permissions, not the umask's: a 0600 settings
  // file (API keys under `env`) must not sit world-readable until the chmod.
  // The chmod stays for bits the umask takes away (0664 under umask 077).
  rmSync(tmp, { force: true });
  writeFileSync(tmp, text, mode !== null ? { mode } : undefined);
  if (mode !== null) chmodSync(tmp, mode);
  renameSync(tmp, target);
  return true;
}

const readText = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");

function shells(args) {
  const picked = ["zsh", "bash"].filter((s) => args.includes(`--${s}`));
  if (picked.length) return picked;
  const login = (process.env.SHELL ?? "").split("/").pop();
  return [RC[login] ? login : "zsh"];
}

/** Codex clamps a SessionEnd hook's timeout to 3 seconds and warns at every start about more. */
const CODEX_HOOKS = { matcher: true, timeouts: { SessionEnd: 3 } };

/**
 * Where each agent's hooks are installed. `files` lists every file they may
 * be in; `target` is the one the agent reads now (Droid reads settings.json's
 * `hooks` only while there is no hooks.json). An agent is installed only when
 * `present`: Claude Code's and Codex's folder is there, Droid's and Cursor's
 * CLI is (not just their folder: Cursor's IDE makes ~/.cursor and reads its
 * hooks.json too). `flag` (`--no-…`) skips it.
 */
const HOOK_TARGETS = {
  // Like Codex: only when Claude Code is there, so a Codex-only setup gets no ~/.claude.
  claude: { dir: claudeDir, present: () => existsSync(claudeDir()), files: () => [claudeSettings()], edit: (d, o) => withHooks(d, { ...o, portable: true }), has: hasHooks },
  codex: {
    dir: codexDir,
    present: () => existsSync(codexDir()),
    flag: "--no-codex",
    trust: "Codex asks to trust new hooks the next time it starts.",
    files: () => [codexHooks()],
    edit: (d, o) => withHooks(d, { ...o, ...CODEX_HOOKS }),
    has: hasHooks,
  },
  droid: {
    dir: factoryDir,
    present: () => existsSync(factoryDir()) && hasCli("droid"),
    flag: "--no-droid",
    files: () => [join(factoryDir(), "hooks.json"), join(factoryDir(), "settings.json")],
    target: (files) => (existsSync(files[0]) ? files[0] : files[1]),
    edit: (d, o, file) => (file.endsWith("hooks.json") ? withBareHooks(d, { ...o, agent: "droid" }) : withHooks(d, { ...o, agent: "droid" })),
    has: (d, file) => (file.endsWith("hooks.json") ? hasBareHooks(d) : hasHooks(d)),
  },
  cursor: {
    dir: cursorDir,
    present: () => hasCli("cursor-agent") || existsSync(join(homedir(), ".local", "share", "cursor-agent")),
    flag: "--no-cursor",
    files: () => [join(cursorDir(), "hooks.json")],
    edit: (d, o) => withCursorHooks(d, o),
    has: hasCursorHooks,
  },
};
const targetOf = (h) => (h.target ?? ((files) => files[0]))(h.files());

/**
 * Writes Revive's hooks into one JSON file. A file whose hooks are already
 * right is not written, even when another tool formatted it differently
 * (sorted its keys, say): only a real change rewrites it.
 */
function saveHooks(path, edit) {
  const before = readJson(path);
  const after = edit(before);
  if (existsSync(path) && JSON.stringify(after) === JSON.stringify(before)) return false;
  // A file saved with a BOM (Windows editors do that) keeps it.
  const bom = existsSync(path) && readFileSync(path, "utf8").startsWith("﻿") ? "﻿" : "";
  return save(path, bom + JSON.stringify(after, null, 2) + "\n");
}

async function install(args, remove = false) {
  const changed = [];
  const notes = [];
  for (const [key, h] of Object.entries(HOOK_TARGETS)) {
    // Windows: Claude Code and Codex only (the other agents aren't supported there).
    if (WIN && !WIN_AGENTS.includes(key)) continue;
    // Uninstall still cleans an agent whose CLI is gone, as long as its folder is there.
    if ((h.flag && args.includes(h.flag)) || !(remove ? existsSync(h.dir()) : h.present())) continue;
    const target = targetOf(h);
    try {
      for (const file of h.files()) {
        // Install into the file the agent reads; take Revive out of every other.
        // A file without Revive in it is left as it is, formatting and all.
        const off = remove || file !== target;
        if (off && !readText(file).includes("revive.mjs")) continue;
        if (saveHooks(file, (doc) => h.edit(doc, { remove: off }, file))) {
          changed.push(file);
          if (!off && h.trust) notes.push(h.trust);
        }
      }
    } catch (err) {
      // One unreadable file skips that agent only; the others and the shell go on.
      if (!(err instanceof InvalidJson)) throw err;
      notes.push(`Skipped ${AGENTS[key].name}: ${tilde(err.path)} is not valid JSON; fix it and run ${remove ? "uninstall" : "install"} again.`);
    }
  }
  // A file of someone else's at pi's or omp's path: say so, and still install the rest.
  const warnings = [];
  // Windows: Codex runs its hooks from its shared background server unless
  // daemon_auto_start is off, and from there they can't tell which terminal a
  // session is in. A setting the person wrote is theirs: only warned about.
  if (WIN && !args.includes("--no-codex") && existsSync(codexDir())) {
    const file = codexConfig();
    const text = readText(file);
    const next = withDaemonOff(text, { remove });
    if (next !== text && save(file, next)) {
      changed.push(file);
      if (!remove) notes.push(codexNotice(tilde(file)));
    }
    if (!remove && daemonSetting(next) === "on") warnings.push(`Codex's background server stays on (daemon_auto_start in ${file}): Codex sessions won't be remembered.`);
  }
  for (const key of EXTENSION_AGENTS) {
    if (WIN || args.includes(EXTENSIONS[key].flag) || !existsSync(EXTENSIONS[key].dir())) continue;
    try {
      if (linkExtension(key, remove)) {
        changed.push(extensionPath(key));
        // omp loads extensions only at start (its docs: modules are never re-evaluated).
        if (!remove) notes.push(`${AGENTS[key].name} loads the extension the next time it starts${key === "pi" ? " (or at /reload)" : ""}.`);
      }
    } catch (err) { warnings.push(err.message); }
  }
  if (WIN && !args.includes("--no-shell")) {
    // Windows: the block goes into pwsh's profile. A profile Revive created
    // (no backup of an earlier one) is removed again when nothing else is in it.
    if (!remove && !pwshInstalled()) warnings.push(PWSH_REQUIRED);
    let profile = null;
    try { profile = profilePath(); } catch (err) { warnings.push(err.message); }
    // A profile saved as UTF-16 (Windows PowerShell's `>` does that) would be
    // garbled by a UTF-8 rewrite: leave it, and say so.
    const head = profile && existsSync(profile) ? readFileSync(profile).subarray(0, 2) : null;
    if (head && head.length === 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) {
      warnings.push(`${profile} is saved as UTF-16; Revive won't rewrite it. Save it as UTF-8 and run ${remove ? "uninstall" : "install"} again.`);
      profile = null;
    }
    const text = profile ? readText(profile) : "";
    if (profile && (!remove || text.includes(BEGIN))) {
      const next = withShellBlock(text, { remove, block: psProfileBlock(ENGINE) });
      if (remove && !next.replace(/^﻿/, "").trim() && !existsSync(`${profile}.revive-backup`)) {
        rmSync(profile);
        changed.push(profile);
      } else if (save(profile, next)) changed.push(profile);
    }
    if (!remove) {
      const core = coreConfig();
      if (core.shell && !isPwsh(core.shell)) warnings.push(`herdr-core starts terminals with ${core.shell} (shell in %APPDATA%\\herdr-core\\config.toml): Revive resumes sessions only from PowerShell 7 (pwsh).`);
      if (!core.restoreScreen) notes.push("Tip: restore_screen = true in %APPDATA%\\herdr-core\\config.toml shows Claude's last screen above the resumed session.");
    }
  } else if (!args.includes("--no-shell")) {
    for (const rc of remove ? ALL_RC() : shells(args).map((s) => RC[s]())) {
      if (remove && !existsSync(rc)) continue;
      if (save(rc, withShellBlock(readText(rc), { remove }))) changed.push(rc);
    }
    // An earlier version put bash's block into another file (a login file,
    // on Linux): only one bash file keeps it.
    if (!remove && shells(args).includes("bash")) {
      const keep = RC.bash();
      for (const rc of [...BASH_LOGIN.map((f) => join(homedir(), f)), join(homedir(), ".bashrc")]) {
        if (rc === keep || !existsSync(rc) || !readText(rc).includes(BEGIN)) continue;
        if (save(rc, withShellBlock(readText(rc), { remove: true }))) changed.push(rc);
      }
    }
  }
  // Last, the sessions already running that `adopt` could remember: said,
  // never done. Install also runs on every update and from the dialog, and
  // writes nothing but its own files.
  if (!remove) {
    try {
      const n = await unremembered();
      if (n) notes.push(unrememberedNote(n));
    } catch (err) {
      warnings.push(`Couldn't count the running sessions Revive doesn't remember: ${hcFailure(err)}. revive.mjs adopt --dry-run lists them.`);
    }
  }
  process.stdout.write(changed.length ? `${remove ? "Removed from" : "Updated"}:\n${changed.map((p) => `  ${p}`).join("\n")}\n` : "Nothing to change.\n");
  // On stdout, beside what did change: the dialog shows that output as its note.
  for (const line of notes) process.stdout.write(`${line}\n`);
  for (const line of warnings) process.stderr.write(`${line}\n`);
}

/**
 * How many running sessions `adopt` would remember, or null when hc isn't
 * asked: only while the terminal's herdr-core answers, since an `hc` that
 * finds no core starts one.
 */
async function unremembered() {
  if (!(await coreUp())) return null;
  return (await adoptRunning({ dry: true })).filter((r) => r.fields).length;
}

const unrememberedNote = (n) => `${n} running Claude Code session${n === 1 ? " isn't" : "s aren't"} remembered yet: revive.mjs adopt --dry-run lists ${n === 1 ? "it" : "them"}, and revive.mjs adopt remembers ${n === 1 ? "it" : "them"}.`;

/** Why an `hc` call failed, in one line. */
const hcFailure = (err) => (err?.code === "ENOENT" ? `${HC} isn't on PATH` : String(err?.stderr || err?.message || err).trim().split("\n")[0]);

/**
 * Links pi's or omp's extension to the mod's, or, with remove, takes out that
 * link. An extension already there (this link, or a copy something else
 * manages) is left alone, and so is anything else by that name: it isn't
 * Revive's to replace.
 */
function linkExtension(key, remove) {
  const target = extensionPath(key);
  const source = EXTENSIONS[key].source;
  const real = (p) => { try { return realpathSync(p); } catch { return null; } };
  if (remove) {
    if (!lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink() || real(target) !== real(source)) return false;
    rmSync(target);
    return true;
  }
  if (isExtension(key, target)) return false;
  if (lstatSync(target, { throwIfNoEntry: false })) throw new Error(`${target} is not Revive's ${AGENTS[key].name} extension; Revive won't replace it.`);
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(source, target);
  return true;
}

export function doctorReport() {
  const safe = (fn) => { try { return fn(); } catch { return false; } };
  // Per agent: true or false, or null for an agent that isn't installed.
  const hooks = Object.fromEntries(Object.entries(HOOK_TARGETS).map(([key, h]) => {
    if ((WIN && !WIN_AGENTS.includes(key)) || !h.present()) return [key, null];
    const file = targetOf(h);
    return [key, safe(() => h.has(readJson(file), file))];
  }));
  if (WIN) {
    const core = coreConfig();
    return {
      engine: ENGINE,
      ...hooks,
      ...Object.fromEntries(EXTENSION_AGENTS.map((key) => [key, null])),
      codexDaemon: existsSync(codexDir()) ? safe(() => daemonSetting(readText(codexConfig()))) : null,
      shell: { pwsh: safe(() => readText(profilePath()).includes(BEGIN)) },
      pwshInstalled: pwshInstalled(),
      hc: hcAnswers(["--version"]),
      core: hcAnswers(["server", "status", "--json"]),
      platform: "win32",
      coreShell: core.shell,
      restoreScreen: core.restoreScreen,
    };
  }
  return {
    engine: ENGINE,
    ...hooks,
    ...Object.fromEntries(EXTENSION_AGENTS.map((key) => [key, existsSync(EXTENSIONS[key].dir()) ? safe(() => isExtension(key, extensionPath(key))) : null])),
    shell: Object.fromEntries(Object.entries(RC).map(([s, rc]) => [s, readText(rc()).includes(BEGIN)])),
  };
}

// ── main ────────────────────────────────────────────────────────────────────

const COMMANDS = {
  hook: { run: (a) => hook(a), quiet: true },
  check: { run: check, quiet: true },
  failed: { run: failed, quiet: true },
  list: { run: list },
  resume: { run: resume },
  auto: { run: auto },
  adopt: { run: adopt },
  install: { run: (a) => install(a) },
  uninstall: { run: (a) => install(a, true) },
  doctor: { run: doctor },
};

async function main() {
  const [name, ...args] = process.argv.slice(2);
  const cmd = COMMANDS[name];
  if (!cmd) {
    process.stderr.write(`usage: revive.mjs ${Object.keys(COMMANDS).join("|")}\n`);
    process.exit(2);
  }
  try {
    await cmd.run(args);
  } catch (err) {
    if (cmd.quiet) return;
    process.stderr.write(`${err?.message ?? err}\n`);
    process.exit(1);
  }
}

// Run as a program, not when the tests import it (a linked mod folder resolves through the link).
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
if (process.argv[1] && real(ENGINE) === real(process.argv[1])) await main();
