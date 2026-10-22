import path from "node:path";
import { boundedText, ContractError, parseThemeRef } from "../contracts/manager.mjs";
import type { StartupAnimationSettings } from "../contracts/manager.mjs";
import { jsonObject, optionalBytes } from "./local-files.mjs";
import { durableJson, privateDirectory } from "./write-files.mjs";

const settingsFile = (state: string) => path.join(state, "startup-animation.json");
export async function startupAnimationSettings(state: string): Promise<StartupAnimationSettings> {
  const bytes = await optionalBytes(settingsFile(state), state, 4096);
  if (!bytes) return { enabled: true, theme: null, themeName: null };
  const value = jsonObject(bytes);
  if (value.schemaVersion !== 1 || typeof value.enabled !== "boolean" ||
      (value.theme !== null && !boundedText(value.themeName, 80))) throw new ContractError("THEME_INVALID", "Invalid startup animation settings.");
  return { enabled: value.enabled, theme: value.theme === null ? null : parseThemeRef(value.theme), themeName: value.theme === null ? null : value.themeName as string };
}
export async function saveStartupAnimationSettings(state: string, settings: StartupAnimationSettings): Promise<StartupAnimationSettings> {
  await privateDirectory(state);
  await durableJson(settingsFile(state), state, { schemaVersion: 1, ...settings });
  return settings;
}
