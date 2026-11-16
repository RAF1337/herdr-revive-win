// Which tests run where. Upstream's suite fakes agents, hc and shells with
// shebang scripts and `sh`, links files, listens on Unix sockets and points
// HOME at scratch folders: none of that works on Windows, where those tests
// are skipped. The Windows layer has tests of its own.
export const POSIX_ONLY = process.platform === "win32" ? "needs POSIX tools (sh, ps, chmod, symlinks)" : false;
export const WINDOWS_ONLY = process.platform === "win32" ? false : "Windows only";
