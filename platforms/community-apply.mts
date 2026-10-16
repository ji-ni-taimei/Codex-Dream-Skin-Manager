import { powerShellArgs } from "./windows/powershell.mjs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ContractError } from "../contracts/manager.mjs";
import type { ThemeRef } from "../contracts/manager.mjs";
import type { ApplyOutcome, ApplyPreflight } from "../core/ports/apply.mjs";
import { activeTheme } from "../core/active-theme.mjs";
import { themeDetails } from "../core/theme-model.mjs";
import { safePath, sha256 } from "../core/local-files.mjs";
import { durableJson, privateDirectory } from "../core/write-files.mjs";
import { PlatformApply, runtimePlatformCall } from "./apply.mjs";
import { transactionProcess } from "./transaction-process.mjs";

export class CommunityApply extends PlatformApply {
  private async binding(): Promise<{ fingerprint: string; activeRevision: string; activeId: string; digest: string }> {
    const before = await runtimePlatformCall(this.root, "Probe");
    if (before.startRequired !== false || before.recoveryRequired !== false || before.paused !== false || typeof before.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(before.fingerprint)) throw new ContractError("RUNTIME_UNAVAILABLE", "社区应用需要可核验的活动原主题。请先在控制台继续或修复皮肤会话。");
    const active = await activeTheme(this.state, process.platform === "win32" ? "windows" : "macos");
    if (!active) throw new ContractError("RUNTIME_UNAVAILABLE", "没有可保存用于回滚的活动主题。");
    const details = await themeDetails(active), after = await runtimePlatformCall(this.root, "Probe");
    if (before.fingerprint !== after.fingerprint) throw new ContractError("RUNTIME_CHANGED", "读取社区应用基线时，Codex 会话已改变。");
    return { fingerprint: before.fingerprint, activeRevision: details.revision, activeId: active.ref.id,
      digest: sha256([Buffer.from(JSON.stringify([before.fingerprint, details.revision, active.ref.id]))]) };
  }
  override async preflight(_theme: ThemeRef, _revision: string): Promise<ApplyPreflight> {
    const binding = await this.binding();
    return { fingerprint: binding.digest, requiresConfirmation: true, reason: "应用社区主题前将保存当前主题的完整回滚快照。",
      impact: process.platform === "win32" ? "需要启动或重启 Codex，当前工作可能中断。失败时尝试恢复原主题并核验；结果未知时保留恢复材料。" : "会切换正在显示的皮肤；失败时尝试恢复原主题并核验。无法确认时保留恢复材料，不自动重复应用。" };
  }
  override async apply(theme: ThemeRef, expectedRevision: string, preflight: ApplyPreflight, confirmed: boolean, operationId?: string): Promise<ApplyOutcome> {
    if (!confirmed) throw new ContractError("INVALID_REQUEST", "社区应用需要独立确认。");
    const refused: ApplyOutcome = { effects: { themeCommitted: false, rendererApplied: false, codexRestarted: false, rollbackVerified: false }, committedRevision: null, verifiedRendererRevision: null, runtimeSessionId: null };
    const binding = await this.binding().catch(() => null);
    if (!binding || preflight.fingerprint !== binding.digest) return refused;
    const directory = path.join(this.state, "manager-operations", "requests"); await privateDirectory(directory);
    const file = path.join(directory, randomUUID() + ".json");
    const recoveryTransaction = ".community-apply-" + randomUUID();
    await durableJson(file, directory, { schemaVersion: 1, theme, expectedRevision, confirmed, operationId,
      preflightFingerprint: binding.fingerprint, community: { activeRevision: binding.activeRevision, activeId: binding.activeId, recoveryTransaction } }, true);
    const windows = process.platform === "win32";
    const script = path.join(this.root, windows ? "windows" : "macos", "scripts", windows ? "manager-community.ps1" : "manager-community.sh");
    await safePath(script, this.root);
    const system = process.env.SystemRoot;
    if (windows && (!system || !path.isAbsolute(system))) throw new ContractError("BACKEND_UNAVAILABLE", "Windows system directory unavailable.");
    const executable = windows ? path.join(system!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "/bin/bash";
    const args = windows ? await powerShellArgs(this.root, script, ["-ApplicationRoot", this.root, "-RequestPath", file]) : [script, this.root, file];
    let outcome: ApplyOutcome;
    try { outcome = this.outcome(await transactionProcess(executable, args, 720000, true, { CODEX_MANAGER_RUNTIME_INTERNAL: "1" })); }
    catch { outcome = { effects: { themeCommitted: null, rendererApplied: null, codexRestarted: null, rollbackVerified: null }, committedRevision: null, verifiedRendererRevision: null, runtimeSessionId: null, recoveryTransaction }; }
    return this.saveOutcome(file, theme, expectedRevision, outcome, operationId);
  }
}
