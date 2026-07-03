const zlib = require('node:zlib');

const SBOX_1 = [
  14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
  0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
  4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
  15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13,
];
const SBOX_2 = [
  15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
  3, 13, 4, 7, 15, 2, 8, 15, 12, 0, 1, 10, 6, 9, 11, 5,
  0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
  13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9,
];
const SBOX_3 = [
  10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
  13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
  13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
  1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12,
];
const SBOX_4 = [
  7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
  13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
  10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
  3, 15, 0, 6, 10, 10, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14,
];
const SBOX_5 = [
  2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
  14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
  4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
  11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3,
];
const SBOX_6 = [
  12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
  10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
  9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
  4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13,
];
const SBOX_7 = [
  4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
  13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
  1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
  6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12,
];
const SBOX_8 = [
  13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
  1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
  7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
  2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11,
];

const KEY_ROUND_SHIFT = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const KEY_PERM_C = [
  56, 48, 40, 32, 24, 16, 8, 0, 57, 49, 41, 33, 25, 17,
  9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35,
];
const KEY_PERM_D = [
  62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21,
  13, 5, 60, 52, 44, 36, 28, 20, 12, 4, 27, 19, 11, 3,
];
const KEY_COMPRESSION = [
  13, 16, 10, 23, 0, 4, 2, 27, 14, 5, 20, 9,
  22, 18, 11, 3, 25, 7, 15, 6, 26, 19, 12, 1,
  40, 51, 30, 36, 46, 54, 29, 39, 50, 44, 32, 47,
  43, 48, 38, 55, 33, 52, 45, 41, 49, 35, 28, 31,
];

const QQ_KEY_1 = Buffer.from('!@#)(NHLiuy*$%^&', 'utf8');
const QQ_KEY_2 = Buffer.from('123ZXC!@#)(*$%^&', 'utf8');
const QQ_KEY_3 = Buffer.from('!@#)(*$%^&abcDEF', 'utf8');

function bitNum(arr, b, c) {
  const v = arr[Math.floor(b / 32) * 4 + 3 - Math.floor((b % 32) / 8)];
  return (((v >> (7 - (b % 8))) & 0x01) << c) >>> 0;
}

function bitNumIntr(a, b, c) {
  return ((((a >>> (31 - b)) & 0x01) << c) >>> 0);
}

function bitNumIntl(a, b, c) {
  return ((((a << b) >>> 0) & 0x80000000) >>> c) >>> 0;
}

function sboxBit(a) {
  return ((a & 0x20) | ((a & 0x1f) >> 1) | ((a & 0x01) << 4)) >>> 0;
}

function ip(input8) {
  let left = 0;
  let right = 0;

  left =
    bitNum(input8, 57, 31) | bitNum(input8, 49, 30) | bitNum(input8, 41, 29) | bitNum(input8, 33, 28) |
    bitNum(input8, 25, 27) | bitNum(input8, 17, 26) | bitNum(input8, 9, 25) | bitNum(input8, 1, 24) |
    bitNum(input8, 59, 23) | bitNum(input8, 51, 22) | bitNum(input8, 43, 21) | bitNum(input8, 35, 20) |
    bitNum(input8, 27, 19) | bitNum(input8, 19, 18) | bitNum(input8, 11, 17) | bitNum(input8, 3, 16) |
    bitNum(input8, 61, 15) | bitNum(input8, 53, 14) | bitNum(input8, 45, 13) | bitNum(input8, 37, 12) |
    bitNum(input8, 29, 11) | bitNum(input8, 21, 10) | bitNum(input8, 13, 9) | bitNum(input8, 5, 8) |
    bitNum(input8, 63, 7) | bitNum(input8, 55, 6) | bitNum(input8, 47, 5) | bitNum(input8, 39, 4) |
    bitNum(input8, 31, 3) | bitNum(input8, 23, 2) | bitNum(input8, 15, 1) | bitNum(input8, 7, 0);

  right =
    bitNum(input8, 56, 31) | bitNum(input8, 48, 30) | bitNum(input8, 40, 29) | bitNum(input8, 32, 28) |
    bitNum(input8, 24, 27) | bitNum(input8, 16, 26) | bitNum(input8, 8, 25) | bitNum(input8, 0, 24) |
    bitNum(input8, 58, 23) | bitNum(input8, 50, 22) | bitNum(input8, 42, 21) | bitNum(input8, 34, 20) |
    bitNum(input8, 26, 19) | bitNum(input8, 18, 18) | bitNum(input8, 10, 17) | bitNum(input8, 2, 16) |
    bitNum(input8, 60, 15) | bitNum(input8, 52, 14) | bitNum(input8, 44, 13) | bitNum(input8, 36, 12) |
    bitNum(input8, 28, 11) | bitNum(input8, 20, 10) | bitNum(input8, 12, 9) | bitNum(input8, 4, 8) |
    bitNum(input8, 62, 7) | bitNum(input8, 54, 6) | bitNum(input8, 46, 5) | bitNum(input8, 38, 4) |
    bitNum(input8, 30, 3) | bitNum(input8, 22, 2) | bitNum(input8, 14, 1) | bitNum(input8, 6, 0);

  return [left >>> 0, right >>> 0];
}

