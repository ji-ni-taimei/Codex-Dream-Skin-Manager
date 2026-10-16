import { translateText } from "./ui-copy";
import { BridgeError } from "./client";

// Plain strings are diagnostics or user data and must never enter the catalog.
export type UiMessage = string | { key: string; values?: Record<string, string | number | { key: string }>;
  before?: UiMessage; after?: UiMessage };
export function uiMessage(key: string, values?: Exclude<UiMessage, string>["values"],
  parts: { before?: UiMessage; after?: UiMessage } = {}): UiMessage {
  return { key, ...(values === undefined ? {} : { values }), ...parts };
}
export function renderMessage(language: "zh-CN" | "en-US", message: UiMessage): string {
  if (typeof message === "string") return message;
  const values = Object.fromEntries(Object.entries(message.values ?? {}).map(([key, value]) =>
    [key, typeof value === "object" ? translateText(language, value.key) : value]));
  return (message.before ? renderMessage(language, message.before) : "") + translateText(language, message.key, values) +
    (message.after ? renderMessage(language, message.after) : "");
}
export class UiMessageError extends Error {
  constructor(readonly uiMessage: UiMessage) { super(renderMessage("zh-CN", uiMessage)); }
}
export function errorMessage(error: unknown, fallback: string): UiMessage {
  return error instanceof UiMessageError ? error.uiMessage : error instanceof BridgeError ? error.detail.message : error instanceof Error ? error.message : uiMessage(fallback);
}
