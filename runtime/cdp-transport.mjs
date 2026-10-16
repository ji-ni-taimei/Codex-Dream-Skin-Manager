// Shared CDP transport. Platform identity checks run before accepting targets;
// transport connectivity alone never proves the renderer or process identity.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const CDP_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

export function parseCdpMessage(data) {
  try {
    const message = JSON.parse(String(data));
    return message && typeof message === "object" ? message : null;
  } catch {
    return null;
  }
}

export function createCdpTransport({
  timeBudget = (requestedMs) => requestedMs,
  allowBrowserEndpoint = false,
  onListenerError = null,
} = {}) {
  function validatedDebuggerUrl(target, port) {
    const url = new URL(target.webSocketDebuggerUrl);
    const pathIsValid = allowBrowserEndpoint
      ? /^\/devtools\/(?:page|browser)\/[A-Za-z0-9._-]{1,200}$/.test(url.pathname)
      : /^\/devtools\/page\/[A-Za-z0-9._-]{1,200}$/.test(url.pathname);
    if (url.protocol !== "ws:" || !LOOPBACK_HOSTS.has(url.hostname) || Number(url.port) !== port ||
        url.username || url.password || url.search || url.hash || !pathIsValid) {
      throw new Error("Rejected a CDP WebSocket URL outside the allowed loopback endpoint shape");
    }
    return url.href;
  }

  function isValidCdpPageTarget(item, port) {
    if (item?.type !== "page" || typeof item.url !== "string" || !item.url.startsWith("app://") ||
        typeof item.id !== "string" || !CDP_ID_PATTERN.test(item.id) || !item.webSocketDebuggerUrl) return false;
    try {
      return new URL(validatedDebuggerUrl(item, port)).pathname === `/devtools/page/${item.id}`;
    } catch {
      return false;
    }
  }

  class CdpSession {
    constructor(target, port) {
      this.target = target;
      this.ws = new WebSocket(validatedDebuggerUrl(target, port));
      this.nextId = 1;
      this.pending = new Map();
      this.listeners = new Map();
      this.closed = false;
      // Keep error/close handlers installed even while opening or after an
      // open timeout: aborting a connecting socket can itself emit an error.
      this.ws.addEventListener("error", () => this.close());
      this.ws.addEventListener("close", () => {
        this.closed = true;
        this.rejectPending("CDP socket closed");
      });
    }

    async open() {
      try {
        const openTimeoutMs = timeBudget(5000);
        await new Promise((resolve, reject) => {
          const finish = (error) => {
            clearTimeout(timeout);
            this.ws.removeEventListener("open", onOpen);
            this.ws.removeEventListener("error", onError);
            this.ws.removeEventListener("close", onClose);
            if (error) reject(error);
            else resolve();
          };
          const onOpen = () => finish();
          const onError = () => finish(new Error("CDP WebSocket open failed"));
          const onClose = () => finish(new Error("CDP WebSocket closed before opening"));
          const timeout = setTimeout(() => finish(new Error("CDP WebSocket open timed out")), openTimeoutMs);
          this.ws.addEventListener("open", onOpen, { once: true });
          this.ws.addEventListener("error", onError, { once: true });
          this.ws.addEventListener("close", onClose, { once: true });
        });
        this.ws.addEventListener("message", (event) => this.onMessage(event));
        await this.send("Runtime.enable");
        await this.send("Page.enable");
        return this;
      } catch (error) {
        this.close();
        throw error;
      }
    }

    onMessage(event) {
      const message = parseCdpMessage(event.data);
      if (!message) {
        this.close();
        return;
      }
      if (message.id) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        clearTimeout(waiter.timeout);
        this.pending.delete(message.id);
        if (message.error) {
          const error = new Error(`${message.error.message} (${message.error.code})`);
          error.cdpCode = message.error.code;
          waiter.reject(error);
        } else waiter.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) {
        if (!onListenerError) listener(message.params ?? {});
        else {
          try { listener(message.params ?? {}); } catch (error) { onListenerError(error); }
        }
      }
    }

    on(method, listener) {
      const listeners = this.listeners.get(method) ?? [];
      listeners.push(listener);
      this.listeners.set(method, listeners);
    }

    send(method, params = {}, timeoutMs = 10000) {
      if (this.closed) return Promise.reject(new Error("CDP session is closed"));
      return new Promise((resolve, reject) => {
        const commandTimeoutMs = timeBudget(timeoutMs);
        const id = this.nextId++;
        const timeout = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`CDP command timed out: ${method}`));
        }, commandTimeoutMs);
        this.pending.set(id, { resolve, reject, timeout });
        try {
          this.ws.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          clearTimeout(timeout);
          this.pending.delete(id);
          reject(error);
        }
      });
    }

    async evaluate(expression, timeoutMs = 10000) {
      const result = await this.send("Runtime.evaluate", {
        expression, awaitPromise: true, returnByValue: true, userGesture: false,
      }, timeoutMs);
      if (result.exceptionDetails) {
        const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
        throw new Error(`Renderer evaluation failed: ${detail}`);
      }
      return result.result?.value;
    }

    rejectPending(message) {
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error(message));
      }
      this.pending.clear();
    }

    close() {
      this.rejectPending("CDP session closed");
      const wasClosed = this.closed;
      this.closed = true;
      if (!wasClosed) {
        try { this.ws.close(); } catch {}
      }
    }
  }

  async function fetchCdpJson(port, resource) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeBudget(2000));
    try {
      const response = await fetch(`http://127.0.0.1:${port}${resource}`, {
        redirect: "error", signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async function listAppTargets(port) {
    const targets = await fetchCdpJson(port, "/json/list");
    if (!Array.isArray(targets)) throw new Error("CDP target list is not an array");
    return targets.filter((item) => isValidCdpPageTarget(item, port));
  }

  async function connectTarget(target, port) {
    return new CdpSession(target, port).open();
  }

  return { CdpSession, validatedDebuggerUrl, isValidCdpPageTarget, fetchCdpJson, listAppTargets, connectTarget };
}
