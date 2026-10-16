import path from "node:path";
import { mkdir, lstat, rename } from "node:fs/promises";
import { ContractError, failure, record } from "../contracts/manager.mjs";
import type { ThemeCreateCommand, ThemeRef } from "../contracts/manager.mjs";
import type { LibraryOutcome } from "./ports/library.mjs";
import type { SourceSnapshot } from "./source-snapshots.mjs";
import type { PlatformPort } from "./ports/platform.mjs";
import { SourceSnapshots } from "./source-snapshots.mjs";
import { fileBytes, MAX_MEDIA_BYTES, optionalBytes, safePath } from "./local-files.mjs";
import { durableBytes, durableJson, privateDirectory, syncDirectory } from "./write-files.mjs";
import { editTheme } from "./theme-edit.mjs";
import { themeDetails } from "./theme-model.mjs";
import { themeFingerprint } from "./theme-fingerprint.mjs";
import type { LibraryTransactions } from "./library-transactions.mjs";

export async function createTheme(state: string, command: ThemeCreateCommand, rawSource: unknown, adapter: PlatformPort,
  inspect: (bytes: Uint8Array, extension: string) => Promise<void>, validateMedia: (file: string) => Promise<void>, journals: LibraryTransactions): Promise<LibraryOutcome> {
  let libraryChanged: boolean | null = false, resultTheme: ThemeRef | null = null;
  try {
    if (!record(rawSource) || !record(rawSource.media) || (rawSource.original !== null && !record(rawSource.original)) ||
        Object.keys(rawSource).some(key => !["media", "original"].includes(key))) throw new ContractError("INVALID_REQUEST", "Invalid import source descriptor.");
    const source = rawSource as unknown as SourceSnapshot;
    const snapshots = new SourceSnapshots(state, adapter.name, inspect);
    const media = await snapshots.read(source.media), original = source.original ? await snapshots.read(source.original) : null;
    const extension = path.extname(source.media.fileName), originalExtension = source.original ? path.extname(source.original.fileName) : null;
    if (!/^\.(png|apng|jpe?g|webp|gif|mp4)$/.test(extension) || (source.original && (adapter.name !== "macos" || !/^\.(heic|tiff?)$/.test(originalExtension!)))) {
      throw new ContractError("MEDIA_UNSUPPORTED", "Unsupported import conversion or media format.");
    }
    const id = "custom-" + command.params.operationId.split(":")[1];
    const config = editTheme({ schemaVersion: 1, id, name: command.params.name.trim(), category: "custom", tags: [],
      image: "background" + extension, ...(originalExtension ? { originalImage: "original" + originalExtension } : {}) }, command.params.patch, adapter.name);
    await inspect(media, extension);
    // Same authoritative decode path as the old importer; never launch Codex.
    await validateMedia(path.join(snapshots.directory, source.media.fileName));
    await snapshots.read(source.media); if (source.original) await snapshots.read(source.original);
    const fingerprint = themeFingerprint(config, media, null);
    const inventory = await adapter.inventory();
    for (const local of inventory.themes) {
      if (local.ref.source !== "saved") continue;
      try {
        const details = await themeDetails(local);
        const existing = await fileBytes(local.mediaPath, local.mediaRoot, MAX_MEDIA_BYTES);
        const css = local.cssPath ? await optionalBytes(local.cssPath, local.mediaRoot, 256 * 1024) : null;
        if (fingerprint !== themeFingerprint(local.config, existing, css)) continue;
        if ((await themeDetails(local)).revision !== details.revision || !Buffer.from(existing).equals(await fileBytes(local.mediaPath, local.mediaRoot, MAX_MEDIA_BYTES))) continue;
        return { libraryChanged: false, resultTheme: local.ref, resultRevision: details.revision, disposition: "duplicate", error: null };
      } catch { /* An unreadable existing entry cannot suppress an import. */ }
    }
    const library = path.join(state, "themes"), stage = path.join(library, ".manager-import-" + id.slice(7)), destination = path.join(library, id);
    await privateDirectory(library);
    try { await lstat(destination); throw new ContractError("OPERATION_CONFLICT", "The import identity already exists and cannot be overwritten."); }
    catch (error) { if (!record(error) || error.code !== "ENOENT") throw error; }
    await safePath(library, state); await mkdir(stage, { mode: 0o700 }); await safePath(stage, library);
    await durableBytes(path.join(stage, String(config.image)), stage, media);
    if (original && originalExtension) await durableBytes(path.join(stage, "original" + originalExtension), stage, original);
    await durableJson(path.join(stage, "theme.json"), stage, config, true);
    if (!Buffer.from(media).equals(await fileBytes(path.join(stage, String(config.image)), stage, MAX_MEDIA_BYTES)) ||
        (original && !Buffer.from(original).equals(await fileBytes(path.join(stage, "original" + originalExtension), stage, MAX_MEDIA_BYTES)))) {
      throw new ContractError("IO_ERROR", "The staged import snapshot could not be confirmed.");
    }
    await snapshots.read(source.media); if (source.original) await snapshots.read(source.original);
    await safePath(library, state); await safePath(stage, library); await syncDirectory(stage);
    resultTheme = { source: "saved", id }; libraryChanged = null;
    await journals.publish(command.params.operationId, stage, resultTheme); libraryChanged = true;
    const result = (await adapter.inventory()).themes.find(local => local.ref.source === "saved" && local.ref.id === id);
    if (!result) throw new ContractError("IO_ERROR", "The imported entry could not be read back.");
    return { libraryChanged, resultTheme, resultRevision: (await themeDetails(result)).revision, disposition: "created", error: null };
  } catch (error) {
    const response = failure(null, error);
    return { libraryChanged, resultTheme, resultRevision: null, disposition: null, error: response.ok ? null : response.error };
  }
}
