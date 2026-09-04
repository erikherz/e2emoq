// QR Code generation, byte mode — enough of ISO/IEC 18004 to turn a URL into a matrix.
//
// WHY THIS IS HAND-WRITTEN RATHER THAN A DEPENDENCY
//
// The matrix is drawn into the composited video frame, which means it is generated inside the
// broadcaster's browser and travels inside the end-to-end encryption like every other pixel.
// A hosted image service ("render this URL as a QR") would be the easy version and is exactly
// wrong here: it would tell a third party what link a broadcaster is putting on screen, which
// is the one thing this product exists not to do. Bundling it is also what keeps the page
// inside its own content-security policy, which permits no external script.
//
// It is a small enough spec to carry: the structure below follows Project Nayuki's reference
// implementation, which is the clearest public statement of the algorithm.
//
// SCOPE
//
// Byte mode only. Numeric and alphanumeric modes exist and would pack a digits-only string
// more tightly, but the input here is always a URL, where byte mode is what the encoder would
// pick anyway. Versions 1-40 are supported by the tables; the caller caps the version far
// lower, because a QR that has to survive video compression is limited by module size on
// screen, not by capacity (see MODULE_MIN_PX in pip-compositor.ts).

export type EccLevel = "L" | "M" | "Q" | "H";

/** Index into the tables below. Not the same as the bit pattern written into the QR. */
const ECC_ORDINAL: Record<EccLevel, number> = { L: 0, M: 1, Q: 2, H: 3 };

// The format-information field does NOT encode the levels in L/M/Q/H order — the standard
// assigns M=00, L=01, H=10, Q=11. Getting this wrong produces a QR that looks perfect and
// scans as nothing, so the two mappings are kept deliberately apart.
const ECC_FORMAT_BITS: Record<EccLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Error-correction codewords per block, indexed [eccOrdinal][version]. Index 0 is unused.
// prettier-ignore
const ECC_CODEWORDS_PER_BLOCK: number[][] = [
  [-1, 7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30], // L
  [-1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28], // M
  [-1,13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30], // Q
  [-1,17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30], // H
];

// Number of error-correction blocks, indexed [eccOrdinal][version].
// prettier-ignore
const NUM_ECC_BLOCKS: number[][] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25], // L
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49], // M
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68], // Q
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81], // H
];

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/** A finished QR: a square grid where true means a dark module. */
export interface QrMatrix {
  /** Modules per side, not counting the quiet zone the caller must leave around it. */
  readonly size: number;
  readonly version: number;
  /** Dark or light. Out-of-range coordinates read light, so the quiet zone comes free. */
  get(x: number, y: number): boolean;
}

// ---------------------------------------------------------------- GF(256) arithmetic
//
// The Reed-Solomon field of the QR standard: byte values as polynomials mod x^8+x^4+x^3+x^2+1.

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    // Double, reducing by the primitive polynomial whenever bit 8 would be set. The
    // multiply-by-(bit) form avoids a branch and keeps this constant-shaped.
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** The generator polynomial of degree `degree`, as coefficients from x^(degree-1) down to x^0. */
function rsDivisor(degree: number): Uint8Array {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1; // start at the monomial 1
  // Multiply by (x - r^0)(x - r^1)... one root at a time; r = 0x02 is the field's generator.
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

/** The remainder of data divided by the divisor — i.e. the error-correction codewords. */
function rsRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

// ---------------------------------------------------------------- capacity

/**
 * Total data modules for a version, before error correction and before the format/version
 * information is subtracted. The closed form is the standard's table, derived rather than
 * tabulated.
 */
function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36; // the two version-information blocks
  }
  return result;
}

