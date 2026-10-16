/**
 * Minimal ZIP reader (no external dependency).
 *
 * Supports stored and deflated entries via the central directory. ZIP64 archives
 * and encrypted entries are reported as unsupported rather than mis-parsed.
 */

import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  encrypted: boolean;
}

export interface ZipArchive {
  entries: ZipEntry[];
  warnings: string[];
}

export function readZipDirectory(buffer: Buffer): ZipArchive {
  const warnings: string[] = [];
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset === -1) {
    throw new Error('Not a ZIP archive: end-of-central-directory record not found');
  }

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported by the built-in reader');
  }

  const entries: ZipEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      warnings.push(`Central directory entry ${index} is malformed; stopped parsing.`);
      break;
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    entries.push({
      name: buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength),
      compressionMethod: buffer.readUInt16LE(cursor + 10),
      compressedSize: buffer.readUInt32LE(cursor + 20),
      uncompressedSize: buffer.readUInt32LE(cursor + 24),
      localHeaderOffset: buffer.readUInt32LE(cursor + 42),
      encrypted: (flags & 0x1) === 1,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return { entries, warnings };
}

export function readZipEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  if (entry.encrypted) {
    throw new Error(`Entry "${entry.name}" is encrypted and cannot be read`);
  }
  const offset = entry.localHeaderOffset;
  if (buffer.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    throw new Error(`Entry "${entry.name}" has an invalid local header`);
  }
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressedSize);
  if (entry.compressionMethod === 0) {
    return Buffer.from(raw);
  }
  if (entry.compressionMethod === 8) {
    return inflateRawSync(raw);
  }
  throw new Error(
    `Entry "${entry.name}" uses unsupported compression method ${entry.compressionMethod}`,
  );
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  return -1;
}
