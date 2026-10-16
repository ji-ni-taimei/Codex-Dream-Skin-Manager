import path from "node:path";
import { readdir, unlink } from "node:fs/promises";
import { record } from "../contracts/manager.mjs";
import { fileBytes, jsonObject } from "./local-files.mjs";

// Keep recent receipts for reconnects; unfinished work is never aged out.
export async function pruneHistory(directory: string, states: readonly string[], transaction = false): Promise<void> {
  const finished: { file: string; time: number }[] = [];
  let names: string[];
  try { names = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    try {
      const value = jsonObject(await fileBytes(path.join(directory, name), directory, 3 * 1024 * 1024));
      const entry = transaction ? value : value.operation;
      if (!record(entry) || !states.includes(String(transaction ? entry.phase : entry.state))) continue;
      const time = Date.parse(String(entry.updatedAt));
      if (Number.isFinite(time)) finished.push({ file: path.join(directory, name), time });
    } catch { /* Leave unreadable recovery material alone. */ }
  }
  finished.sort((a, b) => b.time - a.time);
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const entry of finished.slice(256)) {
    if (entry.time < cutoff) await unlink(entry.file).catch(() => {});
  }
}
