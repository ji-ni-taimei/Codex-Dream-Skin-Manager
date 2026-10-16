import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";

const MAX_MEDIA_CACHE_BYTES = 256 * 1024 * 1024;
const MAX_MEDIA_CACHE_FILES = 16;
const STALE_MEDIA_TEMP_MS = 60 * 60 * 1000;
const MEDIA_CACHE_PARENT = process.platform === "win32"
  ? path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "CodexDreamSkinManager", "media-v1",
    )
  : process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Caches", "CodexDreamSkinManager", "media-v1")
    : path.join(os.homedir(), ".cache", "codex-dream-skin", "media-v1");
const MEDIA_CACHE_INSTANCE = `${process.pid}.${randomUUID()}`;
export const MEDIA_CACHE_ROOT = path.join(MEDIA_CACHE_PARENT, MEDIA_CACHE_INSTANCE);
const MEDIA_CACHE_HEARTBEAT_MS = 30000;
const MEDIA_CACHE_STALE_MS = 10 * 60 * 1000;
let mediaCacheHeartbeat = null;

export function sameFileStat(left, right) {
  return left.isFile() && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function verifyMediaSnapshot(snapshotPath, expectedBytes) {
  let handle;
  try {
    handle = await fs.open(snapshotPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.size !== expectedBytes.length) {
      throw new Error("Validated media snapshot has an unexpected file type or size");
    }
    const actualBytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFileStat(before, after) || !actualBytes.equals(expectedBytes)) {
      throw new Error("Validated media snapshot content does not match the checked media");
    }
  } finally {
    await handle?.close();
  }
}

async function removeCachedMediaFile(filePath) {
  try {
    await fs.chmod(filePath, 0o600);
    await fs.unlink(filePath);
  } catch (error) {
    if (!["ENOENT", "EBUSY", "EPERM"].includes(error?.code)) throw error;
  }
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function cleanStaleMediaCacheInstances() {
  const entries = await fs.readdir(MEDIA_CACHE_PARENT, { withFileTypes: true });
  const staleBefore = Date.now() - MEDIA_CACHE_STALE_MS;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === MEDIA_CACHE_INSTANCE) continue;
    const match = /^(\d+)\.([0-9a-f-]{36})$/.exec(entry.name);
    if (!match) continue;
    const instancePath = path.join(MEDIA_CACHE_PARENT, entry.name);
    let activityStat;
    try {
      activityStat = await fs.stat(path.join(instancePath, ".lease"));
    } catch (error) {
      if (error?.code !== "ENOENT") continue;
      try {
        activityStat = await fs.stat(instancePath);
      } catch {
        continue;
      }
    }
    if (activityStat.mtimeMs >= staleBefore || processIsRunning(Number(match[1]))) continue;
    await fs.rm(instancePath, {
      recursive: true, force: true, maxRetries: 2, retryDelay: 50,
    }).catch(() => {});
  }
}

async function ensureMediaCacheRoot(mediaCacheRoot) {
  await fs.mkdir(mediaCacheRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(mediaCacheRoot, 0o700);
  if (mediaCacheRoot !== MEDIA_CACHE_ROOT) return;
  const leasePath = path.join(MEDIA_CACHE_ROOT, ".lease");
  await fs.writeFile(leasePath, `${process.pid}\n`, { mode: 0o600 });
  if (!mediaCacheHeartbeat) {
    mediaCacheHeartbeat = setInterval(() => {
      const now = new Date();
      fs.utimes(leasePath, now, now).catch(() => {});
    }, MEDIA_CACHE_HEARTBEAT_MS);
    mediaCacheHeartbeat.unref?.();
  }
  await cleanStaleMediaCacheInstances();
}

async function pruneMediaCache(mediaCacheRoot, retainedPath) {
  const entries = await fs.readdir(mediaCacheRoot, { withFileTypes: true });
  const snapshots = [];
  const staleBefore = Date.now() - STALE_MEDIA_TEMP_MS;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const entryPath = path.join(mediaCacheRoot, entry.name);
    if (/^[a-f0-9]{64}\.(?:mp4|png|apng|jpg|jpeg|webp|gif)$/.test(entry.name)) {
      const stat = await fs.lstat(entryPath);
      if (stat.isFile()) snapshots.push({ path: entryPath, size: stat.size, mtimeMs: stat.mtimeMs });
      continue;
    }
    if (/^\.[a-f0-9]{64}\.\d+\.[0-9a-f-]{36}\.tmp$/.test(entry.name)) {
      const stat = await fs.lstat(entryPath);
      if (stat.isFile() && stat.mtimeMs < staleBefore) await removeCachedMediaFile(entryPath);
    }
  }
  snapshots.sort((left, right) => {
    if (left.path === retainedPath) return -1;
    if (right.path === retainedPath) return 1;
    return right.mtimeMs - left.mtimeMs;
  });
  let retainedBytes = 0;
  let retainedFiles = 0;
  for (const snapshot of snapshots) {
    const keep = snapshot.path === retainedPath || (
      retainedFiles < MAX_MEDIA_CACHE_FILES &&
      retainedBytes + snapshot.size <= MAX_MEDIA_CACHE_BYTES
    );
    if (keep) {
      retainedFiles += 1;
      retainedBytes += snapshot.size;
    } else {
      await removeCachedMediaFile(snapshot.path);
    }
  }
}

export async function materializeMediaSnapshot(mediaBytes, mediaCacheRoot = MEDIA_CACHE_ROOT, extension = ".mp4") {
  if (![".mp4", ".png", ".apng", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension)) {
    throw new Error("Unsupported media snapshot extension");
  }
  const digest = createHash("sha256").update(mediaBytes).digest("hex");
  await ensureMediaCacheRoot(mediaCacheRoot);
  const snapshotPath = path.join(mediaCacheRoot, `${digest}${extension}`);
  try {
    await verifyMediaSnapshot(snapshotPath, mediaBytes);
    await fs.chmod(snapshotPath, 0o400);
    const realSnapshotPath = await fs.realpath(snapshotPath);
    await pruneMediaCache(mediaCacheRoot, realSnapshotPath);
    return realSnapshotPath;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const temporaryPath = path.join(
    mediaCacheRoot, `.${digest}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporaryPath, mediaBytes, { flag: "wx", mode: 0o600 });
    await fs.chmod(temporaryPath, 0o400);
    try {
      await fs.rename(temporaryPath, snapshotPath);
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
      await verifyMediaSnapshot(snapshotPath, mediaBytes);
    }
  } finally {
    await fs.unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  await fs.chmod(snapshotPath, 0o400);
  await verifyMediaSnapshot(snapshotPath, mediaBytes);
  const realSnapshotPath = await fs.realpath(snapshotPath);
  await pruneMediaCache(mediaCacheRoot, realSnapshotPath);
  return realSnapshotPath;
}
