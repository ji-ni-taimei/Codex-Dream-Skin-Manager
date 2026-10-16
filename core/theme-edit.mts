import { ContractError, parseThemePatch, record } from "../contracts/manager.mjs";
import type { ThemeEditCommand, ThemePatch, ThemeRef } from "../contracts/manager.mjs";
import { parameters } from "./theme-model.mjs";

// Preserve every field outside the explicitly submitted patch, including fields
// understood only by an older/newer renderer. Preview defaults never enter here.
export function editTheme(config: Record<string, unknown>, patch: ThemePatch, platform: "windows" | "macos"): Record<string, unknown> {
  parseThemePatch(patch);
  const next = structuredClone(config);
  if (patch.name !== undefined) next.name = patch.name.trim();
  if (patch.storageCategory !== undefined) next.category = patch.storageCategory;
  if (patch.tags !== undefined) next.tags = patch.tags.map(tag => tag.trim());
  const art = record(next.art) ? next.art : {};
  for (const [key, value] of Object.entries(patch.parameters ?? {})) {
    if (key === "appearance") { if (value === null) delete next.appearance; else next.appearance = value; }
    else if (key === "accent") {
      for (const name of ["palette", "colors"]) {
        const existing = next[name];
        if (existing !== undefined && !record(existing)) throw new ContractError("THEME_INVALID", "Invalid existing theme color container.");
        if (record(existing)) delete existing.accent;
      }
      if (value !== null) {
        const name = platform === "windows" ? "palette" : "colors";
        const existing = next[name], colors = record(existing) ? existing : {};
        colors.accent = (value as string).toUpperCase(); next[name] = colors;
      }
    } else if (value === null) delete art[key]; else art[key] = value;
  }
  if (patch.parameters !== undefined) {
    if (patch.parameters.framingEnabled === false) {
      for (const key of ["positionX", "positionY", "zoom", "positionMode"]) delete art[key];
    }
    next.art = art;
  }
  delete next.managerFingerprint; delete next.managerFingerprintVersion;
  parameters(next); // Validate the complete resulting parameter set without filling defaults.
  return next;
}

export function validateEdit(command: ThemeEditCommand, ref: ThemeRef): void {
  if (command.method === "themes.update" && ref.source === "preset" &&
      ["name", "storageCategory", "tags"].some(key => Object.hasOwn(command.params.patch, key))) {
    throw new ContractError("INVALID_REQUEST", "Preset metadata is preserved; save a copy to change it.");
  }
}

export function canonicalJson(value: unknown): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : record(value) ?
    Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return JSON.stringify(canonical(value));
}
