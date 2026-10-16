import type { OperationSnapshot, SourceGrant } from "../../../contracts/manager.mjs";
import type { ManagerClient } from "./client";
import { BridgeError } from "./client";
import { uiMessage, UiMessageError } from "./ui-message";

export const sourceName = (source: SourceGrant) => source.name.replace(/\.[^.]+$/, "").trim().slice(0, 80) || "新主题";
export const importPending = (value: OperationSnapshot) => ["queued", "running", "awaitingConfirmation"].includes(value.state);
// Only explicit pre-acceptance refusals permit a new submission. Transport
// errors and IO errors can follow acceptance and must retain the original id.
export const importRefused = (error: unknown) => error instanceof BridgeError &&
  ["BUSY", "RESOURCE_EXPIRED", "INVALID_REQUEST", "METHOD_UNSUPPORTED", "OPERATION_UNKNOWN", "MEDIA_UNSUPPORTED", "THEME_INVALID", "THEME_CHANGED"].includes(error.detail.code);
export function rememberImport(session: string, name: string, packages = false): string {
  const key = packages ? "dreamskin.manager.packages" : "dreamskin.manager.imports";
  const saved: unknown = JSON.parse(sessionStorage.getItem(key) ?? "[]");
  const rows = Array.isArray(saved) ? saved.slice(-31) : [];
  const id = `${session}:${crypto.randomUUID()}`;
  sessionStorage.setItem(key, JSON.stringify([...rows, { name, id }]));
  sessionStorage.setItem("dreamskin.manager.operation", id);
  return id;
}
export async function trackImport(client: ManagerClient, initial: OperationSnapshot, alive: () => boolean, onOperation: (value: OperationSnapshot) => void) {
  let value = initial;
  const deadline = Date.now() + 180000;
  while (alive()) {
    onOperation(value);
    if (!importPending(value)) return value;
    if (Date.now() >= deadline) throw new UiMessageError(uiMessage("导入仍在处理，请稍后核对主题库；不会重复提交。"));
    await new Promise<void>(resolve => window.setTimeout(resolve, 1500));
    if (alive()) value = await client.call("operations.get", { operationId: value.id });
  }
  throw new UiMessageError(uiMessage("窗口已关闭；已接受的任务仍由后端完成。"));
}
