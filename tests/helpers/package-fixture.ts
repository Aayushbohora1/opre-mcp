/**
 * Builds a synthetic Android-like package (stored-only ZIP with an AXML string
 * pool and a DEX string pool) so package inspection can be tested without
 * shipping a binary fixture.
 */

interface Entry {
  name: string;
  content: Buffer;
}

export function buildZip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.content);
    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.content.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuffer.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.content.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuffer.copy(central, 46);

    locals.push(local, entry.content);
    centrals.push(central);
    offset += local.length + entry.content.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralDirectory, end]);
}

/** Minimal compiled AndroidManifest.xml: an XML chunk header plus a string pool. */
export function buildAxml(strings: string[]): Buffer {
  const encoded = strings.map((value) => {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([
      Buffer.from([bytes.length]),
      Buffer.from([bytes.length]),
      bytes,
      Buffer.from([0]),
    ]);
  });
  const offsets: number[] = [];
  let cursor = 0;
  for (const entry of encoded) {
    offsets.push(cursor);
    cursor += entry.length;
  }

  const headerSize = 28;
  const dataStart = headerSize + offsets.length * 4;
  const chunkSize = dataStart + cursor;
  const pool = Buffer.alloc(chunkSize);
  pool.writeUInt16LE(0x0001, 0);
  pool.writeUInt16LE(headerSize, 2);
  pool.writeUInt32LE(chunkSize, 4);
  pool.writeUInt32LE(strings.length, 8);
  pool.writeUInt32LE(0, 12); // styleCount
  pool.writeUInt32LE(0x00000100, 16); // UTF-8 flag
  pool.writeUInt32LE(dataStart, 20); // stringsStart
  offsets.forEach((offset, index) => {
    pool.writeUInt32LE(offset, headerSize + index * 4);
  });
  encoded.forEach((entry, index) => {
    entry.copy(pool, dataStart + offsets[index]!);
  });

  const document = Buffer.alloc(8);
  document.writeUInt16LE(0x0003, 0);
  document.writeUInt16LE(8, 2);
  document.writeUInt32LE(8, 4);

  return Buffer.concat([document, pool]);
}

/** Minimal classes.dex header exposing a string pool. */
export function buildDex(strings: string[]): Buffer {
  const encoded = strings.map((value) => {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([Buffer.from([bytes.length]), bytes, Buffer.from([0])]);
  });
  const header = Buffer.alloc(112);
  header.write('dex\n035\0', 0, 'latin1');
  header.writeUInt32LE(strings.length, 56); // string_ids_size
  const stringIdsOffset = 112;
  header.writeUInt32LE(stringIdsOffset, 60); // string_ids_off

  let dataCursor = stringIdsOffset + strings.length * 4;
  const ids = Buffer.alloc(strings.length * 4);
  const data = Buffer.alloc(encoded.reduce((sum, entry) => sum + entry.length, 0));
  encoded.forEach((entry, index) => {
    ids.writeUInt32LE(dataCursor, index * 4);
    entry.copy(data, dataCursor - (stringIdsOffset + strings.length * 4));
    dataCursor += entry.length;
  });

  return Buffer.concat([header, ids, data]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
