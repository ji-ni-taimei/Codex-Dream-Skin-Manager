import path from "node:path";
import { randomBytes } from "node:crypto";
import { pruneHistory } from "./history-retention.mjs";
import { ContractError, failure, record, validOperationId } from "../contracts/manager.mjs";
import type { MaintenanceAction, MaintenanceInfo, MaintenanceOperation, MaintenanceProposal, MethodMap } from "../contracts/manager.mjs";
import { jsonObject, optionalBytes, sha256 } from "./local-files.mjs";
import { durableJson, privateDirectory } from "./write-files.mjs";

export interface MaintenanceCandidate { info: MaintenanceInfo; binding: string; }
export interface MaintenancePort { inspect(): Promise<MaintenanceCandidate>; execute(action: MaintenanceAction, candidate: MaintenanceCandidate, id: string): Promise<void>; }
interface Entry { digest: string; operation: MaintenanceOperation; }
const impacts: Record<MaintenanceAction, string> = {
  "engine.install": "安装或修复包内引擎到既有部署目录，可能重建预设和外观固定项。请先关闭 Codex；不启动 Codex，不创建桌面启动器。部署失败由原安装器恢复旧引擎。",
  "engine.uninstall": "先恢复原外观并脱离皮肤会话，必要时重启 Codex；成功后将部署引擎移入保留目录。保留主题、素材及原外观备份，不删除当前管理器 app；登录项需另行关闭。",
};
export class Maintenance {
  private readonly proposals = new Map<string, { result: MaintenanceProposal; candidate: MaintenanceCandidate }>();
  private readonly live = new Map<string, Entry>();
  private readonly jobs = new Set<Promise<void>>();
  private active: string | null = null;
  private closed = false;
  private readonly directory: string;
  constructor(private readonly session: string, state: string, private readonly port: MaintenancePort, private readonly otherBusy: () => boolean) {
    this.directory = path.join(state, "manager-operations", "maintenance-ledger");
  }
  get busy(): boolean { return this.active !== null; }
  get activeIds(): string[] { return this.active ? [this.active] : []; }
  inspect(): Promise<MaintenanceCandidate> { return this.port.inspect(); }
  private file(id: string): string {
    if (!validOperationId(id)) throw new ContractError("INVALID_REQUEST", "Invalid maintenance identity.");
    return path.join(this.directory, sha256([Buffer.from(id)]) + ".json");
  }
  private async read(id: string): Promise<Entry | null> {
    const bytes = await optionalBytes(this.file(id), this.directory, 16384); if (!bytes) return null;
    const value = jsonObject(bytes), op = value.operation;
    if (typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest) || !record(op) || op.id !== id ||
        !["engine.install", "engine.uninstall"].includes(String(op.action)) || !["queued", "running", "succeeded", "failed", "indeterminate"].includes(String(op.state)) ||
        typeof op.stage !== "string" || typeof op.startedAt !== "string" || typeof op.updatedAt !== "string") throw new ContractError("IO_ERROR", "维护记录无效。");
    return value as unknown as Entry;
  }
  async prepare(action: MaintenanceAction): Promise<MaintenanceProposal> {
    if (this.closed || this.busy || this.otherBusy()) throw new ContractError("BUSY", "请等待当前任务结束。");
    const candidate = await this.port.inspect();
    if (!candidate.info.actions.includes(action)) throw new ContractError("METHOD_UNSUPPORTED", "当前平台或状态不支持此维护操作。");
    for (const [handle, proposal] of this.proposals) if (Date.parse(proposal.result.expiresAt) <= Date.now()) this.proposals.delete(handle);
    if (this.proposals.size >= 8) this.proposals.delete(this.proposals.keys().next().value!);
    const result: MaintenanceProposal = { handle: randomBytes(24).toString("hex"), expiresAt: new Date(Date.now() + 300000).toISOString(), action, impact: impacts[action] };
    this.proposals.set(result.handle, { result, candidate }); return result;
  }
  async execute(params: MethodMap["maintenance.execute"]["params"]): Promise<MaintenanceOperation> {
    const digest = sha256([Buffer.from(JSON.stringify([params.handle, params.accepted]))]);
    const known = this.live.get(params.operationId) ?? await this.read(params.operationId);
    if (known) { if (known.digest !== digest) throw new ContractError("OPERATION_CONFLICT", "维护 ID 已用于其他批准。"); return this.get(params.operationId); }
    if (this.closed || !params.operationId.startsWith(this.session + ":")) throw new ContractError("OPERATION_UNKNOWN", "维护需要当前会话。");
    if (this.busy || this.otherBusy()) throw new ContractError("BUSY", "其他操作尚未结束。");
    const proposal = this.proposals.get(params.handle);
    if (!proposal || Date.parse(proposal.result.expiresAt) <= Date.now()) throw new ContractError("RESOURCE_EXPIRED", "维护批准已过期。");
    await privateDirectory(this.directory);
    await pruneHistory(this.directory, ["succeeded", "failed"]);
    const now = new Date().toISOString(), value: Entry = { digest, operation: { id: params.operationId, action: proposal.result.action, state: "queued", stage: "approved", startedAt: now, updatedAt: now, error: null } };
    await durableJson(this.file(params.operationId), this.directory, value, true);
    this.live.set(params.operationId, value); this.active = params.operationId; this.proposals.delete(params.handle);
    const job = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      let started = false;
      try {
        const current = await this.port.inspect();
        if (current.binding !== proposal.candidate.binding || !current.info.actions.includes(value.operation.action)) throw new ContractError("RUNTIME_CHANGED", "维护目标已改变，请重新准备。");
        await this.update(value, { state: "running", stage: "platformMaintenance" }); started = true;
        await this.port.execute(value.operation.action, current, params.operationId);
        await this.update(value, { state: "succeeded", stage: "platformCompleted" });
      } catch (error) {
        const response = failure(null, error);
        try { await this.update(value, { state: started ? "indeterminate" : "failed", stage: started ? "reconciliationRequired" : "preconditionChanged", error: response.ok ? null : response.error }); }
        catch { value.operation.state = "indeterminate"; value.operation.stage = "journalUnavailable"; }
      } finally { this.active = null; if (["succeeded", "failed"].includes(value.operation.state)) this.live.delete(value.operation.id); }
    });
    this.jobs.add(job); void job.finally(() => this.jobs.delete(job)); return structuredClone(value.operation);
  }
  private async update(value: Entry, patch: Partial<MaintenanceOperation>): Promise<void> {
    value.operation = { ...value.operation, ...patch, updatedAt: new Date().toISOString() }; await durableJson(this.file(value.operation.id), this.directory, value);
  }
  async get(id: string): Promise<MaintenanceOperation> {
    const value = this.live.get(id) ?? await this.read(id);
    if (!value) throw new ContractError("OPERATION_UNKNOWN", "维护记录不在保留范围内。");
    const result = structuredClone(value.operation);
    if (!this.live.has(id) && ["queued", "running"].includes(result.state)) { result.state = "indeterminate"; result.stage = "previousSessionInterrupted"; }
    return result;
  }
  async close(): Promise<void> { this.closed = true; this.proposals.clear(); await Promise.allSettled([...this.jobs]); }
}
