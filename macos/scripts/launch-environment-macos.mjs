import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const profileKeys = ["HOME", "CFFIXED_USER_HOME", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"];

async function directory(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid profile directory.");
  const real = await fs.realpath(value);
  if (/[\x00-\x1f\x7f]/.test(real)) throw new Error("Invalid profile directory.");
  if (!(await fs.stat(real)).isDirectory()) throw new Error("Profile directory is unavailable.");
  return real;
}

export async function validateLaunchEnvironment(environment, accountHome) {
  if (environment.DREAMSKIN_PREVIEW === "1") throw new Error("Preview mode cannot control Codex.");
  const home = await directory(accountHome);
  if (await directory(environment.HOME) !== home || environment.CFFIXED_USER_HOME !== undefined && await directory(environment.CFFIXED_USER_HOME) !== home) {
    throw new Error("The manager is using an isolated home; Codex was not changed.");
  }
  const codexHome = await directory(environment.CODEX_HOME === undefined ? path.join(home, ".codex") : environment.CODEX_HOME);
  return { home, codexHome };
}

export function parseProcessEnvironment(text) {
  // ps does not escape values. Reject duplicate relevant assignments rather
  // than guessing a profile from ambiguous command arguments or environment.
  const entries = [...text.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)];
  const result = {};
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index], key = entry[1];
    if (!profileKeys.includes(key)) continue;
    if (Object.hasOwn(result, key)) throw new Error("The running Codex profile is ambiguous.");
    result[key] = text.slice(entry.index + entry[0].length, entries[index + 1]?.index ?? text.length).trimEnd();
  }
  if (!result.HOME) throw new Error("The running Codex home could not be inspected.");
  return result;
}

export async function assertSameProfile(expected, observedEnvironment, environment = {}) {
  const observed = await validateLaunchEnvironment(observedEnvironment, expected.home);
  if (observed.codexHome !== expected.codexHome) throw new Error("Codex is using a different CODEX_HOME; restart was refused.");
  for (const key of profileKeys.filter(key => key.startsWith("XDG_"))) {
    if ((environment[key] ?? "") !== (observedEnvironment[key] ?? "")) throw new Error("Codex is using different application-data settings; restart was refused.");
  }
}

async function inspect(executable, pids, environment) {
  const expected = await validateLaunchEnvironment(environment, os.userInfo().homedir);
  const target = await fs.realpath(executable);
  for (const pid of pids) {
    if (!/^[1-9][0-9]*$/.test(pid)) throw new Error("Invalid Codex process identity.");
    const { stdout: command } = await run("/bin/ps", ["-p", pid, "-o", "comm="], { timeout: 5000 });
    if (await fs.realpath(command.trim()) !== target) throw new Error("The Codex process changed; restart was refused.");
    const { stdout } = await run("/bin/ps", ["eww", "-p", pid, "-o", "command="], { timeout: 5000, maxBuffer: 1024 * 1024 });
    if (/--(?:user-data-dir|profile-directory)(?:=|\s)/.test(stdout)) throw new Error("Codex has custom profile arguments; restart was refused.");
    await assertSameProfile(expected, parseProcessEnvironment(stdout), environment);
  }
  return expected;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, executable, ...pids] = process.argv.slice(2);
    if (action !== "check" || !executable || !path.isAbsolute(executable)) throw new Error("Invalid launch environment check.");
    const result = await inspect(executable, pids, process.env);
    process.stdout.write(`${result.home}\t${result.codexHome}\n`);
  } catch (error) {
    process.stderr.write(`DREAM_SKIN_ENVIRONMENT_MISMATCH: ${error.message}\n`);
    process.exitCode = 1;
  }
}
