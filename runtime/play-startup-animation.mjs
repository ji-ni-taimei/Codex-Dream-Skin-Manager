import { writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createCdpTransport } from "./cdp-transport.mjs";
import { installStartupVideo } from "../assets/startup-animation/extension/video.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const animationRoot = path.resolve(path.dirname(scriptPath), "../assets/startup-animation");
const MAX_TIMEOUT_MS = 8000;

function validateOptions({ port, browserId, themeDir, timeoutMs }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("Startup animation requires a port between 1024 and 65535");
  }
  if (typeof browserId !== "string" || !/^[A-Za-z0-9._-]{1,200}$/.test(browserId)) {
    throw new Error("Startup animation requires the verified Codex browser ID");
  }
  if (typeof themeDir !== "string" || !path.isAbsolute(themeDir)) {
    throw new Error("Startup animation requires an absolute active theme directory");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error("Startup animation timeout must be between 1000 and 8000 ms");
  }
}

async function settleWithin(milliseconds, operation) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Startup animation timed out")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function playStartupAnimation({ port, browserId, themeDir, videoPath = null, timeoutMs = MAX_TIMEOUT_MS }) {
  const macos = process.platform === "darwin";
  const transport = createCdpTransport({ allowBrowserEndpoint: true });
  if (macos && !browserId) {
    const version = await transport.fetchCdpJson(port, "/json/version");
    browserId = new URL(transport.validatedDebuggerUrl(version, port)).pathname.match(/^\/devtools\/browser\/([A-Za-z0-9._-]{1,200})$/)?.[1];
  }
  validateOptions({ port, browserId, themeDir, timeoutMs });
  // Reserve time for disposing an unsuccessful overlay and closing sockets.
  // The CLI watchdog below also bounds imported helpers and socket cleanup.
  const deadline = Date.now() + timeoutMs - Math.min(1000, Math.floor(timeoutMs / 4));
  const remaining = () => {
    const milliseconds = deadline - Date.now();
    if (milliseconds <= 0) throw new Error("Startup animation timed out");
    return milliseconds;
  };
  const bounded = (operation) => settleWithin(remaining(), operation);
  let anchor;
  let connected = [];
  let selected;
  let closing = false;
  let injectionAttempted = false;
  let started = false;
  try {
    const [injector, payloadBuilder, targetMatcher] = await bounded(() => Promise.all([
      import("./injector.mjs"),
      import("../assets/startup-animation/extension/payload.mjs"),
      import("../assets/startup-animation/extension/cdp.mjs"),
    ]));
    const [loadedSkin, source] = await bounded(() => Promise.all([
      injector.loadPayload(themeDir),
      videoPath ? `(${installStartupVideo.toString()})()` : payloadBuilder.buildInjection(animationRoot, { wallpaperEnabled: false, customizationEnabled: false }),
    ]));
    const connectIdentity = async () => {
      if (!macos) return injector.connectBrowserIdentityAnchor(port, browserId);
      const version = await transport.fetchCdpJson(port, "/json/version");
      const url = transport.validatedDebuggerUrl(version, port);
      if (new URL(url).pathname !== `/devtools/browser/${browserId}`) throw new Error("Codex browser identity changed");
      return targetMatcher.connect(url);
    };
    anchor = await bounded(() => connectIdentity().then((identity) => {
      if (closing) {
        identity.close();
        throw new Error("Startup animation identity connected after its deadline");
      }
      return identity;
    }));
    connected = await bounded(() => injector.connectCodexTargets(port, remaining(), browserId).then((records) => {
      if (closing) {
        for (const record of records) record.session.close();
        throw new Error("Startup animation renderers connected after its deadline");
      }
      return records;
    }));
    const assertIdentity = () => {
      if (anchor.closed) throw new Error("Codex browser identity closed before animation handoff");
    };
    for (const record of connected) {
      // Both filters apply: Dream Skin excludes Pet surfaces and verifies shell
      // markers; the animation contract also excludes auxiliary Codex windows.
      if (!targetMatcher.pageTarget(record.target)) continue;
      assertIdentity();
      const skin = await bounded(() => macos
        ? injector.verifySession(record.session, loadedSkin.theme.id, loadedSkin.revision)
        : injector.verifyAppliedSession(record.session, loadedSkin.theme.id, loadedSkin.revision));
      assertIdentity();
      if (skin?.pass === true) {
        selected = record;
        break;
      }
    }
    if (!selected) throw new Error("No main Codex window has the current active skin applied");
    assertIdentity();
    injectionAttempted = true;
    const result = await bounded(() => selected.session.evaluate(source));
    if (result?.installed !== true) throw new Error("Startup animation overlay was not installed");
    assertIdentity();
    if (videoPath) {
      try {
        const lookup = await bounded(() => selected.session.send("Runtime.evaluate", {
          expression: 'document.getElementById("dream-skin-startup-video-file")', returnByValue: false,
        }));
        const objectId = lookup.result?.objectId;
        if (!objectId) throw new Error("Startup video file input was not installed");
        try { await bounded(() => selected.session.send("DOM.setFileInputFiles", { files: [videoPath], objectId })); }
        finally { await selected.session.send("Runtime.releaseObject", { objectId }).catch(() => {}); }
        await bounded(() => selected.session.evaluate("globalThis.__aemeathExtension.bind()"));
      } catch (error) {
        // Esc/Skip may remove the file input during any CDP handoff step.
        // A completed overlay is a successful dismissal, not a playback failure.
        const state = await bounded(() => selected.session.evaluate("globalThis.__aemeathExtension?.status() ?? null")).catch(() => null);
        if (state?.completed !== true) throw error;
      }
    }
    if (result.alreadyActive) {
      await bounded(() => selected.session.evaluate("globalThis.__aemeathExtension.replay()"));
    }
    while (true) {
      assertIdentity();
      const state = await bounded(() => selected.session.evaluate(
        "globalThis.__aemeathExtension?.status() ?? null",
      ));
      assertIdentity();
      if (state?.phase === "failed" || state?.phase === "timeout") {
        throw new Error("Startup animation could not load its assets");
      }
      if (state?.ready === true || state?.completed === true) {
        started = true;
        return { started: true, targetId: selected.target.id, phase: state.phase };
      }
      await bounded(() => new Promise((resolve) => setTimeout(resolve, 50)));
    }
  } finally {
    closing = true;
    // Animation playback belongs to the temporary iframe once ready; keep it
    // playing after disconnecting. An unsuccessful handoff removes only this
    // animation extension, leaving the applied Dream Skin intact.
    if (injectionAttempted && !started && selected && anchor && !anchor.closed) {
      await settleWithin(300, () => selected.session.evaluate(
        "globalThis.__aemeathExtension?.dispose()",
      )).catch(() => {});
    }
    for (const record of connected) record.session.close();
    anchor?.close();
  }
}

if (path.resolve(process.argv[1] || "") === path.resolve(scriptPath)) {
  let completed = false;
  let exitCode = 2;
  try {
    const { values } = parseArgs({ options: {
      port: { type: "string" },
      "browser-id": { type: "string" },
      "theme-dir": { type: "string" },
      "timeout-ms": { type: "string", default: String(MAX_TIMEOUT_MS) },
    } });
    const options = {
      port: Number(values.port), browserId: values["browser-id"],
      themeDir: values["theme-dir"], timeoutMs: Number(values["timeout-ms"]),
    };
    validateOptions(options);
    // Start before loading payloads or the injector's selector contract.
    // A lingering imported helper or WebSocket cannot hold the apply operation.
    setTimeout(() => {
      if (!completed) writeSync(2, "Startup animation exceeded its total time budget\n");
      process.exit(completed ? exitCode : 2);
    }, options.timeoutMs).unref();
    const result = await playStartupAnimation(options);
    writeSync(1, JSON.stringify(result) + "\n");
    exitCode = 0;
  } catch (error) {
    writeSync(2, `Startup animation: ${error.message}\n`);
  } finally {
    process.exitCode = exitCode;
    completed = true;
  }
}
