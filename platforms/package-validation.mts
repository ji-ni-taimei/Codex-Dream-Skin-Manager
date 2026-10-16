import path from "node:path";
import { pathToFileURL } from "node:url";
import { ContractError } from "../contracts/manager.mjs";
import type { PackageValidation } from "../core/theme-package.mjs";
import { safePath } from "../core/local-files.mjs";
import { mediaInspector } from "./media-metadata.mjs";
import { transactionProcess } from "./transaction-process.mjs";

export function packageValidation(root: string, platform: "windows" | "macos", version: () => Promise<string | null>): PackageValidation {
  const load = async (name: string) => {
    const file = path.join(root, platform, "assets", name + ".mjs"); await safePath(file, root); return import(pathToFileURL(file).href);
  };
  return { platform, inspect: mediaInspector(root, platform),
    async css(bytes) {
      try { (await load("safe-css-validator")).decodeAndValidateSafeCss(Buffer.from(bytes)); }
      catch { throw new ContractError("THEME_INVALID", "The package contains unsupported Safe CSS."); }
    },
    async legacyZip(files) {
      try {
        const clientVersion = await version(); if (!clientVersion) throw new Error();
        return await (await load("theme-package-validator")).validateThemePackageBytes(files, platform, clientVersion);
      } catch { throw new ContractError("THEME_INVALID", "The ZIP failed its manifest, version, platform, hash or Safe CSS rules."); }
    },
    async payload(directory) {
      if (platform !== "macos") return;
      const script = path.join(root, "macos", "scripts", "injector.mjs"); await safePath(script, root);
      try { await transactionProcess(process.execPath, [script, "--check-payload", "--theme-dir", directory], 120000, false); }
      catch { throw new ContractError("THEME_INVALID", "The existing Mac payload compiler refused this package."); }
    },
  };
}
