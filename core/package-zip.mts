import { inflateRawSync, deflateRawSync } from "node:zlib";
import { ContractError } from "../contracts/manager.mjs";

export const MAX_PACKAGE_BYTES = 160 * 1024 * 1024;
const expandedLimit = 192 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const table = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const invalid = (): never => { throw new ContractError("THEME_INVALID", "The theme ZIP has an invalid path, record, checksum or size."); };
function crc(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = table[(value ^ byte) & 255]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function validPart(part: string): boolean {
  return part.length > 0 && part.length <= 255 && part !== "." && part !== ".." &&
    !/[\x00-\x1f\x7f<>:"|?*\\]/.test(part) && !/[. ]$/.test(part) &&
    !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part);
}
function extra(bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) invalid();
    const tag = bytes.readUInt16LE(offset), size = bytes.readUInt16LE(offset + 2);
    // ZIP64, alternate Unicode names, symlink targets and encryption metadata
    // introduce alternate interpretations; this codec accepts none of them.
    if ([0x0001, 0x7075, 0x000d, 0x756e, 0x9901].includes(tag) || offset + 4 + size > bytes.length) invalid();
    offset += 4 + size;
  }
}
function cap(name: string): number {
  const leaf = name.split("/").at(-1)!.toLowerCase();
  return /^(manifest|theme)\.json$/.test(leaf) ? 1024 * 1024 : leaf === "theme.css" ? 256 * 1024 :
    leaf === "license.txt" ? 64 * 1024 : leaf === "manifest.sig" ? 4096 : 128 * 1024 * 1024;
}