/** How many 8-bit data codewords a version/level actually carries. */
function dataCodewords(ver: number, ecl: EccLevel): number {
  const o = ECC_ORDINAL[ecl];
  return (
    Math.floor(rawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[o][ver] * NUM_ECC_BLOCKS[o][ver]
  );
}

/** Where the alignment patterns sit, as coordinates used for both axes. */
function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  // Version 32 is the one case the general formula gets wrong; the standard fixes it at 26.
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = ver * 4 + 17 - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// ---------------------------------------------------------------- the encoder

class Builder implements QrMatrix {
  readonly size: number;
  /** Row-major, one byte per module: 1 dark, 0 light. */
  private readonly modules: Uint8Array;
  /** Function patterns are immune to masking and must not receive data. */
  private readonly reserved: Uint8Array;

  constructor(
    readonly version: number,
    private readonly ecl: EccLevel,
    codewords: Uint8Array
  ) {
    this.size = version * 4 + 17;
    this.modules = new Uint8Array(this.size * this.size);
    this.reserved = new Uint8Array(this.size * this.size);

    this.drawFunctionPatterns();
    this.drawCodewords(codewords);

    // Eight masks exist because no single one is good for all payloads; the standard's answer
    // is to try them all and keep whichever scores least badly on readability heuristics.
    let bestMask = 0;
    let bestPenalty = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      this.applyMask(mask);
      this.drawFormatBits(mask);
      const penalty = this.penalty();
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        bestMask = mask;
      }
      this.applyMask(mask); // XOR is its own inverse — undo before trying the next
    }
    this.applyMask(bestMask);
    this.drawFormatBits(bestMask);
  }

  get(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return false;
    return this.modules[y * this.size + x] === 1;
  }

  private setFunction(x: number, y: number, dark: boolean): void {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    this.modules[y * this.size + x] = dark ? 1 : 0;
    this.reserved[y * this.size + x] = 1;
  }

  private drawFunctionPatterns(): void {
    // Timing patterns: the alternating row and column a scanner uses to find the module grid.
    for (let i = 0; i < this.size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    // Three finders, one corner each — the fourth corner is left free, which is how a scanner
    // works out the orientation.
    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);

    const pos = alignmentPositions(this.version);
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < pos.length; j++) {
        // Skip the three that would collide with a finder.
        const corner =
          (i === 0 && j === 0) ||
          (i === 0 && j === pos.length - 1) ||
          (i === pos.length - 1 && j === 0);
        if (!corner) this.drawAlignment(pos[i], pos[j]);
      }
    }
    // Reserve the format area now with a placeholder; the real bits need the chosen mask.
    this.drawFormatBits(0);
    this.drawVersionBits();
  }

  private drawFinder(x: number, y: number): void {
    // Concentric rings: dark 3x3, light ring, dark ring, and a light separator outside it.
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        this.setFunction(x + dx, y + dy, dist !== 2 && dist !== 4);
      }
    }
  }

  private drawAlignment(x: number, y: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  /** 5 bits of level+mask, BCH(15,5)-protected and XORed with 0x5412, written twice. */
  private drawFormatBits(mask: number): void {
    const data = (ECC_FORMAT_BITS[this.ecl] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    // The XOR mask exists so an all-zero format never produces an all-light region, which
    // would be indistinguishable from blank media.
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;

    // First copy, wrapped around the top-left finder.
    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(i));
    this.setFunction(8, 7, bit(6));
    this.setFunction(8, 8, bit(7));
    this.setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i));

    // Second copy, split between the other two finders. Redundant on purpose: without a
    // readable format field none of the rest can be decoded at all.
    for (let i = 0; i < 8; i++) this.setFunction(this.size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFunction(8, this.size - 15 + i, bit(i));
    this.setFunction(8, this.size - 8, true); // the always-dark module
  }

  /** Versions 7 and up carry their own number, BCH(18,6)-protected, near two finders. */
  private drawVersionBits(): void {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, dark);
      this.setFunction(b, a, dark);
    }
  }

  /** Zig-zag the codeword bits up and down two-module columns, right to left. */
  private drawCodewords(data: Uint8Array): void {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // step over the vertical timing column
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.reserved[y * this.size + x] && i < data.length * 8) {
            this.modules[y * this.size + x] = (data[i >>> 3] >>> (7 - (i & 7))) & 1;
            i++;
          }
        }
      }
    }
  }

  private applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        const at = y * this.size + x;
        if (invert && !this.reserved[at]) this.modules[at] ^= 1;
      }
    }
  }

  // ---- Mask scoring ----
  //
  // Four penalties, all of them proxies for "a camera will misread this": long same-colour
  // runs, solid 2x2 blocks, anything resembling a finder pattern out in the data, and a
  // dark/light balance far from even.

  private penalty(): number {
    let result = 0;
    const size = this.size;

    for (let y = 0; y < size; y++) {
      let runColor = false;
      let runLen = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < size; x++) {
        if (this.get(x, y) === runColor) {
          runLen++;
          if (runLen === 5) result += PENALTY_N1;
          else if (runLen > 5) result++;
        } else {
          this.pushRun(runLen, history);
          if (!runColor) result += this.countFinderLike(history) * PENALTY_N3;
          runColor = this.get(x, y);
          runLen = 1;
        }
      }
      result += this.endRun(runColor, runLen, history) * PENALTY_N3;
    }
    for (let x = 0; x < size; x++) {
      let runColor = false;
      let runLen = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < size; y++) {
        if (this.get(x, y) === runColor) {
          runLen++;
          if (runLen === 5) result += PENALTY_N1;
          else if (runLen > 5) result++;
        } else {
          this.pushRun(runLen, history);
          if (!runColor) result += this.countFinderLike(history) * PENALTY_N3;
          runColor = this.get(x, y);
          runLen = 1;
        }
      }
      result += this.endRun(runColor, runLen, history) * PENALTY_N3;
    }

    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = this.get(x, y);
        if (c === this.get(x + 1, y) && c === this.get(x, y + 1) && c === this.get(x + 1, y + 1)) {
          result += PENALTY_N2;
        }
      }
    }

    let dark = 0;
    for (const m of this.modules) dark += m;
    const total = size * size;
    // Every 5% the dark share strays from half costs another N4.
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return result + k * PENALTY_N4;
  }

  private pushRun(len: number, history: number[]): void {
    if (history[0] === 0) len += this.size; // the quiet zone counts as light border
    history.pop();
    history.unshift(len);
  }

  /** How many 1:1:3:1:1 finder-like sequences with a wide light margin end here (0, 1 or 2). */
  private countFinderLike(h: number[]): number {
    const n = h[1];
    const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
    return (
      (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0)
    );
  }

  private endRun(runColor: boolean, runLen: number, history: number[]): number {
    if (runColor) {
      this.pushRun(runLen, history);
      runLen = 0;
    }
    runLen += this.size; // the light quiet zone past the final run
    this.pushRun(runLen, history);
    return this.countFinderLike(history);
  }
}

