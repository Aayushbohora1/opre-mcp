/**
 * Screenshot comparison without adding a dependency.
 *
 * Decodes the 8-bit, non-interlaced PNGs Playwright produces, downsamples both
 * images to the same grid, and reports the fraction of cells that differ by more
 * than a per-channel tolerance. It is a *perceptual-ish* delta, not an SSIM:
 * the number is honest ("this share of the layout differs") and the tolerance is
 * configurable, so it must be reported with the number, never on its own.
 */

import { inflateSync } from 'node:zlib';

export interface PngImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Buffer;
}

export interface VisualDiffResult {
  compared: boolean;
  score: number;
  differingCells: number;
  totalCells: number;
  width: number;
  height: number;
  note: string;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decodes a PNG produced by Chromium. Returns null for unsupported variants. */
export function decodePng(buffer: Buffer): PngImage | null {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    return null;
  }
  let cursor = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const dataChunks: Buffer[] = [];

  while (cursor + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(cursor);
    const type = buffer.toString('ascii', cursor + 4, cursor + 8);
    const start = cursor + 8;
    const end = start + length;
    if (end > buffer.length) {
      return null;
    }
    if (type === 'IHDR') {
      width = buffer.readUInt32BE(start);
      height = buffer.readUInt32BE(start + 4);
      bitDepth = buffer.readUInt8(start + 8);
      colorType = buffer.readUInt8(start + 9);
      interlace = buffer.readUInt8(start + 12);
    } else if (type === 'IDAT') {
      dataChunks.push(buffer.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    cursor = end + 4;
  }

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (bitDepth !== 8 || channels === 0 || interlace !== 0 || width === 0 || height === 0) {
    return null;
  }

  const raw = inflateSync(Buffer.concat(dataChunks));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const previous = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);

  let position = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[position] ?? 0;
    position += 1;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[position + x] ?? 0;
      const left = x >= channels ? (current[x - channels] ?? 0) : 0;
      const up = previous[x] ?? 0;
      const upLeft = x >= channels ? (previous[x - channels] ?? 0) : 0;
      let restored: number;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + up;
          break;
        case 3:
          restored = value + ((left + up) >> 1);
          break;
        case 4:
          restored = value + paeth(left, up, upLeft);
          break;
        default:
          return null;
      }
      current[x] = restored & 0xff;
    }
    position += stride;

    for (let x = 0; x < width; x += 1) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      if (channels === 4) {
        out[target] = current[source] ?? 0;
        out[target + 1] = current[source + 1] ?? 0;
        out[target + 2] = current[source + 2] ?? 0;
        out[target + 3] = current[source + 3] ?? 255;
      } else {
        out[target] = current[source] ?? 0;
        out[target + 1] = current[source + 1] ?? 0;
        out[target + 2] = current[source + 2] ?? 0;
        out[target + 3] = 255;
      }
    }

    current.copy(previous);
  }

  return { width, height, data: out };
}

export interface CompareOptions {
  /** Grid resolution the images are compared at. */
  cells?: number;
  /** Per-channel tolerance, 0-255. */
  tolerance?: number;
}

export function compareImages(
  reference: Buffer | null,
  rebuilt: Buffer | null,
  options: CompareOptions = {},
): VisualDiffResult {
  const cells = options.cells ?? 48;
  const tolerance = options.tolerance ?? 24;

  if (reference === null || rebuilt === null) {
    return {
      compared: false,
      score: 0,
      differingCells: 0,
      totalCells: 0,
      width: 0,
      height: 0,
      note:
        reference === null && rebuilt === null
          ? 'no screenshots on either side'
          : 'a screenshot is missing on one side; visual comparison skipped',
    };
  }

  const a = decodePng(reference);
  const b = decodePng(rebuilt);
  if (a === null || b === null) {
    return {
      compared: false,
      score: 0,
      differingCells: 0,
      totalCells: 0,
      width: 0,
      height: 0,
      note: 'screenshot format not supported for pixel comparison (expected 8-bit non-interlaced PNG)',
    };
  }

  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  if (width === 0 || height === 0) {
    return {
      compared: false,
      score: 0,
      differingCells: 0,
      totalCells: 0,
      width,
      height,
      note: 'empty screenshot',
    };
  }

  let differing = 0;
  const stepX = Math.max(1, Math.floor(width / cells));
  const stepY = Math.max(1, Math.floor(height / cells));
  let sampled = 0;

  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      sampled += 1;
      const index = (y * width + x) * 4;
      const delta =
        Math.abs((a.data[index] ?? 0) - (b.data[index] ?? 0)) +
        Math.abs((a.data[index + 1] ?? 0) - (b.data[index + 1] ?? 0)) +
        Math.abs((a.data[index + 2] ?? 0) - (b.data[index + 2] ?? 0));
      if (delta > tolerance) {
        differing += 1;
      }
    }
  }

  return {
    compared: true,
    score: sampled === 0 ? 1 : 1 - differing / sampled,
    differingCells: differing,
    totalCells: sampled,
    width,
    height,
    note: `${(100 * (1 - (sampled === 0 ? 1 : differing / sampled))).toFixed(1)}% of sampled pixels differ (tolerance ${tolerance}/255 per channel)`,
  };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}