function invIp(state) {
  const [left, right] = state;
  const out = Buffer.alloc(8);

  out[3] = bitNumIntr(right, 7, 7) | bitNumIntr(left, 7, 6) | bitNumIntr(right, 15, 5) |
    bitNumIntr(left, 15, 4) | bitNumIntr(right, 23, 3) | bitNumIntr(left, 23, 2) |
    bitNumIntr(right, 31, 1) | bitNumIntr(left, 31, 0);
  out[2] = bitNumIntr(right, 6, 7) | bitNumIntr(left, 6, 6) | bitNumIntr(right, 14, 5) |
    bitNumIntr(left, 14, 4) | bitNumIntr(right, 22, 3) | bitNumIntr(left, 22, 2) |
    bitNumIntr(right, 30, 1) | bitNumIntr(left, 30, 0);
  out[1] = bitNumIntr(right, 5, 7) | bitNumIntr(left, 5, 6) | bitNumIntr(right, 13, 5) |
    bitNumIntr(left, 13, 4) | bitNumIntr(right, 21, 3) | bitNumIntr(left, 21, 2) |
    bitNumIntr(right, 29, 1) | bitNumIntr(left, 29, 0);
  out[0] = bitNumIntr(right, 4, 7) | bitNumIntr(left, 4, 6) | bitNumIntr(right, 12, 5) |
    bitNumIntr(left, 12, 4) | bitNumIntr(right, 20, 3) | bitNumIntr(left, 20, 2) |
    bitNumIntr(right, 28, 1) | bitNumIntr(left, 28, 0);
  out[7] = bitNumIntr(right, 3, 7) | bitNumIntr(left, 3, 6) | bitNumIntr(right, 11, 5) |
    bitNumIntr(left, 11, 4) | bitNumIntr(right, 19, 3) | bitNumIntr(left, 19, 2) |
    bitNumIntr(right, 27, 1) | bitNumIntr(left, 27, 0);
  out[6] = bitNumIntr(right, 2, 7) | bitNumIntr(left, 2, 6) | bitNumIntr(right, 10, 5) |
    bitNumIntr(left, 10, 4) | bitNumIntr(right, 18, 3) | bitNumIntr(left, 18, 2) |
    bitNumIntr(right, 26, 1) | bitNumIntr(left, 26, 0);
  out[5] = bitNumIntr(right, 1, 7) | bitNumIntr(left, 1, 6) | bitNumIntr(right, 9, 5) |
    bitNumIntr(left, 9, 4) | bitNumIntr(right, 17, 3) | bitNumIntr(left, 17, 2) |
    bitNumIntr(right, 25, 1) | bitNumIntr(left, 25, 0);
  out[4] = bitNumIntr(right, 0, 7) | bitNumIntr(left, 0, 6) | bitNumIntr(right, 8, 5) |
    bitNumIntr(left, 8, 4) | bitNumIntr(right, 16, 3) | bitNumIntr(left, 16, 2) |
    bitNumIntr(right, 24, 1) | bitNumIntr(left, 24, 0);

  return out;
}

