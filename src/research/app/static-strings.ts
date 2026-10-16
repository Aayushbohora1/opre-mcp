/**
 * Static string extraction for binary formats used by application packages.
 *
 * These readers extract *declared strings* (names, identifiers, URLs). They do
 * not decompile logic, and OPRE never presents their output as recovered source
 * code — only as evidence of what an application declares.
 */

export interface StringPoolResult {
  strings: string[];
  warnings: string[];
}

/**
 * Extracts the string pool of a compiled Android binary XML (AXML) resource,
 * typically `AndroidManifest.xml`. Chunk layout is documented in the platform
 * `ResourceTypes.h`; only the string pool is decoded here.
 */
export function readAxmlStrings(buffer: Buffer): StringPoolResult {
  const warnings: string[] = [];
  const strings: string[] = [];
  let cursor = 0;

  while (cursor + 8 <= buffer.length) {
    const type = buffer.readUInt16LE(cursor);
    const headerSize = buffer.readUInt16LE(cursor + 2);
    const chunkSize = buffer.readUInt32LE(cursor + 4);
    if (chunkSize < 8 || cursor + chunkSize > buffer.length) {
      break;
    }
    if (type === 0x0001) {
      try {
        strings.push(...readStringPool(buffer, cursor, headerSize, warnings));
      } catch (error) {
        warnings.push(
          `String pool decode failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      break;
    }
    cursor += chunkSize;
  }

  if (strings.length === 0) {
    warnings.push(
      'No AXML string pool was decoded; the manifest may be obfuscated or in another format.',
    );
  }
  return { strings, warnings };
}

function readStringPool(
  buffer: Buffer,
  start: number,
  headerSize: number,
  warnings: string[],
): string[] {
  const stringCount = buffer.readUInt32LE(start + 8);
  const flags = buffer.readUInt32LE(start + 16);
  const stringsStart = buffer.readUInt32LE(start + 20);
  const isUtf8 = (flags & 0x00000100) !== 0;
  if (stringCount > 100_000) {
    throw new Error(`implausible string count ${stringCount}`);
  }

  const offsetsBase = start + headerSize;
  const dataBase = start + stringsStart;
  const strings: string[] = [];
  for (let index = 0; index < stringCount; index += 1) {
    const relative = buffer.readUInt32LE(offsetsBase + index * 4);
    const position = dataBase + relative;
    if (position >= buffer.length) {
      warnings.push(`String offset ${index} points outside the chunk; remaining strings skipped.`);
      break;
    }
    strings.push(isUtf8 ? readUtf8String(buffer, position) : readUtf16String(buffer, position));
  }
  return strings;
}

function readUtf8String(buffer: Buffer, position: number): string {
  let cursor = position;
  // Two length fields: character count then byte count (both may be encoded in 2 bytes).
  cursor = skipLengthPrefix(buffer, cursor);
  cursor = skipLengthPrefix(buffer, cursor);
  const end = buffer.indexOf(0, cursor);
  const stop = end === -1 ? buffer.length : end;
  return buffer.toString('utf8', cursor, stop);
}

function readUtf16String(buffer: Buffer, position: number): string {
  const length = buffer.readUInt16LE(position);
  return buffer.toString('utf16le', position + 2, position + 2 + length * 2);
}

function skipLengthPrefix(buffer: Buffer, position: number): number {
  const first = buffer.readUInt8(position);
  if ((first & 0x80) === 0) {
    return position + 1;
  }
  if ((first & 0xc0) === 0x80) {
    return position + 2;
  }
  return position + (first & 0x7f) === 0x04 ? position + 4 : position + 2;
}

export interface DexInfo {
  version: string;
  stringCount: number;
  classLikeIdentifiers: string[];
  urls: string[];
  warnings: string[];
}

/** Extracts the DEX string pool (identifiers, endpoints, literals). */
export function readDexStrings(buffer: Buffer, limits: { maxStrings: number }): DexInfo {
  const warnings: string[] = [];
  const magic = buffer.toString('latin1', 0, 8);
  if (!magic.startsWith('dex\n')) {
    return {
      version: 'unknown',
      stringCount: 0,
      classLikeIdentifiers: [],
      urls: [],
      warnings: ['Not a DEX file'],
    };
  }
  const version = magic.replace('dex\n', '').replace(/\0/g, '').trim();
  const stringCount = buffer.readUInt32LE(56);
  const stringsOffset = buffer.readUInt32LE(60);
  const limit = Math.min(stringCount, limits.maxStrings);
  if (stringCount > 5_000_000) {
    return {
      version,
      stringCount,
      classLikeIdentifiers: [],
      urls: [],
      warnings: ['Implausible DEX string count'],
    };
  }

  const strings: string[] = [];
  for (let index = 0; index < limit; index += 1) {
    const offset = buffer.readUInt32LE(stringsOffset + index * 4);
    try {
      strings.push(readDexString(buffer, offset));
    } catch (error) {
      warnings.push(
        `Stopped reading DEX strings: ${error instanceof Error ? error.message : String(error)}`,
      );
      break;
    }
  }
  if (limit < stringCount) {
    warnings.push(`Read ${limit} of ${stringCount} DEX strings (limit reached).`);
  }

  const classLike = strings.filter((value) => /^L[a-zA-Z0-9_$/;-]+;$/.test(value)).slice(0, 200);
  const urls = strings.filter((value) => /^https?:\/\/\S{4,200}$/.test(value)).slice(0, 50);

  return { version, stringCount, classLikeIdentifiers: classLike, urls, warnings };
}

function readDexString(buffer: Buffer, offset: number): string {
  let cursor = offset;
  // uleb128 length prefix
  for (;;) {
    if (cursor >= buffer.length) {
      throw new Error('unexpected end of DEX data');
    }
    const byte = buffer.readUInt8(cursor);
    cursor += 1;
    if ((byte & 0x80) === 0) {
      break;
    }
  }
  const end = buffer.indexOf(0, cursor);
  if (end === -1) {
    throw new Error('unterminated DEX string');
  }
  return buffer.toString('utf8', cursor, end);
}
