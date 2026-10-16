import path from "node:path";
import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { ContractError, record } from "../contracts/manager.mjs";
import { fileBytes, leaf, safePath, sha256 } from "./local-files.mjs";
import { canonicalJson } from "./theme-edit.mjs";
import { byteHash } from "./source-snapshots.mjs";

export interface TreeFile { name: string; bytes: number; hash: string }
export interface TreeSnapshot { files: TreeFile[]; directories: string[] }
export async function treeSnapshot(directory: string): Promise<TreeSnapshot> {
  await safePath(directory, directory);
  const files: TreeFile[] = [], directories: string[] = []; let count = 0, total = 0;
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 8 || !(await lstat(dir)).isDirectory()) throw new ContractError("THEME_INVALID", "Invalid managed directory tree.");
    for (const name of (await readdir(dir)).sort()) {
      leaf(name); if (++count > 4096) throw new ContractError("THEME_INVALID", "The managed tree contains too many entries.");
      const file = path.join(dir, name), relative = prefix + name; await safePath(file, directory); const stat = await lstat(file);
      if (stat.isDirectory()) { directories.push(relative); await walk(file, relative + "/", depth + 1); }
      else if (stat.isFile()) {
        total += stat.size; if (stat.size > 128 * 1024 * 1024 || total > 512 * 1024 * 1024) throw new ContractError("THEME_INVALID", "The managed tree exceeds its byte budget.");
        // Theme dependencies are non-empty. Unknown empty auxiliary files have
        // a deterministic hash but are not opened as theme payloads.
        const data = stat.size === 0 ? new Uint8Array() : await fileBytes(file, directory, 128 * 1024 * 1024);
        if (stat.size !== (await lstat(file)).size) throw new ContractError("THEME_CHANGED", "The managed tree changed while reading.");
        files.push({ name: relative, bytes: data.byteLength, hash: byteHash(data) });
      } else throw new ContractError("THEME_INVALID", "A managed tree contains a linked or special file.");
    }
  };
  await walk(directory, "", 0); return { files, directories };
}
export const treeRevision = (tree: TreeSnapshot): string => sha256([Buffer.from(canonicalJson(tree))]);
export function parseTree(raw: unknown): TreeSnapshot {
  if (!record(raw) || !Array.isArray(raw.files) || !Array.isArray(raw.directories) || raw.files.length + raw.directories.length > 4096) throw new ContractError("IO_ERROR", "Invalid transaction tree record.");
  const validName = (name: unknown): name is string => {
    if (typeof name !== "string" || name.length > 2048) return false;
    try { const parts = name.split("/"); if (parts.length > 9) return false; parts.forEach(leaf); return true; } catch { return false; }
  };
  for (const file of raw.files) if (!record(file) || !validName(file.name) || typeof file.bytes !== "number" || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 128 * 1024 * 1024 || typeof file.hash !== "string" || !/^[a-f0-9]{64}$/.test(file.hash)) throw new ContractError("IO_ERROR", "Invalid transaction file record.");
  if (raw.directories.some(name => !validName(name))) throw new ContractError("IO_ERROR", "Invalid transaction directory record.");
  const names = [...raw.files.map(file => file.name), ...raw.directories]; if (new Set(names).size !== names.length) throw new ContractError("IO_ERROR", "Duplicate transaction tree record.");
  return raw as unknown as TreeSnapshot;
}
export async function assertTree(directory: string, expected: TreeSnapshot, partial = false): Promise<TreeSnapshot> {
  const current = await treeSnapshot(directory);
  if (partial ? current.files.some(file => !expected.files.some(old => old.name === file.name && old.bytes === file.bytes && old.hash === file.hash)) ||
      current.directories.some(name => !expected.directories.includes(name)) : treeRevision(current) !== treeRevision(expected)) throw new ContractError("RECOVERY_CHANGED", "The managed tree differs from the confirmed transaction bytes.");
  return current;
}
// No recursive rm: reopen/check each explicitly captured member under its root.
export async function removeTree(directory: string, expected: TreeSnapshot, partial = false): Promise<void> {
  const current = await assertTree(directory, expected, partial);
  for (const file of current.files) {
    const full = path.join(directory, ...file.name.split("/")); await safePath(full, directory);
    const bytes = file.bytes ? await fileBytes(full, directory, 128 * 1024 * 1024) : new Uint8Array();
    if (byteHash(bytes) !== file.hash || !(await lstat(full)).isFile() || (await lstat(full)).size !== file.bytes) throw new ContractError("RECOVERY_CHANGED", "A file changed before cleanup.");
    await unlink(full);
  }
  for (const name of current.directories.sort((a, b) => b.split("/").length - a.split("/").length)) {
    const full = path.join(directory, ...name.split("/")); await safePath(full, directory); await rmdir(full);
  }
  await safePath(directory, directory); await rmdir(directory);
}
