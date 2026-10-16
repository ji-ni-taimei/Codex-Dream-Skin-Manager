import path from "node:path";
import { jsonObject, leaf, optionalBytes, relativeMedia } from "./local-files.mjs";
import type { LocalTheme } from "./ports/platform.mjs";
import { parseThemeRef } from "../contracts/manager.mjs";

// An active publication is a renderer payload, not a full library package.
export async function activeTheme(state: string, platform: "windows" | "macos"): Promise<LocalTheme | null> {
  const root = path.join(state, platform === "windows" ? "active-theme" : "theme"), file = path.join(root, "theme.json");
  const bytes = await optionalBytes(file, state); if (!bytes) return null;
  const config = jsonObject(bytes), ref = parseThemeRef({ source: typeof config.id === "string" && config.id.startsWith("preset-") ? "preset" : "saved", id: config.id });
  return { ref, config, mediaRoot: root, mediaPath: path.join(root, platform === "windows" ? relativeMedia(config.image) : leaf(config.image)),
    cssPath: path.join(root, "theme.css"), catalogOrder: 0, modifiedAt: null,
    revisionInputs: [bytes], revisionFiles: [{ file, root, bytes }] };
}
