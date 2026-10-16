import { powerShellArgs } from "./powershell.mjs";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { ContractError, record } from "../../contracts/manager.mjs";
import type { ThemeRef } from "../../contracts/manager.mjs";
import { leaf, safePath } from "../../core/local-files.mjs";
import type { LocalTheme, PlatformPort, PlatformStatus, ThemeInventory } from "../../core/ports/platform.mjs";
import { catalogEntries, existingTheme, mergedPreset, readVersion, scanLibrary } from "../local-library.mjs";
import { readProcess } from "../read-process.mjs";

export class WindowsReadAdapter implements PlatformPort {
  readonly name = "windows";
  private readonly skillRoot: string;
  constructor(private readonly applicationRoot: string, private readonly stateRoot: string) {
    this.skillRoot = path.join(applicationRoot, "windows");
  }
  applicationVersion(): Promise<string | null> { return readVersion(path.join(this.skillRoot, "VERSION"), this.skillRoot); }

  async inventory(): Promise<ThemeInventory> {
    const presetRoot = path.join(this.skillRoot, "presets");
    const result = await scanLibrary(path.join(this.stateRoot, "themes"), () => "saved", () => 2000, true);
    const presets: LocalTheme[] = [];
    let catalog: Awaited<ReturnType<typeof catalogEntries>> = null;
    try { catalog = await catalogEntries(path.join(presetRoot, "catalog.json"), presetRoot); }
    catch { result.warnings.push({ code: "CATALOG_INVALID", message: "The preset catalog is invalid; using existing fallback entries." }); }
    if (catalog) {
      for (const [index, entry] of catalog.entries.entries()) {
        try {
          const id = `preset-${entry.id as string}`, image = leaf(entry.image);
          // The legacy catalog constructs explicit default focus for built-ins.
          const config = {
            schemaVersion: 1, id, name: entry.name, image, category: entry.category, tags: entry.tags ?? [],
            appearance: entry.appearance ?? "auto",
            art: { focusX: entry.focusX ?? 0.5, focusY: entry.focusY ?? 0.5,
              safeArea: entry.safeArea ?? "auto", taskMode: entry.taskMode ?? "auto" },
            palette: entry.accent ? { accent: entry.accent } : {},
          };
          presets.push(await mergedPreset({ ref: { source: "preset", id }, config,
            revisionInputs: [new TextEncoder().encode(JSON.stringify(entry))], mediaRoot: presetRoot,
            revisionFiles: [{ file: path.join(presetRoot, "catalog.json"), root: presetRoot, bytes: catalog.bytes }],
            mediaPath: path.join(presetRoot, image), cssPath: null, catalogOrder: index, modifiedAt: null }, this.stateRoot));
        } catch { result.warnings.push({ code: "THEME_INVALID", message: "An invalid catalog preset was omitted." }); }
      }
    } else {
      // Preserve legacy flat-file presets when the catalog is missing or damaged.
      await safePath(presetRoot, presetRoot);
      const entries = await readdir(presetRoot, { withFileTypes: true });
      for (const entry of entries.filter(item => item.isFile() && /\.(jpg|jpeg|png|apng|webp|gif|mp4)$/i.test(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
        const stem = path.parse(entry.name).name, id = `preset-${stem}`;
        if (!/^preset-[A-Za-z0-9_-]{1,72}$/.test(id)) continue;
        const config = { schemaVersion: 1, id, name: stem.replaceAll("-", " ").replace(/\b\w/g, c => c.toUpperCase()),
          image: entry.name, category: "uncategorized", tags: [], appearance: "auto",
          art: { focusX: 0.5, focusY: 0.5, safeArea: "auto", taskMode: "auto" }, palette: {} };
        try {
          presets.push(await mergedPreset({ ref: { source: "preset", id }, config,
            revisionInputs: [new TextEncoder().encode(JSON.stringify(config))], mediaRoot: presetRoot, revisionFiles: [],
            mediaPath: path.join(presetRoot, entry.name), cssPath: null, catalogOrder: presets.length, modifiedAt: null }, this.stateRoot));
        } catch { result.warnings.push({ code: "THEME_INVALID", message: "An unreadable fallback preset was omitted." }); }
      }
    }
    const directoryPresets = await scanLibrary(presetRoot, () => "preset", () => 1000, true);
    result.warnings.push(...directoryPresets.warnings);
    const seen = new Set(presets.map(theme => theme.ref.id));
    for (const theme of directoryPresets.themes) {
      if (!/^preset-[A-Za-z0-9_-]{1,72}$/.test(theme.ref.id) || seen.has(theme.ref.id)) continue;
      try { presets.push(await mergedPreset(theme, this.stateRoot)); seen.add(theme.ref.id); }
      catch { result.warnings.push({ code: "THEME_INVALID", message: "A preset with invalid overrides was omitted." }); }
    }
    // The old Windows reader suppresses saved IDs shadowed by a bundled preset.
    result.themes = [...presets, ...result.themes.filter(theme => !seen.has(theme.ref.id))];
    return result;
  }

  async status(): Promise<PlatformStatus> {
    const script = path.join(this.skillRoot, "scripts", "platform-theme.ps1");
    await safePath(script, this.skillRoot);
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !path.isAbsolute(systemRoot)) throw new ContractError("BACKEND_UNAVAILABLE", "Windows system directory is unavailable.");
    const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const value = await readProcess(executable, await powerShellArgs(this.applicationRoot, script, ["-Action", "Status", "-SkillRoot", this.skillRoot, "-StateRoot", this.stateRoot]));
    const health: PlatformStatus["health"] = (value.statusKind === "running" || value.statusKind === "paused") && value.isRunning === true ? "healthy"
      : value.statusKind === "stopped" || value.statusKind === "paused" ? "stopped"
      : value.statusKind === "stale" ? "stale" : value.statusKind === "mismatch" ? "mismatch"
      : value.statusKind === "degraded" ? "degraded" : "unknown";
    if (!record(value) || typeof value.isPaused !== "boolean" || typeof value.statusKind !== "string") {
      throw new ContractError("BACKEND_UNAVAILABLE", "Invalid Windows status contract.");
    }
    return { activeId: typeof value.activeThemeId === "string" && value.activeThemeId ? value.activeThemeId : null,
      paused: value.isPaused, health, appliedId: typeof value.appliedThemeId === "string" && value.appliedThemeId ? value.appliedThemeId : null,
      busy: value.statusKind === "starting" || value.statusKind === "applying", diagnostics: health === "unknown"
        ? [{ code: "ENGINE_UNINSPECTED", message: "The process status is inconclusive." }] : [] };
  }
  async resolveActive(id: string): Promise<ThemeRef | null> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id)) return null;
    if (id.startsWith("preset-")) {
      const root = path.join(this.skillRoot, "presets");
      if (await existingTheme(root, id, "preset", true)) return { source: "preset", id };
      let catalog: Awaited<ReturnType<typeof catalogEntries>> = null;
      try { catalog = await catalogEntries(path.join(root, "catalog.json"), root); } catch { /* use legacy fallback */ }
      if (catalog?.entries.some(entry => `preset-${entry.id as string}` === id)) return { source: "preset", id };
      if (!catalog) {
        await safePath(root, root);
        const entries = await readdir(root, { withFileTypes: true });
        if (entries.some(entry => entry.isFile() && /\.(jpg|jpeg|png|apng|webp|gif|mp4)$/i.test(entry.name) &&
            `preset-${path.parse(entry.name).name}` === id)) return { source: "preset", id };
      }
    }
    return await existingTheme(path.join(this.stateRoot, "themes"), id, "saved", true) ? { source: "saved", id } : null;
  }
}
