import { powerShellArgs } from "./windows/powershell.mjs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ContractError } from "../contracts/manager.mjs";
import { safePath } from "../core/local-files.mjs";
import { durableJson, privateDirectory } from "../core/write-files.mjs";
import { transactionProcess } from "./transaction-process.mjs";
import type { LibraryTransaction, LibraryTransactions } from "../core/library-transactions.mjs";

export async function recycleTransaction(journals: LibraryTransactions, value: LibraryTransaction): Promise<void> {
  if (!value.stage || !value.theme || value.theme.source !== "preset" || !value.stage.name.startsWith(".manager-library-delete-")) throw new ContractError("THEME_INVALID", "Invalid preset recycling transaction.");
  const directory = path.join(journals.state, "manager-operations", "trash-requests"); await privateDirectory(directory);
  const request = path.join(directory, randomUUID() + ".json");
  await durableJson(request, directory, { schemaVersion: 1, applicationRoot: journals.applicationRoot, location: value.stage.location, name: value.stage.name }, true);
  const windows = journals.platform === "windows", script = path.join(journals.applicationRoot, windows ? "windows" : "macos", "scripts", windows ? "manager-trash.ps1" : "manager-trash-macos.js");
  await safePath(script, journals.applicationRoot);
  const system = process.env.SystemRoot; if (windows && (!system || !path.isAbsolute(system))) throw new ContractError("BACKEND_UNAVAILABLE", "The native recycling adapter is unavailable.");
  const executable = windows ? path.join(system!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "/usr/bin/osascript";
  const args = windows ? await powerShellArgs(journals.applicationRoot, script, ["-RequestPath", request]) : ["-l", "JavaScript", script, request];
  const result = await transactionProcess(executable, args, 120000, true);
  if (result.recycled !== true) throw new ContractError("IO_ERROR", "The preset remains isolated because recycling did not complete.");
}
