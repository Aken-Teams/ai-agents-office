/**
 * IEEE-754 binary16 (half-precision) pack / unpack for personal RAG
 * embeddings compression — the storage half of Phase 4.
 *
 * Why fp16: bge-m3 embeddings are 1024-dim float32, so each vector is 4096
 * bytes raw or ~10–25 KB once JSON-stringified into MySQL. fp16 cuts that
 * to 2048 bytes per vector with negligible recall loss (<0.5% at 1024 dim
 * per LEANN's own measurements).
 *
 * Why not Float16Array: it landed in V8 as of Node 22, but earlier runtimes
 * (and many production deploys still on Node 20) don't have it. We pack
 * manually via DataView, which is portable and ~as fast since we do the
 * conversion once at compaction time.
 *
 * File format (compactRag.ts writes this):
 *   bytes  0..3   magic = "F16\\0"        (sanity check on read)
 *   byte   4      version = 1
 *   bytes  5..6   dim (uint16 LE)        (1024 for bge-m3)
 *   bytes  7..10  count (uint32 LE)
 *   bytes 11..14  reserved (zero)
 *   bytes 15..30  md5 of body bytes      (corruption detection)
 *   bytes 31..    body = count * dim * 2 (fp16 vectors, row-major)
 *
 * The body byte offset of the i-th vector's j-th dim is
 *   31 + i*dim*2 + j*2
 */

import { createHash } from 'node:crypto';

export const FP16_MAGIC = Buffer.from('F16\0', 'binary');
export const FP16_VERSION = 1;
export const FP16_HEADER_SIZE = 31;
const FP16_BYTES_PER_VALUE = 2;

/* ============================================================
   Single-value conversions (IEEE-754 binary16)
   ============================================================ */

/** float32 -> uint16 representation of binary16. Saturates on overflow,
 *  flushes subnormals to zero on the smallest end. */
export function f32ToF16(value: number): number {
  if (Number.isNaN(value)) return 0x7e00;
  if (value === 0) return Object.is(value, -0) ? 0x8000 : 0;

  const buf = new ArrayBuffer(4);
  new Float32Array(buf)[0] = value;
  const bits = new Uint32Array(buf)[0];

  const sign = (bits >>> 31) & 0x1;
  let exp = (bits >>> 23) & 0xff;
  let mant = bits & 0x7fffff;

  if (exp === 0xff) {
    // Inf / NaN. NaN handled above; pass infinity through.
    return (sign << 15) | 0x7c00 | (mant ? 0x200 : 0);
  }

  // Re-bias exponent (127 -> 15).
  let unbiased = exp - 127;
  if (unbiased > 15) {
    // Overflow -> Inf.
    return (sign << 15) | 0x7c00;
  }
  if (unbiased < -14) {
    // Subnormal range. Try to encode as fp16 subnormal; flush to 0 if too small.
    const shift = -14 - unbiased;
    if (shift > 24) return sign << 15;
    mant = (mant | 0x800000) >> shift;
    return (sign << 15) | (mant >>> 13);
  }

  const newExp = unbiased + 15;
  // Round to nearest even on the truncated mantissa bits.
  const halfMant = mant >>> 13;
  const remainder = mant & 0x1fff;
  let rounded = halfMant;
  if (remainder > 0x1000) rounded++;
  else if (remainder === 0x1000 && (halfMant & 1)) rounded++;
  // Mantissa overflow into exponent (e.g. 0x3ff + 1 = 0x400 -> exp +1).
  if (rounded === 0x400) {
    return (sign << 15) | ((newExp + 1) << 10);
  }
  return (sign << 15) | (newExp << 10) | rounded;
}

/** uint16 binary16 -> float32. */
export function f16ToF32(bits: number): number {
  const sign = (bits >>> 15) & 0x1;
  const exp = (bits >>> 10) & 0x1f;
  const mant = bits & 0x3ff;

  if (exp === 0) {
    if (mant === 0) return sign ? -0 : 0;
    // Subnormal: value = (-1)^s * 2^(-14) * (mant / 1024)
    const v = Math.pow(2, -14) * (mant / 1024);
    return sign ? -v : v;
  }
  if (exp === 0x1f) {
    return mant === 0
      ? (sign ? -Infinity : Infinity)
      : NaN;
  }
  const v = Math.pow(2, exp - 15) * (1 + mant / 1024);
  return sign ? -v : v;
}

/* ============================================================
   Vector batch pack / unpack
   ============================================================ */

/**
 * Pack a list of equal-dim float32 vectors into a Buffer with header.
 * Returns a single contiguous Buffer ready to write to disk.
 */
export function packVectors(vectors: number[][]): Buffer {
  if (vectors.length === 0) throw new Error('packVectors: empty input');
  const dim = vectors[0].length;
  if (dim > 0xffff) throw new Error(`packVectors: dim ${dim} exceeds uint16`);
  for (let i = 0; i < vectors.length; i++) {
    if (vectors[i].length !== dim) {
      throw new Error(`packVectors: dim mismatch at index ${i} (${vectors[i].length} != ${dim})`);
    }
  }

  const body = Buffer.alloc(vectors.length * dim * FP16_BYTES_PER_VALUE);
  let off = 0;
  for (const v of vectors) {
    for (let j = 0; j < dim; j++) {
      body.writeUInt16LE(f32ToF16(v[j]), off);
      off += FP16_BYTES_PER_VALUE;
    }
  }
  const checksum = createHash('md5').update(body).digest();

  const header = Buffer.alloc(FP16_HEADER_SIZE);
  FP16_MAGIC.copy(header, 0);
  header.writeUInt8(FP16_VERSION, 4);
  header.writeUInt16LE(dim, 5);
  header.writeUInt32LE(vectors.length, 7);
  // bytes 11..14 reserved (zero by Buffer.alloc).
  checksum.copy(header, 15);

  return Buffer.concat([header, body]);
}

export interface UnpackedVectors {
  dim: number;
  count: number;
  vectors: number[][];
}

/**
 * Unpack a fp16 file Buffer back into float32 vectors. Verifies magic +
 * checksum; throws on either failure (caller falls back to MySQL JSON).
 */
export function unpackVectors(buf: Buffer): UnpackedVectors {
  if (buf.length < FP16_HEADER_SIZE) throw new Error('fp16: buffer too small for header');
  if (buf.subarray(0, 4).compare(FP16_MAGIC) !== 0) throw new Error('fp16: bad magic');
  const version = buf.readUInt8(4);
  if (version !== FP16_VERSION) throw new Error(`fp16: unsupported version ${version}`);

  const dim = buf.readUInt16LE(5);
  const count = buf.readUInt32LE(7);
  const storedChecksum = buf.subarray(15, 31);
  const body = buf.subarray(FP16_HEADER_SIZE);

  const expectedBytes = count * dim * FP16_BYTES_PER_VALUE;
  if (body.length !== expectedBytes) {
    throw new Error(`fp16: body length ${body.length} != expected ${expectedBytes}`);
  }
  const actualChecksum = createHash('md5').update(body).digest();
  if (actualChecksum.compare(storedChecksum) !== 0) {
    throw new Error('fp16: checksum mismatch (file corrupt or truncated)');
  }

  const vectors: number[][] = new Array(count);
  for (let i = 0; i < count; i++) {
    const out = new Array<number>(dim);
    const base = i * dim * FP16_BYTES_PER_VALUE;
    for (let j = 0; j < dim; j++) {
      out[j] = f16ToF32(body.readUInt16LE(base + j * FP16_BYTES_PER_VALUE));
    }
    vectors[i] = out;
  }
  return { dim, count, vectors };
}
