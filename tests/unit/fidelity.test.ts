import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { compareImages, decodePng } from '../../src/validation/image-diff.js';
import {
  diffFingerprints,
  diffRouteSets,
  summariseFidelity,
  type FidelityReport,
} from '../../src/validation/fidelity.js';
import {
  emptyFingerprint,
  fingerprintHash,
  type PageFingerprint,
} from '../../src/research/fingerprint.js';

function fingerprint(overrides: Partial<PageFingerprint> = {}): PageFingerprint {
  return {
    ...emptyFingerprint('/'),
    title: 'Acme',
    headings: [
      { level: 1, text: 'Acme widgets' },
      { level: 2, text: 'Pricing' },
    ],
    landmarks: ['header', 'main', 'footer'],
    textBlocks: ['Acme widgets', 'Plans for every size.'],
    links: ['/pricing', '/docs'],
    forms: [{ signature: 'get  [email:email*]', method: 'get', fields: ['email:email*'] }],
    interactive: ['button:Subscribe'],
    images: ['Acme logo'],
    tokens: {
      colors: ['rgb(17, 17, 17)', 'rgb(255, 255, 255)'],
      fontFamilies: ['system-ui'],
      fontSizes: ['16px'],
      radii: [],
    },
    ...overrides,
  };
}

describe('diffFingerprints', () => {
  it('scores an identical rebuild as a match', async () => {
    const report = await diffFingerprints(fingerprint(), fingerprint());
    expect(report.score).toBeGreaterThanOrEqual(0.95);
    expect(report.verdict).toBe('match');
    expect(report.differences).toHaveLength(0);
  });

  it('names the content a rebuild is missing and lowers the score', async () => {
    const rebuilt = fingerprint({
      headings: [{ level: 1, text: 'Acme widgets' }],
      textBlocks: ['Acme widgets'],
    });
    const report = await diffFingerprints(fingerprint(), rebuilt);

    expect(report.score).toBeLessThan(1);
    expect(report.differences.join(' ')).toContain('headings: missing "h2:Pricing"');
    expect(report.differences.join(' ')).toContain('text: missing');
    const headings = report.sections.find((section) => section.name === 'headings');
    // 1 of 2 reference headings present, nothing invented: F1 = 0.67.
    expect(headings?.score).toBeCloseTo(0.667, 2);
  });

  it('penalises invented content as well as missing content', async () => {
    const rebuilt = fingerprint({
      textBlocks: [...fingerprint().textBlocks, 'Buy our widgets now!'],
    });
    const report = await diffFingerprints(fingerprint(), rebuilt);
    expect(report.differences.join(' ')).toContain('unexpected "Buy our widgets now!"');
    const text = report.sections.find((section) => section.name === 'text');
    expect(text?.score).toBeLessThan(1);
    expect(text?.rebuilt).toBe(3);
  });

  it('scores landmarks as their own section', async () => {
    const rebuilt = fingerprint({ landmarks: ['main'] });
    const report = await diffFingerprints(fingerprint(), rebuilt);
    expect(report.differences.join(' ')).toContain('landmarks: missing "header"');
    const landmarks = report.sections.find((section) => section.name === 'landmarks');
    expect(landmarks?.reference).toBe(3);
    expect(landmarks?.rebuilt).toBe(1);
    expect(landmarks?.score).toBeGreaterThan(0);
    expect(landmarks?.score).toBeLessThan(1);
  });

  it('compares form fields, not just form counts', async () => {
    const rebuilt = fingerprint({ forms: [] });
    const report = await diffFingerprints(fingerprint(), rebuilt);
    expect(report.differences.join(' ')).toContain('forms: missing');
    expect(report.sections.find((section) => section.name === 'forms')?.score).toBe(0);
  });

  it('keeps the difference list bounded', async () => {
    const reference = fingerprint({
      textBlocks: Array.from({ length: 80 }, (_, index) => `paragraph number ${index}`),
    });
    const report = await diffFingerprints(reference, fingerprint(), { maxDifferences: 6 });
    expect(report.differences.length).toBeLessThanOrEqual(6);
  });
});

