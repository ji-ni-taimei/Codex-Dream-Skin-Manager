// Maintainer-only asset preparation. FFmpeg is not a runtime dependency.
import { createHash } from "node:crypto";
import { readdir, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "windows", "assets", "video-posters");
await mkdir(destination, { recursive: true });
async function generate(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { await generate(file); continue; }
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".mp4") continue;
    const digest = createHash("sha256").update(await readFile(file)).digest("hex");
    execFileSync(process.env.DREAM_SKIN_FFMPEG || "ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-threads", "2", "-i", file,
      "-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-dn", "-vf",
      "scale=1200:1200:force_original_aspect_ratio=decrease", "-threads", "2", "-q:v", "3",
      path.join(destination, digest + ".jpg"),
    ], { windowsHide: true, timeout: 30000, stdio: "pipe" });
    console.log(path.relative(root, file) + " -> " + digest + ".jpg");
  }
}
await generate(path.join(root, "windows", "presets"));
