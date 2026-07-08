import { type ChildProcess, execSync, spawn } from "node:child_process";

/**
 * Spawns the BullMQ worker for the duration of the e2e run. Playwright's
 * webServer handles the web app; the worker has no HTTP surface, so it is
 * managed here. A second worker alongside a dev one is harmless — ingestion
 * and detection are idempotent by design (invariant 4).
 */
export default function globalSetup(): () => void {
  const worker: ChildProcess = spawn("npm", ["run", "worker"], {
    cwd: __dirname + "/..",
    shell: true,
    stdio: "ignore",
  });

  return () => {
    if (worker.pid === undefined) return;
    if (process.platform === "win32") {
      // worker.kill() only reaches the npm shim; kill the whole tree so the
      // tsx/node children don't linger and hold the Redis connection.
      try {
        execSync(`taskkill /pid ${worker.pid} /T /F`, { stdio: "ignore" });
      } catch {
        // Already exited.
      }
    } else {
      worker.kill("SIGTERM");
    }
  };
}
