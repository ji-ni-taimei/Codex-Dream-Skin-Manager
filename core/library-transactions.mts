import { pruneHistory } from "./history-retention.mjs";
import path from "node:path";
import { createHash } from "node:crypto";
import { lstat, readdir, rename } from "node:fs/promises";
import { ContractError, ERROR_CODES, parseThemeRef, record, validOperationId } from "../contracts/manager.mjs";
import type { ThemeRef } from "../contracts/manager.mjs";
import type { LibraryOutcome } from "./ports/library.mjs";
import { fileBytes, jsonObject, optionalBytes, safePath, sha256 } from "./local-files.mjs";
import { durableJson, privateDirectory, syncDirectory } from "./write-files.mjs";
import { assertTree, parseTree, treeSnapshot } from "./managed-tree.mjs";
import type { TreeSnapshot } from "./managed-tree.mjs";
import { canonicalJson } from "./theme-edit.mjs";
import { byteHash } from "./source-snapshots.mjs";

export type Location = "library" | "state" | "presets";
export interface LibraryTransaction {
  expectedRevision?: string;
  schemaVersion: 1; operationId: string; method: string; phase: "intent" | "prepared" | "committing" | "committed" | "removed" | "final" | "discarded";
  theme: ThemeRef | null; updatedAt: string; stage: { location: Location; name: string } | null; tree: TreeSnapshot | null;
  targetFile: { location: Location; name: string; hash: string } | null;
  activeConfig?: { name: string; hash: string };
  deletion: { kind: "directory" | "catalog"; originalName: string; catalogHash: string | null; catalogAfter: Record<string, unknown> | null } | null;
  outcome: LibraryOutcome | null;
}
export class LibraryTransactions {
  readonly directory: string;
  constructor(readonly state: string, readonly applicationRoot: string, readonly platform: "windows" | "macos") { this.directory = path.join(state, "manager-operations", "library-transactions"); }
  root(location: Location): string { return location === "library" ? path.join(this.state, "themes") : location === "state" ? this.state : path.join(this.applicationRoot, "windows", "presets"); }
  file(id: string): string {
    if (!validOperationId(id)) throw new ContractError("INVALID_REQUEST", "Invalid transaction identity.");
    return path.join(this.directory, createHash("sha256").update(id).digest("hex") + ".json");
  }
  stage(value: LibraryTransaction): string {
    if (!value.stage || !/^\.manager-(?:import|copy|package|library-delete)-[a-f0-9-]{36}$/.test(value.stage.name)) throw new ContractError("IO_ERROR", "Invalid transaction stage identity.");
    return path.join(this.root(value.stage.location), value.stage.name);
  }
  async read(id: string): Promise<LibraryTransaction | null> {
    const bytes = await optionalBytes(this.file(id), this.directory, 3 * 1024 * 1024); if (!bytes) return null;
    const value = jsonObject(bytes);
    if (value.schemaVersion !== 1 || value.operationId !== id || !["themes.update", "themes.copy", "themes.create", "themes.importPackage", "themes.delete", "library.recover"].includes(String(value.method)) ||
        !["intent", "prepared", "committing", "committed", "removed", "final", "discarded"].includes(String(value.phase)) ||
        typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)) ||
        (value.stage !== null && (!record(value.stage) || !["library", "state", "presets"].includes(String(value.stage.location)) || typeof value.stage.name !== "string" || !/^\.manager-(?:import|copy|package|library-delete)-[a-f0-9-]{36}$/.test(value.stage.name)))) throw new ContractError("IO_ERROR", "Invalid library transaction provenance.");
    if (value.expectedRevision !== undefined && (typeof value.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedRevision))) throw new ContractError("IO_ERROR", "Invalid library receipt revision.");
    if (value.theme !== null) parseThemeRef(value.theme); if (value.tree !== null) parseTree(value.tree);
    if (value.targetFile !== null && (!record(value.targetFile) || !["library", "state", "presets"].includes(String(value.targetFile.location)) ||
        typeof value.targetFile.name !== "string" || !/^(?:themes\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/theme\.json|preset-settings\/preset-[A-Za-z0-9._-]+\.json)$/.test(value.targetFile.name) ||
        typeof value.targetFile.hash !== "string" || !/^[a-f0-9]{64}$/.test(value.targetFile.hash))) throw new ContractError("IO_ERROR", "Invalid configuration transaction target.");
    if (value.deletion !== null && (!record(value.deletion) || !["directory", "catalog"].includes(String(value.deletion.kind)) ||
        typeof value.deletion.originalName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(value.deletion.originalName) ||
        (value.deletion.catalogHash !== null && (typeof value.deletion.catalogHash !== "string" || !/^[a-f0-9]{64}$/.test(value.deletion.catalogHash))) ||
        (value.deletion.catalogAfter !== null && !record(value.deletion.catalogAfter)))) throw new ContractError("IO_ERROR", "Invalid deletion transaction provenance.");
    const prefix = value.method === "themes.create" ? "import" : value.method === "themes.copy" ? "copy" : value.method === "themes.importPackage" ? "package" : value.method === "themes.delete" ? "library-delete" : null;
    if (value.stage !== null) {
      const stage = value.stage as Record<string, unknown>, theme = parseThemeRef(value.theme);
      const expectedLocation = prefix === "library-delete" ? this.platform === "windows" && theme.source === "preset" ? "presets" : "state" : "library";
      if (!prefix || stage.name !== `.manager-${prefix}-${id.split(":")[1]}` || stage.location !== expectedLocation ||
          prefix !== "library-delete" && (theme.source !== "saved" || theme.id !== "custom-" + id.split(":")[1])) throw new ContractError("IO_ERROR", "The transaction stage is not bound to its operation.");
    }
    if (value.targetFile !== null) {
      const target = value.targetFile as Record<string, unknown>, theme = parseThemeRef(value.theme);
      const expected = this.platform === "windows" && theme.source === "preset" ? `preset-settings/${theme.id}.json` : `themes/${theme.id}/theme.json`;
      if (value.method !== "themes.update" || target.location !== "state" || target.name !== expected) throw new ContractError("IO_ERROR", "The configuration target is not bound to its theme.");
    }
    if (value.activeConfig !== undefined && (!record(value.activeConfig) || value.method !== "themes.update" || value.targetFile === null ||
        value.activeConfig.name !== (this.platform === "windows" ? "active-theme/theme.json" : "theme/theme.json") ||
        typeof value.activeConfig.hash !== "string" || !/^[a-f0-9]{64}$/.test(value.activeConfig.hash))) throw new ContractError("IO_ERROR", "Invalid paused configuration target.");
    if (value.deletion !== null) {
      const deletion = value.deletion as Record<string, unknown>, theme = parseThemeRef(value.theme);
      if (value.method !== "themes.delete" || value.stage === null || value.tree === null ||
          (deletion.kind === "directory" ? deletion.originalName !== theme.id || deletion.catalogHash !== null || deletion.catalogAfter !== null :
            this.platform !== "windows" || theme.source !== "preset" || typeof deletion.catalogHash !== "string" || !record(deletion.catalogAfter) || !Array.isArray(deletion.catalogAfter.themes))) throw new ContractError("IO_ERROR", "The deletion source is not bound to its theme.");
    }
    if (value.outcome !== null) {
      const outcome = value.outcome;
      if (!record(outcome) || ![true, false, null].includes(outcome.libraryChanged as boolean | null) ||
          (outcome.resultRevision !== null && (typeof outcome.resultRevision !== "string" || !/^[a-f0-9]{64}$/.test(outcome.resultRevision))) ||
          (outcome.error !== null && (!record(outcome.error) || !(ERROR_CODES as readonly unknown[]).includes(outcome.error.code) || typeof outcome.error.message !== "string" || typeof outcome.error.retryable !== "boolean")) ||
          (outcome.deleted !== undefined && ![true, false, null].includes(outcome.deleted as boolean | null)) ||
          (outcome.cleanupPending !== undefined && ![true, false, null].includes(outcome.cleanupPending as boolean | null)) ||
          (outcome.recoveryCompleted !== undefined && typeof outcome.recoveryCompleted !== "boolean") ||
          (outcome.disposition !== undefined && !["created", "duplicate", null].includes(outcome.disposition as string | null))) throw new ContractError("IO_ERROR", "Invalid transaction outcome.");
      if (outcome.resultTheme !== null) parseThemeRef(outcome.resultTheme);
    }
    return value as unknown as LibraryTransaction;
  }
  async begin(id: string, method: string, theme: ThemeRef | null = null, expectedRevision?: string): Promise<LibraryTransaction> {
    if (await this.read(id)) throw new ContractError("OPERATION_CONFLICT", "The library transaction already exists; use explicit recovery.");
    await privateDirectory(this.directory); await pruneHistory(this.directory, ["final", "discarded"], true);
    const value: LibraryTransaction = { schemaVersion: 1, operationId: id, method, phase: "intent", theme, updatedAt: new Date().toISOString(), stage: null, tree: null, targetFile: null, deletion: null, outcome: null };
    const prefix = method === "themes.create" ? "import" : method === "themes.copy" ? "copy" : method === "themes.importPackage" ? "package" : null;
    if (prefix) { value.stage = { location: "library", name: `.manager-${prefix}-${id.split(":")[1]}` }; value.theme = { source: "saved", id: "custom-" + id.split(":")[1] }; }
    if (expectedRevision) value.expectedRevision = expectedRevision;
    await durableJson(this.file(id), this.directory, value, true); return value;
  }
  async write(value: LibraryTransaction): Promise<void> { value.updatedAt = new Date().toISOString(); await durableJson(this.file(value.operationId), this.directory, value); }
  async publish(id: string, stage: string, theme: ThemeRef): Promise<void> {
    const value = await this.read(id); if (!value) throw new ContractError("IO_ERROR", "The transaction intent is missing.");
    const library = this.root("library"), destination = path.join(library, theme.id);
    if (path.dirname(stage) !== library || theme.source !== "saved") throw new ContractError("THEME_INVALID", "Invalid import publication target.");
    value.theme = theme; value.stage = { location: "library", name: path.basename(stage) }; this.stage(value);
    value.tree = await treeSnapshot(stage); value.phase = "prepared"; await this.write(value);
    await this.publishRecorded(value, destination);
  }
  async publishRecorded(value: LibraryTransaction, destination = path.join(this.root("library"), value.theme!.id)): Promise<void> {
    if (!value.tree || !value.theme || value.theme.source !== "saved" || value.stage?.location !== "library" || value.deletion) throw new ContractError("IO_ERROR", "The import transaction lacks a complete prepared tree.");
    await assertTree(this.stage(value), value.tree); await safePath(path.dirname(destination), this.state);
    try { await lstat(destination); throw new ContractError("OPERATION_CONFLICT", "The publication target already exists."); }
    catch (error) { if (!record(error) || error.code !== "ENOENT") throw error; }
    value.phase = "committing"; await this.write(value); await syncDirectory(this.stage(value));
    await rename(this.stage(value), destination); await syncDirectory(path.dirname(destination)); value.phase = "committed"; await this.write(value);
  }
  async config(id: string, file: string, config: Record<string, unknown>, theme: ThemeRef, active?: { file: string; config: Record<string, unknown> }): Promise<void> {
    const value = await this.read(id); if (!value) throw new ContractError("IO_ERROR", "The configuration intent is missing.");
    value.theme = theme; value.targetFile = { location: "state", name: path.relative(this.state, file).split(path.sep).join("/"), hash: byteHash(Buffer.from(JSON.stringify(config) + "\n")) };
    if (!/^(?:themes\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/theme\.json|preset-settings\/preset-[A-Za-z0-9._-]+\.json)$/.test(value.targetFile.name)) throw new ContractError("THEME_INVALID", "Invalid configuration transaction path.");
    if (active) {
      const name = path.relative(this.state, active.file).split(path.sep).join("/");
      if (name !== (this.platform === "windows" ? "active-theme/theme.json" : "theme/theme.json")) throw new ContractError("THEME_INVALID", "Invalid paused configuration path.");
      value.activeConfig = { name, hash: byteHash(Buffer.from(JSON.stringify(active.config) + "\n")) };
    }
    value.phase = "committing"; await this.write(value);
    await durableJson(file, this.state, config);
    if (active) await durableJson(active.file, this.state, active.config);
    value.phase = "committed"; await this.write(value);
  }
  async finish(id: string, outcome: LibraryOutcome): Promise<void> {
    const value = await this.read(id); if (!value) throw new ContractError("IO_ERROR", "The transaction intent is missing.");
    value.outcome = outcome; value.theme ??= outcome.resultTheme;
    if (!outcome.error && outcome.cleanupPending !== true) value.phase = "final";
    await this.write(value);
  }
  revision(value: LibraryTransaction): string { return sha256([Buffer.from(canonicalJson(value))]); }
  async all(): Promise<LibraryTransaction[]> {
    let names: string[];
    try { await safePath(this.directory, this.state); names = await readdir(this.directory); }
    catch (error) { if (record(error) && error.code === "ENOENT") return []; throw error; }
    const result: LibraryTransaction[] = [];
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const raw = jsonObject(await fileBytes(path.join(this.directory, name), this.directory, 3 * 1024 * 1024));
      if (!validOperationId(raw.operationId) || path.basename(this.file(raw.operationId)) !== name) throw new ContractError("IO_ERROR", "Invalid recovery transaction identity.");
      const value = await this.read(raw.operationId); if (value) result.push(value);
    }
    return result;
  }
}