function f(state, key6) {
  const lrg = Buffer.alloc(6);

  let t1 =
    bitNumIntl(state, 31, 0) | ((state & 0xf0000000) >>> 1) | bitNumIntl(state, 4, 5) |
    bitNumIntl(state, 3, 6) | ((state & 0x0f000000) >>> 3) | bitNumIntl(state, 8, 11) |
    bitNumIntl(state, 7, 12) | ((state & 0x00f00000) >>> 5) | bitNumIntl(state, 12, 17) |
    bitNumIntl(state, 11, 18) | ((state & 0x000f0000) >>> 7) | bitNumIntl(state, 16, 23);
  let t2 =
    bitNumIntl(state, 15, 0) | ((state & 0x0000f000) << 15) | bitNumIntl(state, 20, 5) |
    bitNumIntl(state, 19, 6) | ((state & 0x00000f00) << 13) | bitNumIntl(state, 24, 11) |
    bitNumIntl(state, 23, 12) | ((state & 0x000000f0) << 11) | bitNumIntl(state, 28, 17) |
    bitNumIntl(state, 27, 18) | ((state & 0x0000000f) << 9) | bitNumIntl(state, 0, 23);

  t1 >>>= 0;
  t2 >>>= 0;
  lrg[0] = (t1 >>> 24) & 0xff;
  lrg[1] = (t1 >>> 16) & 0xff;
  lrg[2] = (t1 >>> 8) & 0xff;
  lrg[3] = (t2 >>> 24) & 0xff;
  lrg[4] = (t2 >>> 16) & 0xff;
  lrg[5] = (t2 >>> 8) & 0xff;

  for (let i = 0; i < 6; i += 1) {
    lrg[i] ^= key6[i];
  }

  let out =
    (SBOX_1[sboxBit(lrg[0] >>> 2)] << 28) |
    (SBOX_2[sboxBit(((lrg[0] & 0x03) << 4) | (lrg[1] >>> 4))] << 24) |
    (SBOX_3[sboxBit(((lrg[1] & 0x0f) << 2) | (lrg[2] >>> 6))] << 20) |
    (SBOX_4[sboxBit(lrg[2] & 0x3f)] << 16) |
    (SBOX_5[sboxBit(lrg[3] >>> 2)] << 12) |
    (SBOX_6[sboxBit(((lrg[3] & 0x03) << 4) | (lrg[4] >>> 4))] << 8) |
    (SBOX_7[sboxBit(((lrg[4] & 0x0f) << 2) | (lrg[5] >>> 6))] << 4) |
    SBOX_8[sboxBit(lrg[5] & 0x3f)];
  out >>>= 0;

  out =
    bitNumIntl(out, 15, 0) | bitNumIntl(out, 6, 1) | bitNumIntl(out, 19, 2) |
    bitNumIntl(out, 20, 3) | bitNumIntl(out, 28, 4) | bitNumIntl(out, 11, 5) |
    bitNumIntl(out, 27, 6) | bitNumIntl(out, 16, 7) | bitNumIntl(out, 0, 8) |
    bitNumIntl(out, 14, 9) | bitNumIntl(out, 22, 10) | bitNumIntl(out, 25, 11) |
    bitNumIntl(out, 4, 12) | bitNumIntl(out, 17, 13) | bitNumIntl(out, 30, 14) |
    bitNumIntl(out, 9, 15) | bitNumIntl(out, 1, 16) | bitNumIntl(out, 7, 17) |
    bitNumIntl(out, 23, 18) | bitNumIntl(out, 13, 19) | bitNumIntl(out, 31, 20) |
    bitNumIntl(out, 26, 21) | bitNumIntl(out, 2, 22) | bitNumIntl(out, 8, 23) |
    bitNumIntl(out, 18, 24) | bitNumIntl(out, 12, 25) | bitNumIntl(out, 29, 26) |
    bitNumIntl(out, 5, 27) | bitNumIntl(out, 21, 28) | bitNumIntl(out, 10, 29) |
    bitNumIntl(out, 3, 30) | bitNumIntl(out, 24, 31);

  return out >>> 0;
}

