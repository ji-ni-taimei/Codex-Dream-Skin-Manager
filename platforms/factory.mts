import { transactionProcess } from "./transaction-process.mjs";
import os from "node:os";
import path from "node:path";
import { ContractError } from "../contracts/manager.mjs";
import type { PlatformPort } from "../core/ports/platform.mjs";
import { WindowsReadAdapter } from "./windows/read-adapter.mjs";
import { MacOSReadAdapter } from "./macos/read-adapter.mjs";

export function dataRoot(): string {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (!local || !path.isAbsolute(local)) throw new ContractError("BACKEND_UNAVAILABLE", "LOCALAPPDATA is unavailable.");
    return path.join(local, "CodexDreamSkin");
  }
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "CodexDreamSkinStudio");
  throw new ContractError("BACKEND_UNAVAILABLE", "This desktop backend supports Windows and macOS only.");
}
export function readAdapter(root: string): PlatformPort {
  const state = dataRoot();
  return process.platform === "win32" ? new WindowsReadAdapter(root, state) : new MacOSReadAdapter(root, state);
}

export async function initialize(root: string): Promise<void> {
  if (process.platform !== "darwin") return;
  await transactionProcess("/bin/bash", [path.join(root, "macos", "scripts", "seed-gui-presets-macos.sh")], 120000, true);
}
