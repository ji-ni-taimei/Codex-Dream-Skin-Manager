import { MAX_MESSAGE_BYTES, PROTOCOL, record } from "../../../contracts/manager.mjs";
import type { HelloResult, ManagerError, ManagerMethod, MethodMap, ManagerEvent } from "../../../contracts/manager.mjs";

type Listener = (message: unknown) => void;
interface Transport { send(message: unknown): void; listen(listener: Listener): () => void }
declare global {
  interface Window {
    chrome?: { webview?: { postMessage(message: unknown): void;
      addEventListener(name: "message", callback: (event: MessageEvent) => void): void;
      removeEventListener(name: "message", callback: (event: MessageEvent) => void): void } };
    webkit?: { messageHandlers?: { manager?: { postMessage(message: unknown): void } } };
  }
}
function nativeTransport(): Transport {
  const windows = window.chrome?.webview;
  if (windows) return {
    send: message => windows.postMessage(message),
    listen: listener => { const handler = (event: MessageEvent) => listener(event.data);
      windows.addEventListener("message", handler); return () => windows.removeEventListener("message", handler); },
  };
  const mac = window.webkit?.messageHandlers?.manager;
  if (mac) return {
    send: message => mac.postMessage(message),
    listen: listener => { const handler = (event: Event) => listener((event as CustomEvent<unknown>).detail);
      window.addEventListener("dreamskin-message", handler); return () => window.removeEventListener("dreamskin-message", handler); },
  };
  throw new Error("请使用 Dream Skin 桌面管理器打开此页面。");
}
export function reconnectManager(): void { nativeTransport().send({ protocol: PROTOCOL, kind: "host.reconnect" }); }

export class BridgeError extends Error {
  constructor(readonly detail: ManagerError) { super(`${detail.code} · ${detail.message}`); }
}
export class ManagerClient {
  private readonly transport = nativeTransport();
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: number }>();
  private readonly unlisten: () => void;
  private closed = false;
  private session: string | null = null;
  private sequence = 0;
  private readonly events = new Set<(event: ManagerEvent) => void>();
  private readonly disconnects = new Set<() => void>();
  private readonly helloPromise: Promise<HelloResult>;
  constructor() {
    this.unlisten = this.transport.listen(message => this.receive(message));
    this.helloPromise = this.request("system.hello", {}).then(value => { this.session = value.backendSessionId; return value; });
  }
  hello(): Promise<HelloResult> { return this.helloPromise; }
  onEvent(listener: (event: ManagerEvent) => void): () => void { this.events.add(listener); return () => { this.events.delete(listener); }; }
  onDisconnected(listener: () => void): () => void { this.disconnects.add(listener); return () => { this.disconnects.delete(listener); }; }
  async call<M extends ManagerMethod>(method: M, params: MethodMap[M]["params"]): Promise<MethodMap[M]["result"]> {
    const hello = await this.helloPromise;
    if (!hello.capabilities.methods.includes(method)) throw new Error("当前管理器尚不支持此功能。");
    return this.request(method, params);
  }
  private request<M extends ManagerMethod>(method: M, params: MethodMap[M]["params"]): Promise<MethodMap[M]["result"]> {
    if (this.closed) return Promise.reject(new Error("管理器连接已关闭，请重新连接。"));
    if (this.pending.size >= 16) return Promise.reject(new Error("管理器忙，请稍后重试。"));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => { this.pending.delete(requestId);
        reject(new Error("管理器响应超时，请刷新状态；操作不会自动重试。")); }, method === "system.hello" ? 180000 : method.startsWith("files.") ? 1200000 : method === "community.download" ? 240000 : method === "updates.check" ? 180000 : method === "community.inspect" ? 90000 : 60000);
      this.pending.set(requestId, { resolve: value => resolve(value as MethodMap[M]["result"]), reject, timer });
      try { this.transport.send({ protocol: PROTOCOL, kind: "request", requestId, method, params }); }
      catch { window.clearTimeout(timer); this.pending.delete(requestId); reject(new Error("无法连接本地管理器。")); }
    });
  }
  private receive(message: unknown): void {
    if (!record(message) || message.protocol !== PROTOCOL ||
        new TextEncoder().encode(JSON.stringify(message)).byteLength > MAX_MESSAGE_BYTES) return;
    if (message.kind === "host.disconnected") { this.close(); return; }
    if (message.kind === "event") {
      if (message.backendSessionId !== this.session || !Number.isSafeInteger(message.sequence) || (message.sequence as number) <= this.sequence ||
          !["status.changed", "operation.changed", "status.invalidated", "session.closing"].includes(String(message.event))) return;
      if (message.event === "status.changed" && (!record(message.snapshot) || message.snapshot.backendSessionId !== this.session) ||
          message.event === "operation.changed" && !record(message.operation)) return;
      this.sequence = message.sequence as number;
      for (const listener of this.events) listener(message as unknown as ManagerEvent);
      if (message.event === "session.closing") this.close();
      return;
    }
    if (message.kind !== "response" || typeof message.requestId !== "string" || typeof message.ok !== "boolean") return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId); window.clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else if (record(message.error) && typeof message.error.code === "string" && typeof message.error.message === "string") {
      pending.reject(new BridgeError(message.error as unknown as ManagerError));
    } else pending.reject(new Error("管理器返回了无效响应。"));
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.unlisten();
    for (const pending of this.pending.values()) { window.clearTimeout(pending.timer); pending.reject(new Error("本地管理器连接中断，请重新连接。")); }
    this.pending.clear();
    for (const listener of this.disconnects) listener();
    this.events.clear(); this.disconnects.clear();
  }
}