function desKeySetup(rawKey, mode) {
  const key = Buffer.alloc(8);
  Buffer.from(rawKey).copy(key, 0, 0, 8);
  const schedule = Array.from({ length: 16 }, () => Buffer.alloc(6));

  let c = 0;
  let d = 0;
  for (let i = 0, j = 31; i < 28; i += 1, j -= 1) {
    c |= bitNum(key, KEY_PERM_C[i], j);
    d |= bitNum(key, KEY_PERM_D[i], j);
  }
  c >>>= 0;
  d >>>= 0;

  for (let i = 0; i < 16; i += 1) {
    c = (((c << KEY_ROUND_SHIFT[i]) | (c >>> (28 - KEY_ROUND_SHIFT[i]))) & 0xfffffff0) >>> 0;
    d = (((d << KEY_ROUND_SHIFT[i]) | (d >>> (28 - KEY_ROUND_SHIFT[i]))) & 0xfffffff0) >>> 0;
    const toGen = mode === 'decrypt' ? 15 - i : i;
    for (let j = 0; j < 24; j += 1) {
      schedule[toGen][Math.floor(j / 8)] |= bitNumIntr(c, KEY_COMPRESSION[j], 7 - (j % 8));
    }
    for (let j = 24; j < 48; j += 1) {
      schedule[toGen][Math.floor(j / 8)] |= bitNumIntr(d, KEY_COMPRESSION[j] - 27, 7 - (j % 8));
    }
  }

  return schedule;
}

function desCryptBlock(input8, schedule) {
  const state = ip(input8);
  for (let i = 0; i < 15; i += 1) {
    const t = state[1];
    state[1] = (f(state[1], schedule[i]) ^ state[0]) >>> 0;
    state[0] = t >>> 0;
  }
  state[0] = (f(state[1], schedule[15]) ^ state[0]) >>> 0;
  return invIp(state);
}

function qqDesTransform(buffer, key, mode) {
  const input = Buffer.from(buffer);
  const output = Buffer.alloc(input.length);
  const schedule = desKeySetup(key, mode);
  for (let i = 0; i + 8 <= input.length; i += 8) {
    const block = desCryptBlock(input.subarray(i, i + 8), schedule);
    block.copy(output, i);
  }
  return output;
}

function qqKaraokeDecryptHex(hexLyrics) {
  const payload = String(hexLyrics || '').trim();
  if (!payload || !/^[0-9a-fA-F]+$/.test(payload) || payload.length % 2 !== 0) {
    return '';
  }

  const encrypted = Buffer.from(payload, 'hex');
  if (encrypted.length % 8 !== 0) {
    return '';
  }

  // QQ's "buggy DES" sequence: Ddes(key1) -> des(key2) -> Ddes(key3)
  const step1 = qqDesTransform(encrypted, QQ_KEY_1, 'decrypt');
  const step2 = qqDesTransform(step1, QQ_KEY_2, 'encrypt');
  const step3 = qqDesTransform(step2, QQ_KEY_3, 'decrypt');

  const tryDecompress = (fn) => {
    try {
      return fn(step3).toString('utf8');
    } catch {
      return '';
    }
  };

  // QQ payloads are usually zlib-deflated, but some tracks appear to ship with
  // gzip headers or raw-deflate streams. Try the common variants before giving up.
  return (
    tryDecompress(zlib.inflateSync) ||
    tryDecompress(zlib.gunzipSync) ||
    tryDecompress(zlib.inflateRawSync) ||
    ''
  );
}

module.exports = {
  qqKaraokeDecryptHex,
};
