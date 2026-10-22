// Optional presentation after a verified launch; errors never roll back a skin.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ContractError } from "../contracts/manager.mjs";
import { dataRoot, readAdapter } from "../platforms/factory.mjs";
import { mediaInspector } from "../platforms/media-metadata.mjs";
import { fileBytes, jsonObject, safePath } from "./local-files.mjs";
import { readThemeContent } from "./theme-model.mjs";
import { startupAnimationSettings } from "./startup-animation.mjs";

// Bound imports, file preparation, and CDP handoff as well as the player itself.
let completed = false;
const watchdog = setTimeout(() => process.exit(completed ? (process.exitCode ?? 0) : 2), 20000);
watchdog.unref();
try {
  const [root, portText, extra] = process.argv.slice(2), port = Number(portText);
  if (!root || !path.isAbsolute(root) || extra || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid startup animation invocation");
  const state = dataRoot(), settings = await startupAnimationSettings(state);
  if (settings.enabled) {
    const platform = process.platform === "win32" ? "windows" : "macos";
    const current = jsonObject(await fileBytes(path.join(state, "state.json"), state, 65536));
    // Only macOS records a session phase; Windows schema 3 has no such field.
    // The player verifies browser identity and the applied skin on both platforms.
    if ((platform === "macos" && current.session !== "active") || current.port !== port || typeof current.themeDir !== "string" || !path.isAbsolute(current.themeDir)) throw new Error("No verified active skin session");
    await safePath(current.themeDir, state);
    const load = async (name: string) => {
      const file = path.join(root, platform, "scripts", name + ".mjs");
      await safePath(file, root);
      return import(pathToFileURL(file).href);
    };
    let videoPath: string | null = null;
    if (settings.theme) {
      try {
        const inventory = await readAdapter(root).inventory();
        const local = inventory.themes.find(theme => theme.ref.source === settings.theme!.source && theme.ref.id === settings.theme!.id);
        if (!local) throw new ContractError("THEME_NOT_FOUND", "The startup video theme was removed");
        const { details, media } = await readThemeContent(local);
        if (details.mediaKind !== "video") throw new Error("The startup theme is no longer a video");
        await mediaInspector(root, platform)(media, ".mp4");
        const cache = await load("media-cache");
        videoPath = await cache.materializeMediaSnapshot(Buffer.from(media));
      } catch {
        process.stderr.write("Startup video unavailable; using the built-in animation.\n");
      }
    }
    const player = await load("play-startup-animation");
    const options = { port, browserId: typeof current.browserId === "string" ? current.browserId : undefined, themeDir: current.themeDir, timeoutMs: 8000 };
    try { await player.playStartupAnimation({ ...options, videoPath }); }
    catch (error) {
      if (!videoPath) throw error;
      process.stderr.write("Startup video could not play; using the built-in animation.\n");
      await player.playStartupAnimation(options);
    }
  }
} catch (error) {
  const reason = error instanceof Error ? error.message.replace(/[\r\n]+/g, " ").slice(0, 512) : "Unknown error";
  process.stderr.write(`Startup animation could not start; the applied skin is unchanged. Reason: ${reason}\n`);
  process.exitCode = 2;
} finally { completed = true; }