describe('diffRouteSets', () => {
  it('finds routes missing from the rebuild and routes that were invented', () => {
    expect(diffRouteSets(['/', '/pricing', '/docs'], ['/'])).toEqual({
      missing: ['/pricing', '/docs'],
      extra: [],
    });
    expect(diffRouteSets(['/'], ['/', '/blog'])).toEqual({ missing: [], extra: ['/blog'] });
  });
});

describe('summariseFidelity', () => {
  it('averages scores and buckets verdicts', () => {
    const reports: FidelityReport[] = [
      {
        route: '/',
        score: 1,
        verdict: 'match',
        sections: [],
        differences: [],
        visual: {
          compared: false,
          score: 0,
          differingCells: 0,
          totalCells: 0,
          width: 0,
          height: 0,
          note: '',
        },
        screenshots: { reference: null, rebuilt: null },
        referenceUrl: null,
        rebuiltUrl: null,
      },
      {
        route: '/pricing',
        score: 0.6,
        verdict: 'partial',
        sections: [],
        differences: ['text: missing "x"'],
        visual: {
          compared: false,
          score: 0,
          differingCells: 0,
          totalCells: 0,
          width: 0,
          height: 0,
          note: '',
        },
        screenshots: { reference: null, rebuilt: null },
        referenceUrl: null,
        rebuiltUrl: null,
      },
    ];
    const summary = summariseFidelity(reports, { missing: ['/docs'], extra: [] });
    expect(summary.routesCompared).toBe(2);
    expect(summary.averageScore).toBeCloseTo(0.8, 2);
    expect(summary.match).toBe(1);
    expect(summary.partial).toBe(1);
    expect(summary.missingRoutes).toEqual(['/docs']);
  });
});

describe('fingerprintHash', () => {
  it('is stable for identical fingerprints and differs otherwise', () => {
    expect(fingerprintHash(fingerprint())).toBe(fingerprintHash(fingerprint()));
    expect(fingerprintHash(fingerprint())).not.toBe(
      fingerprintHash(fingerprint({ title: 'Other' })),
    );
  });
});

// --- PNG encoding for the image-diff tests ---------------------------------

function encodePng(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number],
): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let position = 0;
  for (let y = 0; y < height; y += 1) {
    raw[position] = 0; // no filter
    position += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y);
      raw[position] = r;
      raw[position + 1] = g;
      raw[position + 2] = b;
      position += 3;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // colour type: truecolour
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
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

describe('image diff', () => {
  it('decodes an 8-bit truecolour PNG', () => {
    const png = encodePng(4, 4, () => [10, 20, 30]);
    const image = decodePng(png);
    expect(image).not.toBeNull();
    expect(image?.width).toBe(4);
    expect(image?.height).toBe(4);
    expect(image?.data[0]).toBe(10);
    expect(image?.data[1]).toBe(20);
    expect(image?.data[2]).toBe(30);
  });

  it('scores identical screenshots as a perfect match', () => {
    const png = encodePng(32, 32, (x, y) => [x * 8, y * 8, 128]);
    const result = compareImages(png, png);
    expect(result.compared).toBe(true);
    expect(result.score).toBe(1);
    expect(result.differingCells).toBe(0);
  });

  it('reports a difference when half the image changes', () => {
    const a = encodePng(32, 32, () => [10, 10, 10]);
    const b = encodePng(32, 32, (x) => (x < 16 ? [10, 10, 10] : [250, 250, 250]));
    const result = compareImages(a, b);
    expect(result.compared).toBe(true);
    expect(result.score).toBeLessThan(1);
    expect(result.score).toBeGreaterThan(0.4);
    expect(result.differingCells).toBeGreaterThan(0);
  });

  it('is explicit when a screenshot is missing instead of scoring zero', () => {
    const png = encodePng(8, 8, () => [0, 0, 0]);
    expect(compareImages(png, null).compared).toBe(false);
    expect(compareImages(null, null).note).toContain('no screenshots');
    expect(compareImages(Buffer.from('not a png'), png).compared).toBe(false);
  });
});
