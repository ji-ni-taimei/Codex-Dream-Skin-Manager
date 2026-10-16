// Fixed platform transaction guard; never exposed as a bridge method.
import path from "node:path";
import { ContractError, parseThemeRef, record } from "../contracts/manager.mjs";
import { fileBytes, jsonObject, safePath, MAX_MEDIA_BYTES } from "./local-files.mjs";
import { activeTheme } from "./active-theme.mjs";
import { themeDetails } from "./theme-model.mjs";
import { dataRoot, readAdapter } from "../platforms/factory.mjs";


try {
  const [applicationRoot, requestFile, probeJSON] = process.argv.slice(2);
  const state = dataRoot(), requests = path.join(state, "manager-operations", "requests");
  if (!applicationRoot || !path.isAbsolute(applicationRoot) || !requestFile || path.dirname(path.resolve(requestFile)) !== requests || !/^[a-f0-9-]{36}\.json$/.test(path.basename(requestFile)) || !probeJSON) throw new Error();
  const request = jsonObject(await fileBytes(requestFile, requests, 16384));
  const probe = JSON.parse(probeJSON.startsWith("base64:") ? Buffer.from(probeJSON.slice(7), "base64").toString("utf8") : probeJSON) as unknown;
  const ref = parseThemeRef(request.theme);
  if (request.schemaVersion !== 1 || request.confirmed !== true || !record(request.community) || typeof request.community.activeRevision !== "string" || !/^[a-f0-9]{64}$/.test(request.community.activeRevision) || typeof request.community.recoveryTransaction !== "string" || !/^\.community-apply-[a-f0-9-]{36}$/.test(request.community.recoveryTransaction) ||
      !record(probe) || probe.fingerprint !== request.preflightFingerprint || probe.startRequired !== false || probe.recoveryRequired !== false || probe.paused !== false) throw new Error();
  const adapter = readAdapter(applicationRoot), local = (await adapter.inventory()).themes.find(theme => theme.ref.id === ref.id && theme.ref.source === ref.source);
  if (!local || (await themeDetails(local)).revision !== request.expectedRevision) throw new ContractError("THEME_CHANGED", "The imported library revision changed.");
  const active = await activeTheme(state, adapter.name);
  if (!active || active.ref.id !== request.community.activeId || (await themeDetails(active)).revision !== request.community.activeRevision) throw new ContractError("RUNTIME_CHANGED", "The active rollback baseline changed.");
  process.stdout.write(JSON.stringify({ sourceDirectory: local.mediaRoot, activeId: active.ref.id,
    recoveryTransaction: request.community.recoveryTransaction, expectedRevision: request.expectedRevision }) + "\n");
} catch (error) {
  process.stderr.write(`${error instanceof ContractError ? error.code : "INVALID_REQUEST"}: Community transaction preconditions changed; no new publication was authorized.\n`); process.exitCode = 1;
}
