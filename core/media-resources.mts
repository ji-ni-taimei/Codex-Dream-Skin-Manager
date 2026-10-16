import { randomBytes, createHash } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { ContractError, PROTOCOL } from "../contracts/manager.mjs";
import type { MediaResource, MethodMap } from "../contracts/manager.mjs";
import { MAX_MEDIA_BYTES, safePath } from "./local-files.mjs";
import type { LocalTheme } from "./ports/platform.mjs";
import { readThemeContent } from "./theme-model.mjs";

// Private native transport: never relay this envelope to the web page.
export interface ResourceRegistration {
  protocol: typeof PROTOCOL; kind: "resource.register"; backendSessionId: string;
  resourceId: string; fileName: string; sha256: string; variant: "thumbnail" | "preview"; expiresAt: string;
}
export interface ResourceRelease {
  protocol: typeof PROTOCOL; kind: "resource.release"; backendSessionId: string; resourceId: string;
}
export class MediaResources {
  private readonly files = new Map<string, { file: string; expires: number; key: string; session: string; result: MediaResource }>();
  private totalBytes = 0;
  private readonly sizes = new Map<string, number>();
  private readonly cleanup = setInterval(() => {
    for (const [id, file] of this.files) if (file.expires <= Date.now()) void this.remove(id).catch(() => {});
  }, 30000).unref();
  constructor(private readonly directory: string, private readonly origin: string,
    private readonly register: (message: ResourceRegistration | ResourceRelease) => Promise<void>,
    private readonly inspect: (bytes: Uint8Array, extension: string) => Promise<void>) {
    if (!path.isAbsolute(directory) || !["https://media.dreamskin.invalid", "dreamskin-media://resource"].includes(origin)) {
      throw new ContractError("INVALID_REQUEST", "Invalid native media configuration.");
    }
  }
  async resolve(local: LocalTheme, params: MethodMap["media.resolve"]["params"], session: string): Promise<MediaResource> {
    await safePath(this.directory, this.directory);
    const { details, media } = await readThemeContent(local);
    if (details.revision !== params.revision) throw new ContractError("THEME_CHANGED", "Refresh the theme before previewing it.", true);
    const now = Date.now();
    for (const [id, file] of this.files) if (file.expires <= now) await this.remove(id);
    const key = `${local.ref.source}:${local.ref.id}:${params.revision}:${params.variant}`;
    const cached = this.cached(key, now); if (cached) return cached;
    return this.resolveBytes(media, path.extname(local.mediaPath).toLowerCase(), key, params.variant, session);
  }
  async resolveBytes(bytes: Uint8Array, extension: string, key: string, variant: "thumbnail" | "preview", session: string): Promise<MediaResource> {
    await safePath(this.directory, this.directory);
    for (const [id, file] of this.files) if (file.expires <= Date.now()) await this.remove(id);
    const cached = this.cached(key, Date.now()); if (cached) return cached;
    if (!bytes.byteLength || bytes.byteLength > MAX_MEDIA_BYTES) throw new ContractError("MEDIA_UNSUPPORTED", "Preview media exceeds its size limit.");
    await this.inspect(bytes, extension);
    // Map order tracks use. Evict old entries instead of blocking browsing
    // until the five-minute authorization expires.
    while (this.files.size >= 64 || this.totalBytes + bytes.byteLength > 256 * 1024 * 1024) {
      await this.remove(this.files.keys().next().value!);
    }
    const resourceId = randomBytes(24).toString("hex");
    const fileName = resourceId + extension;
    const file = path.join(this.directory, fileName), expires = Date.now() + 5 * 60 * 1000;
    const result: MediaResource = { resourceId, url: `${this.origin}/${resourceId}`, mimeType: "image/png", expiresAt: new Date(expires).toISOString() };
    await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
    this.files.set(resourceId, { file, expires, key, session, result });
    this.sizes.set(resourceId, bytes.byteLength); this.totalBytes += bytes.byteLength;
    try {
      await this.register({ protocol: PROTOCOL, kind: "resource.register", backendSessionId: session,
        resourceId, fileName, sha256: createHash("sha256").update(bytes).digest("hex"), variant, expiresAt: result.expiresAt });
    } catch (error) { await this.remove(resourceId); throw error; }
    return result;
  }
  private cached(key: string, now: number): MediaResource | null {
    for (const [id, file] of this.files) if (file.key === key && file.expires > now + 30000) {
      this.files.delete(id); this.files.set(id, file);
      return file.result;
    }
    return null;
  }
  private async remove(id: string): Promise<void> {
    const entry = this.files.get(id);
    if (!entry) return;
    // Claim removal before yielding so timer/eviction/close cannot double-count.
    this.totalBytes -= this.sizes.get(id) ?? 0; this.sizes.delete(id); this.files.delete(id);
    try {
      await this.register({ protocol: PROTOCOL, kind: "resource.release", backendSessionId: entry.session, resourceId: id });
    } finally {
      try { await unlink(entry.file); } catch { /* native host also cleans its own session directory on exit */ }
    }
  }
  async close(): Promise<void> { clearInterval(this.cleanup); for (const id of this.files.keys()) await this.remove(id).catch(() => {}); }
}
