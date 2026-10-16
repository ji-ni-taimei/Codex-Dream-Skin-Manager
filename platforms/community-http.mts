import https from "node:https";
import { ContractError } from "../contracts/manager.mjs";
import type { CommunityHTTP } from "../core/community.mjs";

// Bundled Node TLS adapter on both platforms. The UI cannot supply a URL,
// credentials, proxy, headers or a redirect policy.
export class FixedCommunityHTTP implements CommunityHTTP {
  private readonly pending = new Set<() => void>();
  private closed = false;
  read(version: string, download: boolean, maximum: number, expectedBytes?: number): Promise<Uint8Array> {
    if (this.closed || !/^ver_[a-z0-9]{8,64}$/.test(version)) return Promise.reject(new ContractError("INVALID_REQUEST", "Invalid community request."));
    const url = new URL(`https://api.dreamskin.cc/v1/themes/${version}${download ? "/download" : ""}`);
    return new Promise((resolve, reject) => {
      let settled = false; const chunks: Buffer[] = []; let length = 0;
      const finish = (error?: Error, bytes?: Uint8Array) => {
        if (settled) return; settled = true; clearTimeout(timer); this.pending.delete(cancel);
        if (error) { request.destroy(); reject(error); } else resolve(bytes!);
      };
      const request = https.get(url, { agent: false, timeout: 20000, maxHeaderSize: 16384,
        headers: { Accept: download ? "application/zip" : "application/json", "Accept-Encoding": "identity", "Cache-Control": "no-store" } }, response => {
        const type = response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
        const encoding = response.headers["content-encoding"];
        const declared = response.headers["content-length"];
        if (response.statusCode !== 200 || type !== (download ? "application/zip" : "application/json") ||
            (encoding !== undefined && encoding.toLowerCase() !== "identity") || response.headers.location !== undefined ||
            (declared !== undefined && (!/^[0-9]+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) < 1 || Number(declared) > maximum || (expectedBytes !== undefined && Number(declared) !== expectedBytes)))) {
          response.destroy(); finish(new ContractError("THEME_INVALID", "社区响应来源、格式、压缩或声明长度不符合要求。")); return;
        }
        response.on("data", (chunk: Buffer) => {
          length += chunk.byteLength;
          if (length > maximum) { response.destroy(); finish(new ContractError("THEME_INVALID", "社区响应超过允许大小。")); } else chunks.push(chunk);
        });
        response.on("end", () => {
          if (!response.complete || length < 1 || (declared !== undefined && length !== Number(declared)) || (expectedBytes !== undefined && length !== expectedBytes)) finish(new ContractError("THEME_INVALID", "社区响应不完整或大小不匹配。"));
          else finish(undefined, Buffer.concat(chunks, length));
        });
        response.on("error", () => finish(new ContractError("IO_ERROR", "社区下载连接中断；未自动重试。")));
        response.on("aborted", () => finish(new ContractError("IO_ERROR", "社区响应被中断。")));
      });
      const cancel = () => finish(new ContractError("BACKEND_UNAVAILABLE", "社区连接已关闭。"));
      const timer = setTimeout(() => finish(new ContractError("TIMEOUT", "社区请求超过 60 秒。")), 60000);
      this.pending.add(cancel);
      request.on("timeout", () => finish(new ContractError("TIMEOUT", "社区请求连接或读取超时。")));
      request.on("error", () => finish(new ContractError("IO_ERROR", "无法读取固定社区服务；未自动重试。")));
    });
  }
  close(): void { this.closed = true; for (const cancel of [...this.pending]) cancel(); }
}
