import { powerShellArgs } from "./windows/powershell.mjs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { ContractError, confirmationCopy, ERROR_CODES, parseThemeRef, record, RECOVERY_ACTIONS, validOperationId } from "../contracts/manager.mjs";
import type { ConfirmedLibraryCommand, ManagerError, RecoveryPage, ThemeCreateCommand, ThemeEditCommand, ThemePackageCommand } from "../contracts/manager.mjs";
import type { SourceSnapshot, SnapshotFile } from "../core/source-snapshots.mjs";
import type { LibraryChallenge, LibraryOutcome, LibraryPort } from "../core/ports/library.mjs";
import { safePath } from "../core/local-files.mjs";
import { durableJson, privateDirectory } from "../core/write-files.mjs";
import { transactionProcess } from "./transaction-process.mjs";

export class PlatformLibrary implements LibraryPort {
  constructor(private readonly root: string, private readonly state: string) {}
  async edit(command: ThemeEditCommand): Promise<LibraryOutcome> {
    return this.invoke(command);
  }
  async create(command: ThemeCreateCommand, source: SourceSnapshot): Promise<LibraryOutcome> {
    return this.invoke(command, source);
  }
  async importPackage(command: ThemePackageCommand, source: SnapshotFile): Promise<LibraryOutcome> { return this.invoke(command, source); }
  async propose(command: ConfirmedLibraryCommand): Promise<LibraryChallenge> {
    const value = await this.call({ command, action: "propose" }, 45000, true); this.rejectError(value);
    const challenge = value.challenge;
    if (!record(challenge) || typeof challenge.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(challenge.fingerprint) ||
        typeof challenge.revision !== "string" || !/^[a-f0-9]{64}$/.test(challenge.revision) || typeof challenge.reason !== "string" || challenge.reason.length > 512 || typeof challenge.impact !== "string" || challenge.impact.length > 1024) throw new ContractError("BACKEND_UNAVAILABLE", "Invalid library confirmation result.");
    parseThemeRef(challenge.theme);
    if (challenge.copy !== undefined) {
      const copy = confirmationCopy(challenge.copy);
      if (copy) challenge.copy = copy; else delete challenge.copy;
    }
    return challenge as unknown as LibraryChallenge;
  }
  async executeConfirmed(command: ConfirmedLibraryCommand, fingerprint: string): Promise<LibraryOutcome> { return this.invoke(command, undefined, fingerprint); }
  async recoveries(): Promise<RecoveryPage> {
    const value = await this.call({ action: "recoveries" }, 180000, true); this.rejectError(value);
    if (!Array.isArray(value.entries) || value.entries.length > 4096 || !Array.isArray(value.warnings)) throw new ContractError("BACKEND_UNAVAILABLE", "Invalid recovery list.");
    for (const entry of value.entries) {
      if (!record(entry) || !validOperationId(entry.transactionId) || typeof entry.revision !== "string" || !/^[a-f0-9]{64}$/.test(entry.revision) ||
          typeof entry.method !== "string" || typeof entry.phase !== "string" || typeof entry.message !== "string" || !Array.isArray(entry.actions) || entry.actions.some(action => !(RECOVERY_ACTIONS as readonly unknown[]).includes(action))) throw new ContractError("BACKEND_UNAVAILABLE", "Invalid recovery entry.");
      if (entry.theme !== null) parseThemeRef(entry.theme);
    }
    return value as unknown as RecoveryPage;
  }
  async receipt(id: string, method?: string, expectedRevision?: string): Promise<LibraryOutcome | null> {
    if (!validOperationId(id)) throw new ContractError("INVALID_REQUEST", "Invalid library receipt identity.");
    if (!method || !expectedRevision) return null;
    const value = await this.call({ action: "receipt", transactionId: id, method, expectedRevision }, 45000, true); this.rejectError(value);
    if (value.outcome === null) return null;
    if (!record(value.outcome)) throw new ContractError("BACKEND_UNAVAILABLE", "Invalid library receipt."); return this.outcome(value.outcome);
  }
  private rejectError(value: Record<string, unknown>) {
    if (record(value.error) && (ERROR_CODES as readonly unknown[]).includes(value.error.code) && typeof value.error.message === "string") throw new ContractError(value.error.code as ManagerError["code"], value.error.message);
  }
  private async call(payload: Record<string, unknown>, timeout: number, ephemeral = false): Promise<Record<string, unknown>> {
    const windows = process.platform === "win32";
    const directory = path.join(this.state, "manager-operations", "library-requests"); await privateDirectory(directory);
    const request = path.join(directory, randomUUID() + ".json");
    await durableJson(request, directory, { schemaVersion: 1, ...payload }, true);
    const script = path.join(this.root, windows ? "windows" : "macos", "scripts", windows ? "manager-library.ps1" : "manager-library.sh");
    await safePath(script, this.root);
    const system = process.env.SystemRoot;
    if (windows && (!system || !path.isAbsolute(system))) throw new ContractError("BACKEND_UNAVAILABLE", "Windows system directory is unavailable.");
    const executable = windows ? path.join(system!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "/bin/bash";
    const args = windows ? await powerShellArgs(this.root, script, ["-ApplicationRoot", this.root, "-RequestPath", request]) : [script, this.root, request];
    let completed = ephemeral;
    try {
      const result = await transactionProcess(executable, args, timeout, true);
      if (result.libraryChanged === false || result.libraryChanged === true) completed = true;
      return result;
    }
    finally { if (completed) { try { await unlink(request); } catch { } } }
  }
  private async invoke(command: ThemeEditCommand | ThemeCreateCommand | ThemePackageCommand | ConfirmedLibraryCommand, source?: SourceSnapshot | SnapshotFile, fingerprint?: string): Promise<LibraryOutcome> {
    const value = await this.call({ command, ...(source ? { source } : {}), ...(fingerprint ? { fingerprint } : {}) }, command.method === "themes.importPackage" || command.method === "library.recover" ? 360000 : 180000);
    const outcome = this.outcome(value), theme = outcome.resultTheme;
    if ((command.method === "themes.create" || command.method === "themes.importPackage") && !["created", "duplicate", null].includes(value.disposition as string | null)) throw new ContractError("BACKEND_UNAVAILABLE", "Invalid import disposition.");
    if (theme && (command.method === "library.recover" ? false : command.method === "themes.update" || command.method === "themes.delete" ? theme.source !== command.params.theme.source || theme.id !== command.params.theme.id
      : theme.source !== "saved" || (value.disposition !== "duplicate" && theme.id !== "custom-" + command.params.operationId.split(":")[1]))) throw new ContractError("BACKEND_UNAVAILABLE", "The library result identity did not match the request.");
    return outcome;
  }
  private outcome(value: Record<string, unknown>): LibraryOutcome {
    if (![true, false, null].includes(value.libraryChanged as boolean | null) ||
        (value.resultRevision !== null && (typeof value.resultRevision !== "string" || !/^[a-f0-9]{64}$/.test(value.resultRevision))) ||
        (value.error !== null && (!record(value.error) || !(ERROR_CODES as readonly unknown[]).includes(value.error.code) ||
          typeof value.error.message !== "string" || value.error.message.length > 1024 || typeof value.error.retryable !== "boolean"))) {
      throw new ContractError("BACKEND_UNAVAILABLE", "Invalid library transaction result.");
    }
    const theme = value.resultTheme === null ? null : parseThemeRef(value.resultTheme);
    if ((value.deleted !== undefined && ![true, false, null].includes(value.deleted as boolean | null)) ||
        (value.cleanupPending !== undefined && ![true, false, null].includes(value.cleanupPending as boolean | null)) ||
        (value.recoveryCompleted !== undefined && typeof value.recoveryCompleted !== "boolean") ||
        (value.disposition !== undefined && !["created", "duplicate", null].includes(value.disposition as string | null))) throw new ContractError("BACKEND_UNAVAILABLE", "Invalid recovery or deletion result.");
    return { libraryChanged: value.libraryChanged as boolean | null, resultTheme: theme, resultRevision: value.resultRevision as string | null,
      error: value.error as ManagerError | null,
      ...(value.disposition !== undefined ? { disposition: value.disposition as "created" | "duplicate" | null } : {}),
      ...(value.deleted !== undefined ? { deleted: value.deleted as boolean | null } : {}),
      ...(value.cleanupPending !== undefined ? { cleanupPending: value.cleanupPending as boolean | null } : {}),
      ...(value.recoveryCompleted !== undefined ? { recoveryCompleted: value.recoveryCompleted as boolean } : {}) };
  }
}
