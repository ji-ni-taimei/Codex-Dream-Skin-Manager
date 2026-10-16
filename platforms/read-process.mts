import { spawn } from "node:child_process";
import { ContractError } from "../contracts/manager.mjs";
import { jsonObject } from "../core/local-files.mjs";

// Only adapters choose executable/argv. No frontend or protocol field reaches here.
export function readProcess(executable: string, args: readonly string[], env = process.env): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0, settled = false;
    const finish = (error: unknown, result?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new ContractError("TIMEOUT", "The platform status probe timed out.", true));
    }, 15000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 1024 * 1024) {
        child.kill(); finish(new ContractError("BACKEND_UNAVAILABLE", "The platform status response exceeded its limit."));
      } else if (!settled) chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 256 * 1024) {
        child.kill(); finish(new ContractError("BACKEND_UNAVAILABLE", "The platform status diagnostics exceeded their limit."));
      }
    });
    child.on("error", () => finish(new ContractError("BACKEND_UNAVAILABLE", "The platform status probe could not start.", true)));
    child.on("close", code => {
      if (settled) return;
      if (code !== 0) { finish(new ContractError("BACKEND_UNAVAILABLE", "The platform status probe failed.", true)); return; }
      try { finish(null, jsonObject(Buffer.concat(chunks))); }
      catch { finish(new ContractError("BACKEND_UNAVAILABLE", "The platform status response was invalid.", true)); }
    });
  });
}
