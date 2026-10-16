import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { safePath } from "./local-files.mjs";

export async function privateDirectory(directory: string): Promise<void> {
  const parent = path.dirname(directory);
  if (parent !== directory) {
    try { await safePath(parent, parent); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await privateDirectory(parent);
    }
  }
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  await safePath(directory, directory);
}
export async function syncDirectory(directory: string): Promise<void> {
  // Windows does not expose fsync on directory handles through Node. File data
  // is synced; rename durability across power loss remains a platform limitation.
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function durableBytes(file: string, root: string, bytes: Uint8Array): Promise<void> {
  await safePath(path.dirname(file), root);
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
export async function durableJson(file: string, root: string, value: unknown, exclusive = false): Promise<void> {
  const directory = path.dirname(file);
  await safePath(directory, root);
  const temporary = exclusive ? file : path.join(directory, `.write-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value) + "\n", "utf8"); await handle.sync(); }
  catch (error) { try { await unlink(temporary); } catch { } throw error; }
  finally { await handle.close(); }
  if (!exclusive) { await safePath(directory, root); await rename(temporary, file); }
  await syncDirectory(directory);
}
