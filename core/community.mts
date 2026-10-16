import { randomBytes } from "node:crypto";
import { ContractError, record } from "../contracts/manager.mjs";
import type { CommunityDownload, CommunityMetadata, CommunityProposal } from "../contracts/manager.mjs";
import type { PackageSources } from "./package-sources.mjs";
import type { PackagePayload } from "./theme-package.mjs";

export interface CommunityHTTP {
  read(version: string, download: boolean, maximum: number, expectedBytes?: number): Promise<Uint8Array>;
  close(): void;
}
export function communityVersion(link: string): string {
  const match = /^dreamskin:\/\/apply\?version=(ver_[a-z0-9]{8,64})$/.exec(link);
  if (!match || match[0] !== link) throw new ContractError("INVALID_REQUEST", "只支持完整的 Dream Skin 社区应用链接。");
  return match[1]!;
}
function display(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value === value.trim() && [...value].length >= 1 && [...value].length <= maximum &&
    !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(value);
}
export function communityMetadata(bytes: Uint8Array, version: string): CommunityMetadata {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new ContractError("THEME_INVALID", "社区元数据不是有效的 UTF-8 JSON。"); }
  if (!record(value) || value.id !== version || !display(value.themeId, 80) || !display(value.name, 120) ||
      !display(value.authorDisplayName, 120) || !display(value.license, 80) || !display(value.version, 32) ||
      !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value.version) ||
      typeof value.packageSha256 !== "string" || value.packageSha256.length !== 64 || !/^[a-f0-9]{64}$/.test(value.packageSha256) ||
      !Number.isSafeInteger(value.packageBytes) || (value.packageBytes as number) < 1 || (value.packageBytes as number) > 160 * 1024 * 1024 || value.applyCompatible !== true) {
    throw new ContractError("THEME_INVALID", "社区元数据、大小、校验和或兼容性不符合要求。");
  }
  return { id: version, themeId: value.themeId, name: value.name, version: value.version, authorDisplayName: value.authorDisplayName,
    license: value.license, packageSha256: value.packageSha256, packageBytes: value.packageBytes as number, applyCompatible: true };
}
export function bindCommunityPayload(payload: PackagePayload, metadata: CommunityMetadata): void {
  const origin = payload.config.packageOrigin, manifest = record(origin) ? origin.manifest : null;
  if (payload.format !== "official" || !record(manifest) || !record(manifest.publisher) ||
      manifest.themeId !== metadata.themeId || manifest.version !== metadata.version || manifest.license !== metadata.license ||
      manifest.publisher.displayName !== metadata.authorDisplayName || payload.config.name !== metadata.name) {
    throw new ContractError("THEME_INVALID", "下载包的主题、版本、作者、名称或许可与已确认的社区元数据不一致。");
  }
}
interface Ticket { proposal: CommunityProposal; job?: Promise<CommunityDownload>; completed?: boolean }
export class Community {
  private readonly tickets = new Map<string, Ticket>();
  private inFlight = false;
  private closed = false;
  constructor(private readonly http: CommunityHTTP, private readonly packages: PackageSources) {}
  async inspect(link: string): Promise<CommunityProposal> {
    if (this.closed) throw new ContractError("BACKEND_UNAVAILABLE", "社区会话已关闭。");
    for (const [handle, ticket] of this.tickets) if ((!ticket.job || ticket.completed) && Date.parse(ticket.proposal.expiresAt) <= Date.now()) this.tickets.delete(handle);
    if (this.tickets.size >= 8) for (const [handle, ticket] of this.tickets) {
      if (ticket.completed) { this.tickets.delete(handle); break; }
    }
    if (this.tickets.size >= 8 || this.inFlight) throw new ContractError("BUSY", "请完成当前社区流程后再读取其他链接。");
    const version = communityVersion(link); this.inFlight = true;
    try {
      const metadata = communityMetadata(await this.http.read(version, false, 65536), version);
      if (this.closed) throw new ContractError("BACKEND_UNAVAILABLE", "社区会话已关闭。");
      const proposal: CommunityProposal = { handle: randomBytes(24).toString("hex"), expiresAt: new Date(Date.now() + 300000).toISOString(), source: "https://api.dreamskin.cc", metadata };
      this.tickets.set(proposal.handle, { proposal }); return structuredClone(proposal);
    } finally { this.inFlight = false; }
  }
  async download(handle: string): Promise<CommunityDownload> {
    const ticket = this.tickets.get(handle);
    if (this.closed || !ticket) throw new ContractError("RESOURCE_EXPIRED", "请重新读取社区链接并确认下载。");
    if (ticket.job) return ticket.job;
    if (Date.parse(ticket.proposal.expiresAt) <= Date.now()) throw new ContractError("RESOURCE_EXPIRED", "下载确认已过期，请重新读取链接。");
    if (this.inFlight) throw new ContractError("BUSY", "另一社区请求正在运行。");
    this.inFlight = true;
    ticket.job = (async () => {
      try {
        const meta = ticket.proposal.metadata;
        const bytes = await this.http.read(meta.id, true, meta.packageBytes, meta.packageBytes);
        if (this.closed) throw new ContractError("BACKEND_UNAVAILABLE", "社区会话已关闭。");
        return await this.packages.registerCommunity(bytes, meta);
      } finally { this.inFlight = false; ticket.completed = true; }
    })();
    // Failed approval is consumed as well. No implicit retry of network or writes.
    return ticket.job;
  }
  async close(): Promise<void> {
    this.closed = true; this.http.close();
    await Promise.allSettled([...this.tickets.values()].flatMap(ticket => ticket.job ? [ticket.job] : []));
    this.tickets.clear();
  }
}
