import path from "node:path";
import { ContractError, record } from "../contracts/manager.mjs";
import type { RuntimeState } from "./ports/runtime.mjs";
import { activeTheme } from "./active-theme.mjs";
import { appearanceState, runtimeTargets } from "./runtime-targets.mjs";
import { runtimeEngine } from "./runtime-engine.mjs";
import { observedThemeDetails, themeDetails } from "./theme-model.mjs";
import { jsonObject, MAX_CONFIG_BYTES, optionalBytes, sha256 } from "./local-files.mjs";

// The manager observes in-process so unchanged file stamps can reuse summaries.
// Native writers call this again under their lock for command-specific checks.
export async function captureRuntime(root: string, state: string, platform: "windows" | "macos", probe: Record<string, unknown>, mode: "observe" | "control" | "pause" = "control"): Promise<RuntimeState> {
  const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (!hash(probe.fingerprint) || ["paused", "processRunning", "startRequired", "recoveryRequired"].some(key => typeof probe[key] !== "boolean") ||
      probe.runtimeSessionId !== null && !hash(probe.runtimeSessionId)) throw new ContractError("BACKEND_UNAVAILABLE", "Invalid runtime identity result.");
  if (mode === "pause") return {
    fingerprint: probe.fingerprint as string, paused: probe.paused as boolean, processRunning: probe.processRunning as boolean,
    startRequired: probe.startRequired as boolean, recoveryRequired: probe.recoveryRequired as boolean,
    runtimeSessionId: probe.runtimeSessionId as string | null, revision: sha256([Buffer.from(probe.fingerprint as string)]),
    activeTheme: null, activeRevision: null, defaultTheme: null, defaultRevision: null,
    appearanceRevision: sha256([]), restoreAvailable: false, engineRevision: null, runningEngineRevision: null, upgradeRequired: false,
    watcherIdentity: null, rendererRemoved: null, rendererUnavailable: probe.processRunning === false && probe.runtimeSessionId === null,
  };
  const observe = mode === "observe", targets = await runtimeTargets(root, state, observe);
  const before = await optionalBytes(path.join(state, "state.json"), state);
  const pause = platform === "windows" ? await optionalBytes(path.join(state, "paused"), state, 16384) : null;
  const activeDirectory = path.join(state, platform === "windows" ? "active-theme" : "theme");
  const activeConfig = await optionalBytes(path.join(activeDirectory, "theme.json"), state, MAX_CONFIG_BYTES, 0);
  let details: Awaited<ReturnType<typeof themeDetails>> | null = null;
  try {
    const local = await activeTheme(state, platform);
    details = local ? await (observe ? observedThemeDetails(local) : themeDetails(local)) : null;
  } catch (error) {
    // Observing a broken active payload must leave pause/reset/restore usable.
    if (!observe && !(error instanceof ContractError && ["THEME_INVALID", "THEME_NOT_FOUND"].includes(error.code)) && !(record(error) && error.code === "ENOENT")) throw error;
  }
  const after = await optionalBytes(path.join(state, "state.json"), state);
  const engine = await runtimeEngine(root, state, platform, after, probe.watcherVerified === true, observe);
  const pauseAfter = platform === "windows" ? await optionalBytes(path.join(state, "paused"), state, 16384) : null;
  if (!observe && (await appearanceState(state)).appearanceRevision !== targets.appearanceRevision) throw new ContractError("RUNTIME_CHANGED", "Appearance inputs changed during observation.");
  const same = (a: Uint8Array | null, b: Uint8Array | null) => a === null ? b === null : b !== null && Buffer.from(a).equals(b);
  if (!same(activeConfig, await optionalBytes(path.join(activeDirectory, "theme.json"), state, MAX_CONFIG_BYTES, 0)) || !same(before, after) || !same(pause, pauseAfter) ||
      platform === "windows" && probe.paused !== (pause !== null) || platform === "macos" && probe.paused !== (before !== null && jsonObject(before).session === "paused")) {
    throw new ContractError("RUNTIME_CHANGED", "Runtime state changed while reading; refresh before controlling the skin.");
  }
  const current = before ? jsonObject(before) : null;
  return { ...probe, ...targets, ...engine,
    watcherIdentity: current ? sha256([Buffer.from(JSON.stringify([current.injectorPid, current.injectorStartedAt, current.injectorPath, current.nodePath]))]) : null,
    activeTheme: details?.ref ?? null, activeRevision: details?.revision ?? null,
    revision: sha256([Buffer.from(JSON.stringify({ fingerprint: probe.fingerprint, paused: probe.paused, active: details?.revision ?? null, activeConfigPresent: activeConfig !== null, statePresent: before !== null, pausePresent: pause !== null, targets, engine })), before ?? new Uint8Array(), pause ?? new Uint8Array(), activeConfig ?? new Uint8Array()]),
    rendererRemoved: null, rendererUnavailable: probe.processRunning === false && probe.runtimeSessionId === null,
  } as RuntimeState;
}
