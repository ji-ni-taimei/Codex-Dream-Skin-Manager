import path from "node:path";
import { pathToFileURL } from "node:url";
import { ContractError } from "../contracts/manager.mjs";
import { safePath } from "../core/local-files.mjs";

export function mediaInspector(root: string, platform: "windows" | "macos") {
  let module: Promise<Record<string, any>> | undefined;
  return async (bytes: Uint8Array, extension: string): Promise<void> => {
    if (!module) {
      const file = path.join(root, platform, "scripts", "image-metadata.mjs");
      module = safePath(file, root).then(() => import(pathToFileURL(file).href));
    }
    const metadata = await module;
    const source = Buffer.from(bytes), size = metadata.readImageMetadata(source, extension), animation = metadata.readImageAnimation(source, extension);
    if (!size || !animation || animation.frameCount > metadata.MAX_IMAGE_FRAMES) {
      throw new ContractError("MEDIA_UNSUPPORTED", "The media format or dimensions exceed the existing preview limits.");
    }
  };
}
