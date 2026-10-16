import { createHash } from "node:crypto";
import { record } from "../contracts/manager.mjs";

// Arguments are produced only by the fixed native platform script.
try {
  const [portText, executable, processes, browserText, paused, watcherVerified] = process.argv.slice(2);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !executable || processes === undefined || browserText === undefined || !["true", "false"].includes(paused ?? "")) throw new Error();
  let browser: string | null = null;
  if (browserText) {
    const value: unknown = JSON.parse(browserText);
    if (!record(value) || typeof value.webSocketDebuggerUrl !== "string") throw new Error();
    const url = new URL(value.webSocketDebuggerUrl);
    if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || Number(url.port) !== port ||
        url.username || url.password || url.search || url.hash || !/^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(url.pathname)) throw new Error();
    browser = url.pathname;
  }
  const runtime = { executable, processes, browser, port };
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  process.stdout.write(JSON.stringify({ fingerprint: digest({ runtime, paused }), runtimeSessionId: browser ? digest(runtime) : null,
    startRequired: !browser, recoveryRequired: false, watcherVerified: watcherVerified === "true", processRunning: processes.trim().length > 0, paused: paused === "true", port }) + "\n");
} catch { process.stderr.write("BACKEND_UNAVAILABLE: The macOS runtime identity could not be inspected.\n"); process.exitCode = 1; }
