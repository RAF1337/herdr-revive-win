// The end-to-end test's stand-in for claude.exe: a real program named claude
// that runs fake-claude.cjs with Node and the same arguments, on the same
// console. Compiled by test/e2e/windows-e2e.mjs with Windows PowerShell's
// Add-Type; never installed anywhere.
using System;
using System.Diagnostics;
using System.Linq;

class ClaudeLauncher {
  static int Main(string[] args) {
    string node = Environment.GetEnvironmentVariable("FAKE_CLAUDE_NODE");
    string script = Environment.GetEnvironmentVariable("FAKE_CLAUDE_SCRIPT");
    string quoted = string.Join(" ", new[] { script }.Concat(args).Select(a => "\"" + a.Replace("\"", "\\\"") + "\""));
    var info = new ProcessStartInfo(node, quoted) { UseShellExecute = false };
    using (var p = Process.Start(info)) {
      p.WaitForExit();
      return p.ExitCode;
    }
  }
}
