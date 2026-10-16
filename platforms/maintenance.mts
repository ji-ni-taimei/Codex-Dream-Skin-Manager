import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { lstat, rename } from "node:fs/promises";
import { ContractError } from "../contracts/manager.mjs";
import type { MaintenanceAction } from "../contracts/manager.mjs";
import type { MaintenanceCandidate, MaintenancePort } from "../core/maintenance.mjs";
import { fileBytes, optionalBytes, safePath, sha256 } from "../core/local-files.mjs";
import { durableJson, privateDirectory } from "../core/write-files.mjs";
import { stableVersion, newerVersion } from "../core/updates.mjs";
import { runtimePlatformCall } from "./apply.mjs";
import { transactionProcess } from "./transaction-process.mjs";

export class PlatformMaintenance implements MaintenancePort {
  constructor(private readonly root: string, private readonly state: string) {}
  private installed(): string { return path.join(os.homedir(), ".codex", "codex-dream-skin-studio"); }
  async inspect(): Promise<MaintenanceCandidate> {
    const bundled = stableVersion(Buffer.from(await fileBytes(path.join(this.root, "macos/VERSION"), this.root, 80)).toString().trim());
    const installedBytes = await optionalBytes(path.join(this.installed(), "VERSION"), os.homedir(), 80);
    const installed = installedBytes ? stableVersion(Buffer.from(installedBytes).toString().trim()) : null;
    const probe = await runtimePlatformCall(this.root, "Probe");
    const actions: MaintenanceAction[] = [];
    if (probe.processRunning === false && probe.recoveryRequired === false && (!installed || !newerVersion(installed, bundled))) actions.push("engine.install");
    if (installed && probe.recoveryRequired === false) actions.push("engine.uninstall");
    const parts: Uint8Array[] = [Buffer.from(JSON.stringify({ bundled, installed, fingerprint: probe.fingerprint }))];
    for (const relative of ["macos/scripts/install-dream-skin-macos.sh", "macos/scripts/restore-dream-skin-macos.sh", "macos/scripts/manager-maintenance.sh"]) parts.push(await fileBytes(path.join(this.root, relative), this.root, 1024 * 1024));
    return { info: { bundledVersion: bundled, installedVersion: installed, actions }, binding: sha256(parts) };
  }
  async execute(action: MaintenanceAction, candidate: MaintenanceCandidate, id: string): Promise<void> {
    const directory = path.join(this.state, "manager-operations/maintenance-requests"); await privateDirectory(directory);
    const request = path.join(directory, sha256([Buffer.from(id)]) + ".json");
    await durableJson(request, directory, { action, binding: candidate.binding }, true);
    const script = path.join(this.root, "macos/scripts/manager-maintenance.sh"); await safePath(script, this.root);
    const result = await transactionProcess("/bin/bash", [script, "execute", this.root, request], 1200000, true, { CODEX_MANAGER_RUNTIME_INTERNAL: "1" });
    if (result.completed !== true) throw new ContractError("IO_ERROR", "维护完成状态未确认。");
  }
  async retainEngine(): Promise<void> {
    const engine = this.installed(); await safePath(engine, os.homedir());
    if (!(await lstat(engine)).isDirectory()) throw new ContractError("IO_ERROR", "部署引擎目录身份无效。");
    const retained = path.join(path.dirname(engine), "dreamskin-retained"); await privateDirectory(retained);
    await rename(engine, path.join(retained, "engine-" + randomUUID()));
  }
}
