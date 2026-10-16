import path from "node:path";
import os from "node:os";
import { MAX_CONFIG_BYTES, optionalBytes, sha256 } from "./local-files.mjs";
import { readAdapter } from "../platforms/factory.mjs";
import { themeDetails } from "./theme-model.mjs";

export async function defaultRuntimeTheme(applicationRoot: string) {
  const id = process.platform === "win32" ? "preset-paper-light" : "preset-gothic-void-crusade";
  const themes = (await readAdapter(applicationRoot).inventory()).themes;
  return themes.find(theme => theme.ref.source === "preset" && theme.ref.id === id) ??
    (process.platform === "darwin" ? themes.find(theme => theme.ref.id === "gothic-void-crusade") : null) ?? null;
}
export async function runtimeTargets(applicationRoot: string, state: string) {
  // Missing or invalid defaults disable reset; they never select another preset.
  const local = await defaultRuntimeTheme(applicationRoot).catch(() => null);
  const details = local ? await themeDetails(local).catch(() => null) : null;
  return { defaultTheme: details?.ref ?? null, defaultRevision: details?.revision ?? null, ...await appearanceState(state) };
}
export async function appearanceState(state: string) {
  const config = path.join(os.homedir(), ".codex", "config.toml");
  const backup = path.join(state, process.platform === "win32" ? "config.before-dream-skin.toml" : "theme-backup.json");
  const files = [config, backup, ...(process.platform === "win32" ? [backup + ".appearance.json", backup + ".startup-appearance.json"] : [])];
  const bytes = await Promise.all(files.map(file => optionalBytes(file, file === config ? path.dirname(config) : state, MAX_CONFIG_BYTES, 0)));
  return { appearanceRevision: sha256([Buffer.from(JSON.stringify(bytes.map(value => value !== null))), ...bytes.map(value => value ?? new Uint8Array())]),
    restoreAvailable: bytes[0] !== null && bytes[1] !== null };
}
