// The end-to-end test's stand-in for claude.exe and codex.exe: a real program
// named claude (or codex) that runs a script with Node and the same
// arguments, on the same console. The script is FAKE_CLAUDE_SCRIPT, or
// FAKE_CODEX_SCRIPT when this program is named codex. Compiled by
// test/e2e/windows-e2e.mjs with Windows PowerShell's Add-Type; never
// installed anywhere.
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;

class ClaudeLauncher {
  static int Main(string[] args) {
    string name = Path.GetFileNameWithoutExtension(Process.GetCurrentProcess().MainModule.FileName).ToUpperInvariant();
    string node = Environment.GetEnvironmentVariable("FAKE_CLAUDE_NODE");
    string script = Environment.GetEnvironmentVariable("FAKE_" + name + "_SCRIPT") ?? Environment.GetEnvironmentVariable("FAKE_CLAUDE_SCRIPT");
    string quoted = string.Join(" ", new[] { script }.Concat(args).Select(a => "\"" + a.Replace("\"", "\\\"") + "\""));
    var info = new ProcessStartInfo(node, quoted) { UseShellExecute = false };
    using (var p = Process.Start(info)) {
      p.WaitForExit();
      return p.ExitCode;
    }
  }
}
