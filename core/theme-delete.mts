import path from "node:path";
import { lstat, mkdir, rename } from "node:fs/promises";
import { ContractError, failure, record } from "../contracts/manager.mjs";
import type { ThemeDeleteCommand } from "../contracts/manager.mjs";
import type { PlatformPort } from "./ports/platform.mjs";
import type { LibraryChallenge, LibraryOutcome } from "./ports/library.mjs";
import { assertDeletionAllowed, deletionContext } from "./deletion-policy.mjs";
import { assertTree, removeTree, treeSnapshot } from "./managed-tree.mjs";
import { fileBytes, jsonObject, leaf, optionalBytes, safePath, sha256 } from "./local-files.mjs";
import { themeDetails } from "./theme-model.mjs";
import { canonicalJson } from "./theme-edit.mjs";
import { durableJson, privateDirectory, syncDirectory } from "./write-files.mjs";
import { LibraryTransactions } from "./library-transactions.mjs";
import type { LibraryTransaction } from "./library-transactions.mjs";
import { byteHash } from "./source-snapshots.mjs";

export async function prepareDeletion(journals: LibraryTransactions, adapter: PlatformPort, command: ThemeDeleteCommand) {
  const inventory = await adapter.inventory(), ref = command.params.theme;
  const local = inventory.themes.find(theme => theme.ref.source === ref.source && theme.ref.id === ref.id);
  if (!local) throw new ContractError("THEME_NOT_FOUND", "The theme is no longer available.");
  const details = await themeDetails(local); if (details.revision !== command.params.expectedRevision) throw new ContractError("THEME_CHANGED", "Refresh this theme before confirming deletion.");
  const context = await deletionContext(journals.state, adapter, command.params.operationId, inventory, journals); assertDeletionAllowed(ref, context);
  let directory: string | null = local.mediaRoot, deletion: LibraryTransaction["deletion"];
  if (journals.platform === "windows" && ref.source === "preset" && path.resolve(local.mediaRoot) === journals.root("presets")) {
    const bytes = await optionalBytes(path.join(local.mediaRoot, "catalog.json"), local.mediaRoot, 1024 * 1024);
    if (!bytes) throw new ContractError("THEME_INVALID", "Deleting an uncatalogued flat preset requires the existing manager.");
    const catalog = jsonObject(bytes); if (!Array.isArray(catalog.themes)) throw new ContractError("THEME_INVALID", "Invalid preset catalog.");
    if (catalog.themes.some(item => !record(item) || typeof item.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,72}$/.test(item.id) || typeof item.image !== "string")) throw new ContractError("THEME_INVALID", "Invalid preset catalog entry.");
    const entries = catalog.themes.filter(record), entry = entries.find(entry => "preset-" + String(entry.id) === ref.id);
    if (new Set(entries.map(item => item.id)).size !== entries.length) throw new ContractError("THEME_INVALID", "Ambiguous preset catalog identity.");
    if (!entry || entries.filter(item => item.image === entry.image).length !== 1 || local.mediaPath !== path.join(local.mediaRoot, leaf(entry.image))) throw new ContractError("THEME_PROTECTED", "A shared or ambiguous preset background cannot be deleted.");
    deletion = { kind: "catalog", originalName: leaf(entry.image), catalogHash: byteHash(bytes), catalogAfter: { ...catalog, themes: entries.filter(value => value !== entry) } };
    directory = null;
  } else {
    const root = ref.source === "preset" && journals.platform === "windows" ? journals.root("presets") : journals.root("library");
    if (path.resolve(local.mediaRoot) !== path.join(root, ref.id)) throw new ContractError("THEME_INVALID", "The theme is outside the deletable library.");
    deletion = { kind: "directory", originalName: ref.id, catalogHash: null, catalogAfter: null };
  }
  const tree = directory ? await treeSnapshot(directory) : { files: [{ name: deletion!.originalName, bytes: (await lstat(local.mediaPath)).size, hash: byteHash(await fileBytes(local.mediaPath, local.mediaRoot, 128 * 1024 * 1024)) }], directories: [] };
  if ((await themeDetails(local)).revision !== details.revision) throw new ContractError("THEME_CHANGED", "The theme changed while preparing deletion.");
  const fingerprint = sha256([Buffer.from(canonicalJson({ ref, revision: details.revision, tree, deletion, context }))]);
  const challenge: LibraryChallenge = { fingerprint, theme: ref, revision: details.revision, reason: `删除“${details.name}”？`, copy: { kind: ref.source === "preset" ? "deletePreset" : "deleteSaved", subject: details.name },
    impact: ref.source === "preset" ? "内置主题及其素材将移入系统回收站或废纸篓。若清理失败，会保留隔离素材供恢复。" : "自定义主题及其本地素材将永久删除，无法撤销。失败时可能需要完成隔离素材清理。" };
  return { local, tree, deletion, challenge };
}
export async function finishRemovalMetadata(journals: LibraryTransactions, value: LibraryTransaction): Promise<void> {
  if (!value.theme || !value.deletion) throw new ContractError("IO_ERROR", "Missing deletion provenance.");
  if (value.deletion.kind === "catalog") {
    const file = path.join(journals.root("presets"), "catalog.json"), bytes = await fileBytes(file, journals.root("presets"), 1024 * 1024);
    if (byteHash(bytes) === value.deletion.catalogHash) {
      const catalog = jsonObject(bytes);
      if (!Array.isArray(catalog.themes) || catalog.themes.some(item => !record(item))) throw new ContractError("RECOVERY_CHANGED", "The source preset catalog is invalid.");
      const entries = catalog.themes.filter(record), removed = entries.filter(item => "preset-" + String(item.id) === value.theme!.id);
      const expected = { ...catalog, themes: entries.filter(item => !removed.includes(item)) };
      if (removed.length !== 1 || removed[0]!.image !== value.deletion.originalName || entries.filter(item => item.image === value.deletion!.originalName).length !== 1 || canonicalJson(expected) !== canonicalJson(value.deletion.catalogAfter)) throw new ContractError("RECOVERY_CHANGED", "The catalog transaction must remove exactly its original theme and unique background.");
      await durableJson(file, journals.root("presets"), expected);
    }
    else if (canonicalJson(jsonObject(bytes)) !== canonicalJson(value.deletion.catalogAfter)) throw new ContractError("RECOVERY_CHANGED", "The preset catalog changed during deletion; manual resolution is required.");
  }
  if (journals.platform === "macos" && value.theme.source === "preset") {
    const directory = path.join(journals.state, "deleted-presets"); await privateDirectory(directory);
    const marker = path.join(directory, value.theme.id), previous = await optionalBytes(marker, journals.state, 16384);
    if (previous && jsonObject(previous).id !== value.theme.id) throw new ContractError("RECOVERY_CHANGED", "The preset deletion marker changed.");
    if (!previous) await durableJson(marker, journals.state, { id: value.theme.id, deletedAt: new Date().toISOString() });
  }
}
export async function deleteTheme(journals: LibraryTransactions, adapter: PlatformPort, command: ThemeDeleteCommand, fingerprint: string,
  recycle: (value: LibraryTransaction) => Promise<void>): Promise<LibraryOutcome> {
  let libraryChanged: boolean | null = false;
  try {
    const prepared = await prepareDeletion(journals, adapter, command);
    if (prepared.challenge.fingerprint !== fingerprint) throw new ContractError("THEME_CHANGED", "Deletion conditions changed after confirmation; request a new preview.");
    const value = await journals.read(command.params.operationId); if (!value) throw new ContractError("IO_ERROR", "The deletion intent is missing.");
    value.theme = command.params.theme; value.tree = prepared.tree; value.deletion = prepared.deletion;
    const location = journals.platform === "windows" && value.theme.source === "preset" ? "presets" : "state";
    value.stage = { location, name: ".manager-library-delete-" + command.params.operationId.split(":")[1] };
    value.phase = "prepared"; await journals.write(value); await privateDirectory(journals.root(location));
    const stage = journals.stage(value); try { await lstat(stage); throw new ContractError("OPERATION_CONFLICT", "The deletion isolation identity already exists."); }
    catch (error) { if (!record(error) || error.code !== "ENOENT") throw error; }
    // Recheck the entire source and protection context immediately before move.
    if ((await prepareDeletion(journals, adapter, command)).challenge.fingerprint !== fingerprint) throw new ContractError("THEME_CHANGED", "Deletion conditions changed before the move.");
    value.phase = "committing"; await journals.write(value); libraryChanged = null;
    if (prepared.deletion!.kind === "catalog") { await mkdir(stage, { mode: 0o700 }); await safePath(stage, journals.root(location)); await rename(prepared.local.mediaPath, path.join(stage, prepared.deletion!.originalName)); }
    else await rename(prepared.local.mediaRoot, stage);
    libraryChanged = true; value.phase = "removed"; await journals.write(value); await syncDirectory(journals.root(location));
    await syncDirectory(path.dirname(prepared.local.mediaRoot === journals.root("presets") ? prepared.local.mediaPath : prepared.local.mediaRoot));
    await finishRemovalMetadata(journals, value); await assertTree(stage, value.tree!);
    let cleanupPending = false;
    try { if (value.theme.source === "preset") await recycle(value); else await removeTree(stage, value.tree!); }
    catch { cleanupPending = true; }
    return { libraryChanged, resultTheme: value.theme, resultRevision: command.params.expectedRevision, deleted: true, cleanupPending, error: null };
  } catch (error) {
    const response = failure(null, error); return { libraryChanged, resultTheme: libraryChanged === false ? null : command.params.theme, resultRevision: null,
      deleted: libraryChanged, cleanupPending: libraryChanged === false ? false : true, error: response.ok ? null : response.error };
  }
}
