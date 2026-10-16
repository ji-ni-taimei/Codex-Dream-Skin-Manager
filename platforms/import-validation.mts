import { powerShellArgs } from "./windows/powershell.mjs";
import path from "node:path";
import { ContractError } from "../contracts/manager.mjs";
import { safePath } from "../core/local-files.mjs";
import { transactionProcess } from "./transaction-process.mjs";

export async function validateImportMedia(root: string, file: string): Promise<void> {
  const windows = process.platform === "win32";
  const script = path.join(root, windows ? "windows" : "macos", "scripts", windows ? "manager-validate-media.ps1" : "validate-image-macos.mjs");
  await safePath(script, root);
  const system = process.env.SystemRoot;
  if (windows && (!system || !path.isAbsolute(system))) throw new ContractError("BACKEND_UNAVAILABLE", "The native media validator is unavailable.");
  const executable = windows ? path.join(system!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : process.execPath;
  const args = windows ? await powerShellArgs(root, script, ["-MediaPath", file]) : [script, file];
  try { await transactionProcess(executable, args, 120000, false); }
  catch { throw new ContractError("MEDIA_UNSUPPORTED", "Media validation or real video decoding failed. Video import requires an existing compatible Codex renderer connection."); }
}