// No shell extraction. Every directory and ignored Finder file is still bounded
// and CRC-checked before format-specific payload validation.
export function readThemeZip(input: Uint8Array, macZip: boolean): Map<string, Buffer> {
  try {
    const bytes = Buffer.from(input);
    if (bytes.length < 22 || bytes.length > MAX_PACKAGE_BYTES) invalid();
    let end = -1;
    for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
      if (bytes.readUInt32LE(p) === 0x06054b50 && p + 22 + bytes.readUInt16LE(p + 20) === bytes.length) { end = p; break; }
    }
    if (end < 0) invalid();
    const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), central = bytes.readUInt32LE(end + 16);
    if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count ||
        count < 2 || count > (macZip ? 32 : 4) || central + centralSize !== end || central === 0xffffffff || centralSize === 0xffffffff) invalid();
    const files = new Map<string, Buffer>(), names = new Set<string>(), spans: [number, number][] = [];
    let position = central, total = 0;
    for (let i = 0; i < count; i++) {
      if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50) invalid();
      const flags = bytes.readUInt16LE(position + 8), method = bytes.readUInt16LE(position + 10), checksum = bytes.readUInt32LE(position + 16);
      const compressed = bytes.readUInt32LE(position + 20), expanded = bytes.readUInt32LE(position + 24);
      const nl = bytes.readUInt16LE(position + 28), el = bytes.readUInt16LE(position + 30), cl = bytes.readUInt16LE(position + 32);
      const attributes = bytes.readUInt32LE(position + 38), mode = attributes >>> 16, offset = bytes.readUInt32LE(position + 42);
      if (position + 46 + nl + el + cl > end || (flags & ~(macZip ? 0x080e : 0x0808)) || (method === 0 && (flags & 6)) || ![0, 8].includes(method) ||
          bytes.readUInt16LE(position + 34) || bytes.readUInt16LE(position + 6) > 20 ||
          compressed === 0xffffffff || expanded === 0xffffffff || offset === 0xffffffff || (attributes & 0x400)) invalid();
      const nameBytes = bytes.subarray(position + 46, position + 46 + nl), name = decoder.decode(nameBytes);
      const directory = name.endsWith("/"), parts = (directory ? name.slice(0, -1) : name).split("/");
      const fileType = mode & 0xf000;
      if (!parts.every(validPart) || (!macZip && (directory || parts.length !== 1)) || parts.length > (macZip ? 3 : 1) ||
          (fileType !== 0 && fileType !== (directory ? 0x4000 : 0x8000)) || ((attributes & 0x10) !== 0 && !directory)) invalid();
      if (/\.(zip|cdskin)$/i.test(parts.at(-1)!)) invalid();
      const key = name.normalize("NFC").toLowerCase(); if (names.has(key)) invalid(); names.add(key);
      extra(bytes.subarray(position + 46 + nl, position + 46 + nl + el));
      total += expanded;
      if (expanded > cap(name) || total > expandedLimit || (directory && expanded !== 0) ||
          (!directory && expanded === 0 && !(macZip && (parts[0] === "__MACOSX" || parts.at(-1) === ".DS_Store"))) ||
          offset + 30 > central || bytes.readUInt32LE(offset) !== 0x04034b50) invalid();
      const localNL = bytes.readUInt16LE(offset + 26), localEL = bytes.readUInt16LE(offset + 28), start = offset + 30 + localNL + localEL;
      if (start + compressed > central || bytes.readUInt16LE(offset + 4) > 20 || bytes.readUInt16LE(offset + 6) !== flags ||
          bytes.readUInt16LE(offset + 8) !== method || !bytes.subarray(offset + 30, offset + 30 + localNL).equals(nameBytes)) invalid();
      extra(bytes.subarray(offset + 30 + localNL, start));
      let stop = start + compressed;
      if (flags & 8) {
        if (stop + 12 > central) invalid();
        const descriptor = bytes.readUInt32LE(stop) === 0x08074b50 ? stop + 4 : stop;
        if (descriptor + 12 > central || bytes.readUInt32LE(descriptor) !== checksum ||
            bytes.readUInt32LE(descriptor + 4) !== compressed || bytes.readUInt32LE(descriptor + 8) !== expanded) invalid();
        for (const [field, value] of [[14, checksum], [18, compressed], [22, expanded]] as const) {
          if (bytes.readUInt32LE(offset + field) !== 0 && bytes.readUInt32LE(offset + field) !== value) invalid();
        }
        stop = descriptor + 12;
      } else if (bytes.readUInt32LE(offset + 14) !== checksum || bytes.readUInt32LE(offset + 18) !== compressed || bytes.readUInt32LE(offset + 22) !== expanded) invalid();
      if (spans.some(([a, b]) => offset < b && stop > a)) invalid(); spans.push([offset, stop]);
      const raw = bytes.subarray(start, start + compressed);
      let data: Buffer;
      if (method === 8) {
        const decoded = inflateRawSync(raw, { maxOutputLength: Math.max(1, expanded), info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
        if (decoded.engine.bytesWritten !== compressed) invalid(); data = decoded.buffer;
      } else data = raw;
      if (data.length !== expanded || crc(data) !== checksum) invalid();
      if (!directory && !(macZip && (parts[0] === "__MACOSX" || parts.at(-1) === ".DS_Store"))) files.set(name, data);
      position += 46 + nl + el + cl;
    }
    if (position !== end) invalid();
    spans.sort((a, b) => a[0] - b[0]);
    // Reject hidden/unindexed records, self-extracting prefixes and ZIP64 tails.
    if (spans[0]?.[0] !== 0 || spans.at(-1)?.[1] !== central || spans.some((span, i) => i > 0 && spans[i - 1]![1] !== span[0])) invalid();
    if (macZip) {
      const roots = new Set([...files.keys()].map(name => name.includes("/") ? name.split("/")[0]! : ""));
      if (roots.size !== 1 || [...files.keys()].some(name => name.split("/").length > 2)) invalid();
      if (![...roots][0]) return files;
      return new Map([...files].map(([name, data]) => [name.slice(name.indexOf("/") + 1), data]));
    }
    return files;
  } catch (error) { if (error instanceof ContractError) throw error; return invalid(); }
}

export function writeThemeZip(files: Map<string, Uint8Array>): Uint8Array {
  if (files.size < 2 || files.size > 4) invalid();
  const locals: Buffer[] = [], centrals: Buffer[] = []; let offset = 0, total = 0;
  for (const [name, data] of files) {
    total += data.byteLength;
    if (!validPart(name) || name.includes("/") || data.byteLength < 1 || data.byteLength > cap(name) || total > expandedLimit) invalid();
    const encoded = Buffer.from(name), compressed = deflateRawSync(data), checksum = crc(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.byteLength, 22); local.writeUInt16LE(encoded.length, 26);
    locals.push(local, encoded, compressed);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.byteLength, 24); central.writeUInt16LE(encoded.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, encoded); offset += local.length + encoded.length + compressed.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const output = Buffer.concat([...locals, directory, end]); if (output.length > MAX_PACKAGE_BYTES) invalid(); return output;
}