// ---------------------------------------------------------------- public entry point

/**
 * Encode text as a QR matrix, or null if it will not fit within `maxVersion`.
 *
 * Returning null rather than throwing is deliberate: "too long to draw at a scannable size" is
 * a normal answer to a normal input here, and the caller turns it into a sentence for the
 * broadcaster rather than an exception.
 */
export function encodeQr(
  text: string,
  opts: { ecl?: EccLevel; maxVersion?: number } = {}
): QrMatrix | null {
  const ecl = opts.ecl ?? "M";
  const maxVersion = Math.min(opts.maxVersion ?? 40, 40);

  // UTF-8. The standard's byte mode is nominally ISO-8859-1, but every scanner in use reads
  // UTF-8, and a URL is overwhelmingly ASCII where the two agree exactly.
  const bytes = new TextEncoder().encode(text);

  // Character-count field width for byte mode: 8 bits through version 9, 16 bits above. Since
  // the width depends on the version and the version depends on the width, try in order.
  let version = 0;
  for (let v = 1; v <= maxVersion; v++) {
    const countBits = v <= 9 ? 8 : 16;
    const needed = 4 + countBits + bytes.length * 8;
    if (bytes.length < 1 << countBits && needed <= dataCodewords(v, ecl) * 8) {
      version = v;
      break;
    }
  }
  if (version === 0) return null;

  const capacityBits = dataCodewords(version, ecl) * 8;
  const bits: number[] = [];
  const push = (value: number, width: number) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0x4, 4); // byte mode
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  // Terminator, then pad to a byte, then the standard's alternating filler. The filler bytes
  // are specified values rather than zeros so that a mostly-empty symbol still has structure.
  push(0, Math.min(4, capacityBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);

  const data = new Uint8Array(bits.length / 8);
  bits.forEach((bit, i) => {
    data[i >>> 3] |= bit << (7 - (i & 7));
  });

  return new Builder(version, ecl, interleave(data, version, ecl));
}

/**
 * Split into blocks, append each block's error-correction codewords, then interleave.
 *
 * The interleaving is the point: a scratch or a compression artefact that wipes a contiguous
 * patch of the symbol is spread across every block, so no single block loses more than it can
 * correct. Without it a small blemish in the wrong place would be unrecoverable.
 */
function interleave(data: Uint8Array, ver: number, ecl: EccLevel): Uint8Array {
  const o = ECC_ORDINAL[ecl];
  const numBlocks = NUM_ECC_BLOCKS[o][ver];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[o][ver];
  const rawCodewords = Math.floor(rawDataModules(ver) / 8);
  // Blocks come in two lengths differing by one; the short ones come first.
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const divisor = rsDivisor(blockEccLen);
  const blocks: Uint8Array[] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.subarray(k, k + len);
    k += len;
    const ecc = rsRemainder(dat, divisor);
    // Short blocks get a placeholder byte so every block is the same length here; the
    // interleaving step below skips it rather than emitting it.
    const block = new Uint8Array(shortBlockLen + 1);
    block.set(dat, 0);
    block.set(ecc, len + (i < numShortBlocks ? 1 : 0));
    blocks.push(block);
  }

  const result = new Uint8Array(rawCodewords);
  let at = 0;
  for (let i = 0; i < shortBlockLen + 1; i++) {
    for (let j = 0; j < blocks.length; j++) {
      // Column shortBlockLen - blockEccLen is the padding column, present only in long blocks.
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result[at++] = blocks[j][i];
    }
  }
  return result;
}
