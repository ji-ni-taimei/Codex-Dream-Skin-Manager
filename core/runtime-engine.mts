import path from "node:path";
import { fileBytes, optionalBytes, jsonObject, sha256 } from "./local-files.mjs";

// A revision describes the fixed package engine, never a caller supplied path.
export async function engineRevision(root: string, platform: "windows" | "macos"): Promise<string> {
  const files = ["scripts/injector.mjs", "scripts/cdp-transport.mjs", "scripts/injection-engine.mjs", "scripts/watcher-engine.mjs", "scripts/media-cache.mjs", "scripts/theme-payload.mjs", "scripts/renderer-session.mjs", "scripts/renderer-verification.mjs",
    "scripts/image-metadata.mjs", "scripts/video-decode-probe.mjs", "scripts/validate-video-file.mjs",
    "assets/renderer-inject.js", "assets/dream-skin.css", "assets/selectors.json", "assets/safe-css-validator.mjs",
    "assets/safe-css-policy.json", "assets/theme-package-validator.mjs"];
  const parts: Uint8Array[] = [Buffer.from(platform)];
  for (const name of files) parts.push(Buffer.from(name), await fileBytes(path.join(root, platform, name), root, 4 * 1024 * 1024));
  return sha256(parts);
}
export async function runtimeEngine(root: string, state: string, platform: "windows" | "macos", stateBytes: Uint8Array | null, watcherVerified: boolean) {
  let expected: string | null = null;
  try { expected = await engineRevision(root, platform); } catch { /* incomplete package cannot upgrade */ }
  let running: string | null = null;
  if (stateBytes && watcherVerified) {
    const current = jsonObject(stateBytes);
    const bytes = await optionalBytes(path.join(state, "manager-operations", "engine-session.json"), state, 65536);
    if (bytes) {
      const session = jsonObject(bytes);
      if (session.schemaVersion === 1 && session.pid === current.injectorPid && session.startedAt === current.injectorStartedAt &&
          session.injectorPath === current.injectorPath && session.nodePath === current.nodePath &&
          typeof session.engineRevision === "string" && /^[a-f0-9]{64}$/.test(session.engineRevision)) running = session.engineRevision;
    }
  }
  return { engineRevision: expected, runningEngineRevision: running, upgradeRequired: expected !== null && expected !== running };
}
