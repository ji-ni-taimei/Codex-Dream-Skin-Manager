import path from "node:path";
import { readdir, unlink } from "node:fs/promises";
import { safePath } from "../../core/local-files.mjs";

const prepared = new Map<string, Promise<void>>();

// Explorer may propagate a downloaded ZIP's zone marker to extracted scripts.
// Trust only the bundled script directory selected by the native application;
// never change the user's execution policy or unblock user-selected files.
async function prepareScripts(root: string): Promise<void> {
  const directory = path.join(root, "windows", "scripts");
  await safePath(directory, root);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.name.toLowerCase().endsWith(".ps1")) continue;
    const file = path.join(directory, entry.name);
    await safePath(file, root);
    if (!entry.isFile()) throw new Error("Bundled PowerShell script must be a regular file.");
    try { await unlink(file + ":Zone.Identifier"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export async function powerShellArgs(root: string, script: string, args: string[]): Promise<string[]> {
  await safePath(script, path.join(root, "windows", "scripts"));
  let ready = prepared.get(root);
  if (!ready) {
    ready = prepareScripts(root).catch(error => { prepared.delete(root); throw error; });
    prepared.set(root, ready);
  }
  await ready;
  const parameters: Record<string, string> = Object.create(null);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    if (name === undefined || value === undefined || !/^-[A-Za-z][A-Za-z0-9]*$/.test(name) ||
        Object.keys(parameters).some(key => key.toLowerCase() === name.slice(1).toLowerCase())) {
      throw new Error("Invalid bundled PowerShell script arguments.");
    }
    parameters[name.slice(1)] = value;
  }
  // Only Base64 enters executable text; paths and named arguments remain data.
  // BOM controls script reading, while Console.OutputEncoding controls the pipe.
  const payload = Buffer.from(JSON.stringify({ script, parameters }), "utf8").toString("base64");
  const command = `
$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
try {
  $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
  $parameters = @{}
  foreach ($property in $request.parameters.PSObject.Properties) { $parameters[$property.Name] = $property.Value }
  & ($request.script) @parameters
  if (-not $?) { exit 1 }
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}`;
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")];
}
