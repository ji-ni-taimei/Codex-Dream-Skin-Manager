#!/usr/bin/env node

// Build-time only. No platform script, installed engine, or network is invoked.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { runtimeAssetOutputs } from "./sync-runtime-assets.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = "packaging/shared-resources.json";
const receiptPath = "shared-resource-inventory.json";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function relativeName(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) ||
      value.split("/").some((part) => part === "." || part === "..")) {
    throw new Error(`Invalid resource path: ${String(value)}`);
  }
  return value;
}

// Reject links at every component, including existing output parents. Copying
// bytes into a hard-linked inherited file could otherwise change the old pack.
async function regularPath(root, relative, missing = false) {
  relativeName(relative);
  let current = root;
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Resource root must be a real directory.");
  const parts = relative.split("/");
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    const stat = await fs.lstat(current).catch((error) => {
      if (missing && error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) continue;
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
      throw new Error(`Linked or invalid resource: ${relative}`);
    }
  }
  return current;
}

async function readResource(relative) {
  return fs.readFile(await regularPath(projectRoot, relative));
}

async function prepare(platform) {
  if (platform !== "windows" && platform !== "macos") throw new Error("Unsupported platform.");
  const manifestBytes = await readResource(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.schema !== "dreamskin-shared-resources/1" || !Array.isArray(manifest.platforms?.[platform]?.files)) {
    throw new Error("Unsupported shared resource manifest.");
  }
  const files = [], targets = new Set(), inputs = new Map();
  inputs.set(manifestPath, manifestBytes);
  for (const generator of ["tools/sync-runtime-assets.mjs", "tools/stage-shared-resources.mjs"]) {
    inputs.set(generator, await readResource(generator));
  }
  const add = (target, bytes, sources, generated) => {
    relativeName(target);
    const key = target.toLowerCase();
    if (targets.has(key)) throw new Error(`Duplicate resource target: ${target}`);
    targets.add(key);
    files.push({ target, bytes, sources, generated });
  };
  for (const relative of manifest.platforms[platform].files) {
    relativeName(relative);
    if (relative !== "VERSION" && !/^scripts\/[A-Za-z0-9_.-]+\.(?:ps1|mjs|js|sh)$/.test(relative)) {
      throw new Error(`Manifest resource is outside the script/version boundary: ${relative}`);
    }
    const source = `${platform}/${relative}`;
    const bytes = await readResource(source);
    inputs.set(source, bytes);
    add(source, bytes, [source], false);
  }
  const generated = await runtimeAssetOutputs(projectRoot, async (filename, encoding) => {
    const source = relativeName(path.relative(projectRoot, filename).split(path.sep).join("/"));
    const bytes = await readResource(source);
    if (inputs.has(source) && !inputs.get(source).equals(bytes)) throw new Error(`Resource source changed: ${source}`);
    inputs.set(source, bytes);
    return encoding ? bytes.toString(encoding) : bytes;
  });
  for (const output of generated) {
    const targets = output.paths.filter((target) => target.startsWith(platform + "/"));
    if (!targets.length) continue;
    for (const source of output.sources) {
      if (!inputs.has(source)) inputs.set(source, await readResource(source));
    }
    for (const target of targets) add(target, Buffer.from(output.content, "utf8"), output.sources, true);
  }
  // Do not issue a receipt if a source changed while the in-memory candidate was
  // being prepared (notably while the generators were reading their inputs).
  for (const [source, bytes] of inputs) {
    if (!(await readResource(source)).equals(bytes)) throw new Error(`Resource source changed: ${source}`);
  }
  return { files, inputs };
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

async function stage(platform, output, prepared) {
  if (!output || !path.isAbsolute(output)) throw new Error("Output must be an absolute candidate root.");
  const root = path.resolve(output);
  if (contains(root, projectRoot) || (contains(projectRoot, root) && !contains(path.join(projectRoot, "build"), root))) {
    throw new Error("Output overlaps source files; in-repository candidates must be under build/.");
  }
  const resolved = await fs.realpath(root);
  if (process.platform === "win32" ? resolved.toLowerCase() !== root.toLowerCase() : resolved !== root) {
    throw new Error("Candidate root or its parents are linked.");
  }
  const receipt = await regularPath(root, receiptPath, true);
  try { await fs.lstat(receipt); throw new Error("Resource inventory already exists."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const file of prepared.files) await regularPath(root, file.target, true);
  for (const file of prepared.files) {
    const target = await regularPath(root, file.target, true);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.bytes, { flag: "w", mode: 0o644 });
    if (platform === "macos") await fs.chmod(target, file.target.endsWith(".sh") ? 0o755 : 0o644);
  }
  // Capture only managed resources, never enumerate user data or disclose local
  // absolute paths. This is build provenance, not verification or a signature.
  const inventory = {
    schema: "dreamskin-shared-resource-inventory/1", platform,
    scope: "managed-platform-scripts-version-and-generated-runtime-only",
    verification: "not-performed",
    inputs: [...prepared.inputs].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([source, bytes]) => ({ source, bytes: bytes.length, sha256: digest(bytes) })),
    files: prepared.files.sort((a, b) => a.target < b.target ? -1 : a.target > b.target ? 1 : 0)
      .map(({ target, bytes, sources, generated }) => ({ target, sources, generated, bytes: bytes.length, sha256: digest(bytes) })),
  };
  // Confirm the staged bytes before writing the build inventory.
  for (const file of prepared.files) {
    if (!(await fs.readFile(await regularPath(root, file.target))).equals(file.bytes)) {
      throw new Error(`Written resource differs: ${file.target}`);
    }
  }
  await fs.writeFile(receipt, JSON.stringify(inventory, null, 2) + "\n", { flag: "wx", mode: 0o644 });
}

const [mode, platform, output, ...extra] = process.argv.slice(2);
if (extra.length || (mode !== "--preflight" && mode !== "--stage") ||
    (mode === "--preflight" ? output !== undefined : !output)) {
  throw new Error("Usage: stage-shared-resources.mjs --preflight <windows|macos> OR --stage <windows|macos> <absolute-candidate-root>");
}
const prepared = await prepare(platform);
if (mode === "--stage") await stage(platform, output, prepared);
console.log(mode === "--preflight" ? "Shared resource sources prepared (no output written)." : "Managed shared resources staged; candidate remains unverified.");
