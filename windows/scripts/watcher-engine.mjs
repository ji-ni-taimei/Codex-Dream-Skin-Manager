// These states describe the engine's intent, never verified renderer effects.
export class WatcherLifecycle {
  constructor({ sessionFor = (record) => record } = {}) {
    this.sessions = new Map();
    this.sessionFor = sessionFor;
    this.mode = "full";
    this.epoch = 0;
    this.activeTargetSetups = 0;
    this.targetSetupWaiters = new Set();
  }

  get stopping() { return this.mode === "stopping"; }
  get controlOnly() { return this.mode === "control"; }

  transition(mode, { invalidate = false } = {}) {
    if (!["full", "paused", "control", "stopping"].includes(mode)) {
      throw new Error(`Unknown watcher mode: ${mode}`);
    }
    // A late operation/payload callback cannot revive a stopped watcher.
    if (this.stopping) return this.epoch;
    if (this.mode !== mode || invalidate) this.epoch += 1;
    this.mode = mode;
    return this.epoch;
  }

  canMutate(epoch = this.epoch) {
    return !this.stopping && !this.controlOnly && epoch === this.epoch;
  }

  owns(id, session) {
    const record = this.sessions.get(id);
    return Boolean(record) && this.sessionFor(record) === session && !session.closed;
  }

  staleSessions(targets) {
    const activeIds = new Set(targets.map((target) => target.id));
    return [...this.sessions].filter(([id, record]) =>
      !activeIds.has(id) || this.sessionFor(record).closed);
  }

  beginTargetSetup() { this.activeTargetSetups += 1; }

  finishTargetSetup() {
    this.activeTargetSetups = Math.max(0, this.activeTargetSetups - 1);
    if (this.activeTargetSetups !== 0) return;
    for (const resolve of this.targetSetupWaiters) resolve();
    this.targetSetupWaiters.clear();
  }

  async waitForTargetSetups(timeoutMs = 2500) {
    if (this.activeTargetSetups === 0) return;
    let timeout;
    let release;
    const completed = new Promise((resolve) => {
      release = resolve;
      this.targetSetupWaiters.add(resolve);
    });
    try {
      await Promise.race([
        completed,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Renderer setup did not quiesce for pause")), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      this.targetSetupWaiters.delete(release);
    }
  }
}

// Brief reloads retain fast discovery; sustained downtime enters idle/dormant
// polling with slower logging, keeping an overnight watcher inexpensive.
export const DISCOVERY_BACKOFF = {
  initialMs: 100, factor: 1.6, ceilingMs: 500,
  idleAfterMs: 10000, idleCeilingMs: 5000,
  dormantAfterMs: 60000, dormantCeilingMs: 30000,
};

export function nextDiscoveryDelayMs(currentDelayMs, outageMs, config = DISCOVERY_BACKOFF) {
  const ceiling = outageMs >= config.dormantAfterMs
    ? config.dormantCeilingMs
    : outageMs >= config.idleAfterMs ? config.idleCeilingMs : config.ceilingMs;
  const base = Number.isFinite(currentDelayMs) && currentDelayMs > 0 ? currentDelayMs : config.initialMs;
  return Math.min(ceiling, Math.round(base * config.factor));
}

export function discoveryLogIntervalMs(delayMs, config = DISCOVERY_BACKOFF) {
  return Math.max(2000, Math.min(delayMs * 4, config.dormantCeilingMs * 2));
}

export function nextIdentityReconnectDelay(failures) {
  return Math.min(10000, 500 * (2 ** Math.min(Math.max(0, failures - 1), 5)));
}

export class DiscoveryRetry {
  constructor({ profile = "macos", config = DISCOVERY_BACKOFF } = {}) {
    this.profile = profile;
    this.config = config;
    this.lastLogAt = 0;
    this.succeed();
  }

  succeed() {
    this.failures = 0;
    this.outageSince = null;
    this.delayMs = this.config.initialMs;
  }

  fail(now = Date.now()) {
    this.failures += 1;
    this.outageSince ??= now;
    const delayMs = this.delayMs;
    this.delayMs = this.profile === "windows"
      ? Math.min(10000, 1000 * (2 ** Math.min(this.failures - 1, 4)))
      : nextDiscoveryDelayMs(delayMs, now - this.outageSince, this.config);
    // Mac sleeps the current delay before stepping it up; Windows immediately
    // sleeps the exponential delay. Preserve both launchers' existing timing.
    const retryMs = this.profile === "windows" ? this.delayMs : delayMs;
    const logInterval = this.profile === "windows" ? 30000 : discoveryLogIntervalMs(retryMs, this.config);
    const shouldLog = (this.profile === "windows" && this.failures === 1) || now - this.lastLogAt >= logInterval;
    if (shouldLog) this.lastLogAt = now;
    return { retryMs, shouldLog };
  }
}
