import path from "node:path";
import { ContractError, MAINTENANCE_ACTIONS } from "../contracts/manager.mjs";
import type { MaintenanceAction } from "../contracts/manager.mjs";
import { fileBytes, jsonObject } from "./local-files.mjs";
import { dataRoot } from "../platforms/factory.mjs";
import { PlatformMaintenance } from "../platforms/maintenance.mjs";
try {
  const [action, root, request] = process.argv.slice(2), state = dataRoot();
  if (process.platform !== "darwin" || !root || !path.isAbsolute(root) || !request || path.dirname(request) !== path.join(state, "manager-operations/maintenance-requests") || !["check", "retain"].includes(action ?? "")) throw new ContractError("INVALID_REQUEST", "Invalid internal maintenance call.");
  const value = jsonObject(await fileBytes(request, state, 16384)), port = new PlatformMaintenance(root, state);
  if (!(MAINTENANCE_ACTIONS as readonly unknown[]).includes(value.action) || typeof value.binding !== "string") throw new ContractError("INVALID_REQUEST", "Invalid maintenance binding.");
  if (action === "check") {
    const current = await port.inspect();
    if (current.binding !== value.binding || !current.info.actions.includes(value.action as MaintenanceAction)) throw new ContractError("RUNTIME_CHANGED", "维护批准后目标已改变。");
  } else if (action === "retain" && value.action === "engine.uninstall") await port.retainEngine();
  else throw new ContractError("INVALID_REQUEST", "Invalid internal maintenance phase.");
  process.stdout.write(JSON.stringify({ action: value.action }) + "\n");
} catch { process.stderr.write("维护边界检查或平台阶段未完成；请查询记录，不自动重放。\n"); process.exitCode = 1; }
