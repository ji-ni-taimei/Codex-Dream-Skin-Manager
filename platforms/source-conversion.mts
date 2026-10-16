import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ContractError } from "../contracts/manager.mjs";
import type { SourceConverter } from "../core/source-snapshots.mjs";

const run = promisify(execFile);
export function sourceConverter(platform: "windows" | "macos"): SourceConverter | undefined {
  if (platform !== "macos") return undefined;
  return async (source, destination) => {
    try {
      const dimensions = await run("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", source], { timeout: 30000, maxBuffer: 65536 });
      const width = Number(dimensions.stdout.match(/pixelWidth:\s*(\d+)/)?.[1]), height = Number(dimensions.stdout.match(/pixelHeight:\s*(\d+)/)?.[1]);
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 50000000) throw new Error();
      await run("/usr/bin/sips", ["-s", "format", "png", source, "--out", destination], { timeout: 30000, maxBuffer: 65536 });
    } catch { throw new ContractError("MEDIA_UNSUPPORTED", "The native image conversion failed or exceeded media limits."); }
  };
}
