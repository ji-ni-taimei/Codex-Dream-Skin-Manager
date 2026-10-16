import { ContractError } from "../contracts/manager.mjs";
import type { RuntimeCommand } from "../contracts/manager.mjs";
import type { RuntimePreflight, RuntimeState } from "./ports/runtime.mjs";

export function runtimePreflight(command: RuntimeCommand, runtime: RuntimeState): RuntimePreflight {
  if (["skin.restore", "runtime.upgrade"].includes(command.method) && command.params.expectedRuntimeRevision !== runtime.revision) throw new ContractError("RUNTIME_CHANGED", "The runtime changed; refresh before starting a new command.");
  const restore = command.method === "skin.restore", repair = command.method === "runtime.repair", reset = command.method === "skin.reset", upgrade = command.method === "runtime.upgrade";
  if (upgrade && (!runtime.engineRevision || !runtime.upgradeRequired || runtime.paused || runtime.recoveryRequired)) throw new ContractError("RUNTIME_UNAVAILABLE", "Upgrade requires an outdated engine, a complete package, an active skin and a safe runtime identity.");
  const targetTheme = restore ? null : reset ? runtime.defaultTheme : runtime.activeTheme;
  const targetRevision = restore ? null : reset ? runtime.defaultRevision : runtime.activeRevision;
  if (restore ? !runtime.restoreAvailable : runtime.recoveryRequired && !repair || command.method !== "skin.pause" && !targetTheme || repair && runtime.paused) {
    throw new ContractError("RUNTIME_UNAVAILABLE", restore ? "A selective appearance backup and current config are required." : repair && runtime.paused ? "Resume the skin explicitly before repairing its connection." : "The required theme or a safe runtime connection is unavailable.");
  }
  const requiresConfirmation = restore || upgrade || command.method !== "skin.pause" && (runtime.startRequired || repair && runtime.recoveryRequired);
  return { runtime, targetTheme, targetRevision, fingerprint: runtime.revision, requiresConfirmation,
    copy: { kind: upgrade ? "upgradeRuntime" : restore ? "restoreAppearance" : repair ? "repairRestart" : reset ? "resetRestart" : "resumeRestart" },
    reason: upgrade ? "将皮肤运行时交接到当前完整包的引擎，可能关闭并重启 Codex。" : restore ? "恢复安装前的原始外观，需要停止皮肤会话，并可能关闭后正常重开 Codex。" : repair ? "连接修复需要启动或重启 Codex。" : reset ? "应用默认主题需要启动或重启 Codex。" : "继续当前皮肤需要启动或重启 Codex。",
    impact: restore ? "仅还原皮肤管理的外观配置键，保留其他配置、主题库和活动副本；安装前备份将归档。正在进行的工作可能中断。" : "正在进行的 Codex 工作可能中断。确认仅绑定当前进程、浏览器会话、配置和目标内容；执行前会再次检查。" };
}
