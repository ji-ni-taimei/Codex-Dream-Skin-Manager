// Fixed script helper; capture/check are read-only business operations.
import path from "node:path";
import { ContractError, parseRequest, PROTOCOL, record, RUNTIME_METHODS } from "../contracts/manager.mjs";
import type { RuntimeCommand } from "../contracts/manager.mjs";
import { runtimePreflight } from "./runtime-preflight.mjs";
import { engineRevision } from "./runtime-engine.mjs";
import { durableJson, privateDirectory } from "./write-files.mjs";
import { dataRoot } from "../platforms/factory.mjs";
import { appearanceState } from "./runtime-targets.mjs";
import { captureRuntime } from "./runtime-state.mjs";
import { fileBytes, jsonObject, sha256 } from "./local-files.mjs";

try {
  const [action, applicationRoot, probeText, requestFile, extra] = process.argv.slice(2);
  if (action === "engine-revision" || action === "record-start") {
    if (!applicationRoot || !path.isAbsolute(applicationRoot) || requestFile || extra) throw new ContractError("INVALID_REQUEST", "Invalid engine launch helper invocation.");
    const platform = process.platform === "win32" ? "windows" : "macos", state = dataRoot();
    const revision = await engineRevision(applicationRoot, platform);
    if (action === "record-start") {
      if (probeText !== revision) throw new ContractError("RUNTIME_CHANGED", "The engine package changed during startup.");
      const bytes = await fileBytes(path.join(state, "state.json"), state, 65536), current = jsonObject(bytes);
      const injector = path.join(applicationRoot, platform, "scripts", "injector.mjs");
      const actual = typeof current.injectorPath === "string" ? path.resolve(current.injectorPath) : "";
      if ((platform === "windows" ? actual.toLowerCase() !== injector.toLowerCase() : actual !== injector) ||
          !Number.isSafeInteger(current.injectorPid) || typeof current.injectorStartedAt !== "string" || typeof current.nodePath !== "string") throw new ContractError("RUNTIME_CHANGED", "The launch does not belong to this engine package.");
      const directory = path.join(state, "manager-operations"); await privateDirectory(directory);
      await durableJson(path.join(directory, "engine-session.json"), state, { schemaVersion: 1, pid: current.injectorPid, startedAt: current.injectorStartedAt, injectorPath: current.injectorPath, nodePath: current.nodePath, engineRevision: revision });
    } else if (probeText) throw new ContractError("INVALID_REQUEST", "Engine revision does not accept a probe.");
    process.stdout.write(JSON.stringify({ engineRevision: revision }) + "\n");
  } else {
  if (!applicationRoot || !path.isAbsolute(applicationRoot) || !["capture", "check", "check-appearance", "record-engine"].includes(action ?? "") || !probeText || extra) throw new ContractError("INVALID_REQUEST", "Invalid runtime helper invocation.");
  const state = dataRoot(), platform = process.platform === "win32" ? "windows" : "macos";
  const watcherIdentity = (current: Record<string, unknown>) => sha256([Buffer.from(JSON.stringify([current.injectorPid, current.injectorStartedAt, current.injectorPath, current.nodePath]))]);
  async function descriptor() {
    const requests = path.join(state, "manager-operations", "requests");
    if (!requestFile || path.dirname(path.resolve(requestFile)) !== requests || !/^[a-f0-9-]{36}\.json$/.test(path.basename(requestFile))) throw new ContractError("INVALID_REQUEST", "Invalid runtime descriptor identity.");
    const request = jsonObject(await fileBytes(requestFile, requests, 16384));
    if (!record(request.runtimeCommand) || request.schemaVersion !== 1) throw new ContractError("INVALID_REQUEST", "Missing runtime command.");
    const command = parseRequest({ protocol: PROTOCOL, kind: "request", requestId: "runtime-worker", ...request.runtimeCommand });
    if (!(RUNTIME_METHODS as readonly string[]).includes(command.method)) throw new ContractError("INVALID_REQUEST", "Invalid runtime method.");
    return { request, command: command as RuntimeCommand };
  }
  if (action === "check-appearance") {
    const { request, command } = await descriptor(), appearance = await appearanceState(state);
    if (command.method !== "skin.restore" || request.confirmed !== true || !appearance.restoreAvailable || appearance.appearanceRevision !== request.appearanceRevision) throw new ContractError("RUNTIME_CHANGED", "The confirmed appearance backup or config changed.");
    process.stdout.write(JSON.stringify(appearance) + "\n");
  } else {
  const probe = jsonObject(probeText.startsWith("base64:") ? Buffer.from(probeText.slice(7), "base64") : Buffer.from(probeText));
  if (typeof probe.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(probe.fingerprint) ||
      ["paused", "processRunning", "startRequired", "recoveryRequired"].some(key => typeof probe[key] !== "boolean") ||
      probe.runtimeSessionId !== null && (typeof probe.runtimeSessionId !== "string" || !/^[a-f0-9]{64}$/.test(probe.runtimeSessionId))) throw new ContractError("BACKEND_UNAVAILABLE", "Invalid runtime identity result.");
  if (action === "record-engine") {
    const { request, command } = await descriptor();
    const revision = await engineRevision(applicationRoot, platform);
    const bytes = await fileBytes(path.join(state, "state.json"), state, 65536), current = jsonObject(bytes);
    const injector = path.join(applicationRoot, platform, "scripts", "injector.mjs");
    const samePath = (a: unknown, b: string) => typeof a === "string" && (platform === "windows" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
    if (command.method !== "runtime.upgrade" || request.confirmed !== true || request.expectedEngineRevision !== revision ||
        probe.watcherVerified !== true || !probe.runtimeSessionId || probe.paused || !samePath(current.injectorPath, injector) ||
        request.previousWatcherIdentity === watcherIdentity(current) ||
        !Number.isSafeInteger(current.injectorPid) || typeof current.injectorStartedAt !== "string" || typeof current.nodePath !== "string" ||
        !Buffer.from(bytes).equals(await fileBytes(path.join(state, "state.json"), state, 65536))) throw new ContractError("RUNTIME_CHANGED", "The new engine launch identity could not be proven.");
    const directory = path.join(state, "manager-operations"); await privateDirectory(directory);
    await durableJson(path.join(directory, "engine-session.json"), state, { schemaVersion: 1, pid: current.injectorPid, startedAt: current.injectorStartedAt, injectorPath: current.injectorPath, nodePath: current.nodePath, engineRevision: revision });
    process.stdout.write(JSON.stringify({ runtimeUpgraded: true }) + "\n");
  } else {
  const selected = action === "check" ? await descriptor() : null;
  const runtime = await captureRuntime(applicationRoot, state, platform, probe, selected?.command.method === "skin.pause" ? "pause" : "control");
  if (action === "check") {
    const { request, command } = selected!;
    const preflight = runtimePreflight(command, runtime as unknown as import("./ports/runtime.mjs").RuntimeState);
    if (command.method === "runtime.upgrade" && request.expectedEngineRevision !== runtime.engineRevision) throw new ContractError("RUNTIME_CHANGED", "The selected engine package changed.");
    if (request.preflightFingerprint !== probe.fingerprint || command.method === "skin.restore" && request.appearanceRevision !== runtime.appearanceRevision) throw new ContractError("RUNTIME_CHANGED", "The runtime changed after the selected status snapshot.");
    if (preflight.requiresConfirmation && request.confirmed !== true || command.method !== "skin.pause" && command.method !== "skin.restore" &&
        (request.source !== (command.method === "skin.reset" ? "default" : "active") || request.expectedRevision !== preflight.targetRevision || !record(request.theme) || request.theme.id !== preflight.targetTheme?.id || request.theme.source !== preflight.targetTheme?.source)) throw new ContractError("RUNTIME_UNAVAILABLE", "The runtime target or explicit confirmation is no longer valid.");
  } else if (requestFile) throw new ContractError("INVALID_REQUEST", "Capture does not accept a descriptor.");
  process.stdout.write(JSON.stringify(runtime) + "\n");
  }
  }
  }
} catch (error) { process.stderr.write(`${error instanceof ContractError ? error.code : "IO_ERROR"}: Runtime state could not be captured consistently.\n`); process.exitCode = 1; }
