// Generated mobile bundle from DesktopBridge/src/lyrics/parts.
// Keep source behavior aligned with the Desktop Bridge parts.
import { Buffer } from "buffer";
import * as pako from "pako";
import CryptoJS from "crypto-js";

const process = { env: {} };
const isBrowserRuntime =
  typeof window !== "undefined" && typeof document !== "undefined";
const isReactNativeRuntime =
  typeof navigator !== "undefined" && navigator.product === "ReactNative";
const REACT_NATIVE_UNSAFE_REQUEST_HEADERS = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "host",
  "priority",
]);

function makeMobileSafeHeaders(headers = {}) {
  if (!headers || typeof headers !== "object") {
    return {};
  }
  const safeHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const headerName = String(key || "").trim();
    const lowerName = headerName.toLowerCase();
    if (!headerName) {
      continue;
    }
    if (isReactNativeRuntime) {
      if (
        REACT_NATIVE_UNSAFE_REQUEST_HEADERS.has(lowerName) ||
        lowerName.startsWith("sec-")
      ) {
        continue;
      }
    } else if (isBrowserRuntime && lowerName === "user-agent") {
      continue;
    }
    safeHeaders[headerName] = value;
  }
  return safeHeaders;
}

// Spicy Lyrics uses the same request profile as the DesktopBridge client. The
// native fetch implementation can carry the browser-style Sec-* hints, but
// still rejects transport-controlled headers such as Host and Content-Length.
// Keep those hints intact so community-uploaded lyrics are served through the
// same API path (including the syllable payload) on mobile.
function makeSpicyLyricsHeaders(headers = {}) {
  if (!headers || typeof headers !== "object") {
    return {};
  }
  const safeHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const headerName = String(key || "").trim();
    const lowerName = headerName.toLowerCase();
    if (!headerName) {
      continue;
    }
    if (isReactNativeRuntime) {
      if (
        lowerName === "accept-encoding" ||
        lowerName === "connection" ||
        lowerName === "content-length" ||
        lowerName === "host"
      ) {
        continue;
      }
    } else if (isBrowserRuntime && lowerName === "user-agent") {
      continue;
    }
    safeHeaders[headerName] = value;
  }
  return safeHeaders;
}

function wordArrayToBase64(wordArray) {
  return CryptoJS.enc.Base64.stringify(wordArray);
}

function wordArrayToHex(wordArray) {
  return CryptoJS.enc.Hex.stringify(wordArray);
}

const crypto = {
  createHash(algorithm) {
    const chunks = [];
    return {
      update(value) {
        chunks.push(String(value ?? ""));
        return this;
      },
      digest(encoding = "hex") {
        const input = chunks.join("");
        const normalized = String(algorithm || "").toLowerCase();
        const hash = normalized === "sha1"
          ? CryptoJS.SHA1(input)
          : normalized === "md5"
            ? CryptoJS.MD5(input)
            : CryptoJS.SHA256(input);
        return encoding === "base64" ? wordArrayToBase64(hash) : wordArrayToHex(hash);
      },
    };
  },
  createHmac(algorithm, key) {
    const chunks = [];
    return {
      update(value) {
        chunks.push(String(value ?? ""));
        return this;
      },
      digest(encoding = "hex") {
        const input = chunks.join("");
        const normalized = String(algorithm || "").toLowerCase();
        const hmac = normalized === "sha1"
          ? CryptoJS.HmacSHA1(input, String(key ?? ""))
          : CryptoJS.HmacSHA256(input, String(key ?? ""));
        return encoding === "base64" ? wordArrayToBase64(hmac) : wordArrayToHex(hmac);
      },
    };
  },
  randomUUID() {
    if (typeof globalThis.crypto?.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
      const value = Math.floor(Math.random() * 16);
      const nibble = char === "x" ? value : (value & 0x3) | 0x8;
      return nibble.toString(16);
    });
  },
};

const mobileZlib = {
  inflateSync(input) {
    return Buffer.from(pako.inflate(input));
  },
  inflateRawSync(input) {
    return Buffer.from(pako.inflateRaw(input));
  },
  gunzipSync(input) {
    return Buffer.from(pako.ungzip(input));
  },
};

const mobileLyricsVaultShim = {
  getLyricsVaultStore: () => null,
  resolveVaultSourceLabel: (_lyrics, fallback = "local-vault") => fallback || "local-vault",
  parseLyricsImportFile: () => ({ lyrics: [] }),
};

const mobileTtmlImportShim = {
  parseTtmlToLyrics: () => ({ lyrics: [] }),
  extractTtmlMetadata: () => ({}),
};

// ---- DesktopBridge/src/slObjPack.js ----
const DEFAULT_LIMITS = {
    depth: 512,
    arrayLength: 1 << 20,    // ~1M items
    objectKeys: 1 << 16,     // 64K keys
    streamLength: 1 << 24,   // ~16M stream entries
    valuesLength: 1 << 22,   // ~4M unique values
    decodeOps: 1 << 22,      // Combined budget for schema arrays
};

// Keys we refuse to round-trip. `safeSet` already prevents prototype
// pollution via `defineProperty`, but these names cause confusion in
// any code downstream that touches the result without paranoia
// (`for…in`, `Object.assign`, accessing `.constructor`, etc.).
const DEFAULT_FORBIDDEN_KEYS = new Set([
    '__proto__',
    'constructor',
    'prototype',
]);

class SLObjPack {
    constructor(options = {}) {
        const overrides = options.limits ?? {};
        // Per-field defaulting so passing `{ depth: undefined }` still
        // resolves to the default rather than being treated as a 0/NaN cap.
        this.limits = {
            depth: overrides.depth ?? DEFAULT_LIMITS.depth,
            arrayLength: overrides.arrayLength ?? DEFAULT_LIMITS.arrayLength,
            objectKeys: overrides.objectKeys ?? DEFAULT_LIMITS.objectKeys,
            streamLength: overrides.streamLength ?? DEFAULT_LIMITS.streamLength,
            valuesLength: overrides.valuesLength ?? DEFAULT_LIMITS.valuesLength,
            decodeOps: overrides.decodeOps ?? DEFAULT_LIMITS.decodeOps,
        };
        // Copy the caller's set so later mutations don't bleed into the
        // instance's enforcement.
        this.forbiddenKeys = options.forbiddenKeys
            ? new Set(options.forbiddenKeys)
            : new Set(DEFAULT_FORBIDDEN_KEYS);
    }

    pack(jsonObj) {
        const limits = this.limits;
        const forbiddenKeys = this.forbiddenKeys;

        // -------- Pass 1: validating snapshot --------
        // Walks the input exactly once, producing a plain inert tree.
        // After this returns, all subsequent passes operate on that tree —
        // so getters, Proxies, mutation in flight, and `Array.isArray`
        // shenanigans can't desync the count and emit phases.
        // Also catches cycles, non-finite numbers, BigInt/Symbol/function,
        // class instances, oversized arrays/objects, and forbidden keys.
        const seen = new WeakSet();

        function snapshot(node, depth) {
            if (depth > limits.depth) {
                throw new Error("SLObjPack pack: Max depth exceeded");
            }

            if (node === null) return null;

            const t = typeof node;
            if (t === 'string' || t === 'boolean') return node;
            if (t === 'number') {
                if (!Number.isFinite(node)) {
                    throw new Error("SLObjPack pack: Non-finite number not supported");
                }
                return node;
            }
            if (t !== 'object') {
                // undefined, bigint, symbol, function — none round-trip safely
                throw new Error("SLObjPack pack: Unsupported value type: " + t);
            }

            const objNode = node;
            if (seen.has(objNode)) {
                throw new Error("SLObjPack pack: Circular reference detected");
            }
            seen.add(objNode);

            try {
                if (Array.isArray(node)) {
                    const len = node.length;
                    if (len > limits.arrayLength) {
                        throw new Error("SLObjPack pack: Array length exceeds limit");
                    }
                    const out = new Array(len);
                    for (let i = 0; i < len; i++) {
                        out[i] = snapshot(node[i], depth + 1);
                    }
                    return out;
                }

                // Plain objects only. Date/Map/Set/RegExp/class instances
                // would be packed as `{}` (data loss); reject them up front.
                const proto = Object.getPrototypeOf(node);
                if (proto !== Object.prototype && proto !== null) {
                    throw new Error("SLObjPack pack: Non-plain object not supported");
                }

                const record = node;
                const keys = Object.keys(record);
                if (keys.length > limits.objectKeys) {
                    throw new Error("SLObjPack pack: Object key count exceeds limit");
                }

                const out = {};
                for (const k of keys) {
                    if (forbiddenKeys.has(k)) {
                        throw new Error("SLObjPack pack: Forbidden key: " + k);
                    }
                    // defineProperty in case `node` has a getter on `k` —
                    // we call it exactly once here, store the result inert.
                    Object.defineProperty(out, k, {
                        value: snapshot(record[k], depth + 1),
                        writable: true,
                        enumerable: true,
                        configurable: true,
                    });
                }
                return out;
            } finally {
                seen.delete(objNode);
            }
        }

        const safe = snapshot(jsonObj, 0);

        // -------- Pass 2: frequency count over the snapshot --------
        const primitivesFrequency = new Map();

        function countPrimitives(node, depth) {
            if (depth > limits.depth) {
                throw new Error("SLObjPack pack: Max depth exceeded");
            }
            if (node === null || typeof node !== 'object') {
                const prim = node;
                primitivesFrequency.set(prim, (primitivesFrequency.get(prim) ?? 0) + 1);
                return;
            }
            if (Array.isArray(node)) {
                for (let i = 0; i < node.length; i++) {
                    countPrimitives(node[i], depth + 1);
                }
            } else {
                const obj = node;
                const keys = Object.keys(obj);
                for (const k of keys) {
                    primitivesFrequency.set(k, (primitivesFrequency.get(k) ?? 0) + 1);
                    countPrimitives(obj[k], depth + 1);
                }
            }
        }
        countPrimitives(safe, 0);

        const valuesList = Array.from(primitivesFrequency.entries())
            .sort((a, b) => b[1] - a[1])
            .map(e => e[0]);

        const valueToIndex = new Map();
        valuesList.forEach((val, idx) => valueToIndex.set(val, idx));

        const getPtr = (node) => {
            const ptr = valueToIndex.get(node);
            if (ptr === undefined) {
                // Invariant: every primitive in `safe` was counted in pass 2.
                // Reaching here means pass 1's snapshot diverged from pass 2/3.
                throw new Error("SLObjPack pack: Internal error — unindexed primitive");
            }
            return ptr;
        };

        // Order-sensitive on purpose — JS preserves insertion order and we
        // want round-trip key-order identity. Don't canonicalize here
        // without also changing emit/unpack to match.
        function isSchemaArray(arr) {
            if (arr.length === 0) return false;
            const first = arr[0];
            if (typeof first !== 'object' || first === null || Array.isArray(first)) return false;

            const keys0 = Object.keys(first);
            if (keys0.length === 0) return false;

            for (let i = 1; i < arr.length; i++) {
                const item = arr[i];
                if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
                const keysI = Object.keys(item);
                if (keysI.length !== keys0.length) return false;
                for (let k = 0; k < keys0.length; k++) {
                    if (keysI[k] !== keys0[k]) return false;
                }
            }
            return keys0;
        }

        // -------- Pass 3: emit opcode stream --------
        const stream = [];

        function emit(node, depth) {
            if (depth > limits.depth) {
                throw new Error("SLObjPack pack: Max depth exceeded");
            }
            if (node === null || typeof node !== 'object') {
                stream.push(getPtr(node));
                return;
            }

            if (Array.isArray(node)) {
                if (node.length === 0) { stream.push(-4); return; }
                if (node.length === 1) {
                    stream.push(-5);
                    emit(node[0], depth + 1);
                    return;
                }

                const schemaKeys = isSchemaArray(node);
                if (schemaKeys) {
                    stream.push(-3);
                    stream.push(node.length);
                    stream.push(schemaKeys.length);
                    schemaKeys.forEach(k => stream.push(getPtr(k)));
                    node.forEach(item => {
                        const rec = item;
                        schemaKeys.forEach(k => emit(rec[k], depth + 1));
                    });
                    return;
                }

                stream.push(-2);
                stream.push(node.length);
                node.forEach(n => emit(n, depth + 1));
                return;
            }

            const objNode = node;
            const keys = Object.keys(objNode);
            if (keys.length === 0) { stream.push(-6); return; }

            stream.push(-1);
            stream.push(keys.length);
            keys.forEach(k => stream.push(getPtr(k)));
            keys.forEach(k => emit(objNode[k], depth + 1));
        }

        emit(safe, 0);
        return [valuesList, stream];
    }

    unpack(packed) {
        const limits = this.limits;
        const forbiddenKeys = this.forbiddenKeys;

        // -------- Shell validation --------
        if (!Array.isArray(packed) || packed.length !== 2) {
            throw new Error("SLObjPack unpack: Invalid payload structure");
        }
        const valuesListRaw = packed[0];
        const streamRaw = packed[1];
        if (!Array.isArray(valuesListRaw) || !Array.isArray(streamRaw)) {
            throw new Error("SLObjPack unpack: Invalid payload structure");
        }

        // -------- Global size caps --------
        // Even when individual structure counts are within limits, the
        // overall payload can otherwise be arbitrarily large.
        if (valuesListRaw.length > limits.valuesLength) {
            throw new Error("SLObjPack unpack: valuesList exceeds limit");
        }
        if (streamRaw.length > limits.streamLength) {
            throw new Error("SLObjPack unpack: stream exceeds limit");
        }

        // -------- valuesList content validation --------
        // resolvePointer returns these values verbatim. Reject anything
        // that pack would never produce so the unpack contract is
        // explicit even when the input wasn't JSON-derived.
        for (let i = 0; i < valuesListRaw.length; i++) {
            const v = valuesListRaw[i];
            if (v === null) continue;
            const t = typeof v;
            if (t === 'string' || t === 'boolean') continue;
            if (t === 'number') {
                if (!Number.isFinite(v)) {
                    throw new Error("SLObjPack unpack: Non-finite number in valuesList at " + i);
                }
                continue;
            }
            throw new Error("SLObjPack unpack: Invalid valuesList entry at " + i + " (type " + t + ")");
        }
        const valuesList = valuesListRaw;
        const stream = streamRaw;

        const streamLen = stream.length;
        const valuesLen = valuesList.length;
        let cursor = 0;

        function readStream() {
            if (cursor >= streamLen) {
                throw new Error("SLObjPack unpack: Unexpected end of stream");
            }
            return stream[cursor++];
        }

        function resolvePointer(ptr) {
            if (typeof ptr !== 'number' || !Number.isInteger(ptr) || ptr < 0 || ptr >= valuesLen) {
                throw new Error("SLObjPack unpack: Invalid value pointer " + ptr);
            }
            return valuesList[ptr];
        }

        function readKey() {
            const key = resolvePointer(readStream());
            if (typeof key !== 'string') {
                throw new Error("SLObjPack unpack: Keys must be strings, got " + typeof key);
            }
            // Symmetric with pack; defense in depth alongside `safeSet`.
            if (forbiddenKeys.has(key)) {
                throw new Error("SLObjPack unpack: Forbidden key: " + key);
            }
            return key;
        }

        // defineProperty installs `__proto__` (and any other inherited
        // setter name) as a regular own property without invoking the
        // prototype-chain setter.
        function safeSet(obj, key, value) {
            Object.defineProperty(obj, key, {
                value,
                writable: true,
                enumerable: true,
                configurable: true,
            });
        }

        function validateCount(n, max, label) {
            if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > max) {
                throw new Error("SLObjPack unpack: Invalid " + label + " count: " + n);
            }
        }

        // Tight lower bound on remaining stream — `min` is the smallest
        // possible number of additional slots this structure can consume
        // (assuming every nested value is a single primitive pointer).
        function requireStream(min, label) {
            if (min > streamLen - cursor) {
                throw new Error("SLObjPack unpack: " + label + " exceeds remaining stream");
            }
        }

        // Depth is an explicit argument now, matching pack's convention:
        // root is depth 0, children depth + 1. Both functions cap at
        // exactly `MAX_DEPTH + 1` levels of nesting from the root.
        function decode(depth) {
            if (depth > limits.depth) {
                throw new Error("SLObjPack unpack: Max depth exceeded");
            }
            const op = readStream();
            if (typeof op !== 'number' || !Number.isInteger(op)) {
                throw new Error("SLObjPack unpack: Invalid opcode " + op);
            }
            if (op >= 0) return resolvePointer(op);

            switch (op) {
                case -1: {
                    const numKeys = readStream();
                    validateCount(numKeys, limits.objectKeys, "object key");
                    // numKeys key pointers + numKeys values (≥1 slot each)
                    requireStream(numKeys * 2, "object");
                    const keys = new Array(numKeys);
                    for (let i = 0; i < numKeys; i++) keys[i] = readKey();
                    const obj = {};
                    for (let i = 0; i < numKeys; i++) safeSet(obj, keys[i], decode(depth + 1));
                    return obj;
                }
                case -2: {
                    const numItems = readStream();
                    validateCount(numItems, limits.arrayLength, "array item");
                    requireStream(numItems, "array");
                    const arr = new Array(numItems);
                    for (let i = 0; i < numItems; i++) arr[i] = decode(depth + 1);
                    return arr;
                }
                case -3: {
                    const numItems = readStream();
                    validateCount(numItems, limits.arrayLength, "schema array item");
                    const numKeys = readStream();
                    validateCount(numKeys, limits.objectKeys, "schema key");
                    // Combined budget — individual caps multiply for `-3`.
                    if (numItems * numKeys > limits.decodeOps) {
                        throw new Error("SLObjPack unpack: Schema array decode budget exceeded");
                    }
                    // numKeys schema key pointers + numItems*numKeys values
                    requireStream(numKeys + numItems * numKeys, "schema array");
                    const keys = new Array(numKeys);
                    for (let i = 0; i < numKeys; i++) keys[i] = readKey();
                    const arr = new Array(numItems);
                    for (let i = 0; i < numItems; i++) {
                        const obj = {};
                        for (let k = 0; k < numKeys; k++) {
                            safeSet(obj, keys[k], decode(depth + 1));
                        }
                        arr[i] = obj;
                    }
                    return arr;
                }
                case -4: return [];
                case -5: return [decode(depth + 1)];
                case -6: return {};
                default:
                    throw new Error("SLObjPack unpack: Unknown opcode " + op);
            }
        }

        const result = decode(0);

        // Trailing garbage rejection — prevents hidden payloads tacked on.
        if (cursor !== streamLen) {
            throw new Error("SLObjPack unpack: Extra data after decoding");
        }

        return result;
    }
}

function isSpicyObjPackPayload(value) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Array.isArray(value[0]) &&
    Array.isArray(value[1])
  );
}

// ---- DesktopBridge/src/qqBuggyDes.js ----
const zlib = mobileZlib;

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

// ---- DesktopBridge/src/lyrics/parts/01a-text-normalization.js ----
// Text normalization, candidate scoring helpers, LRC/QRC/YRC parsing, and generic source error helpers.
// This file is evaluated by ../index.js in a shared compatibility context.
// Keep behavior changes deliberate; most code here was moved verbatim from src/lyricsService.js.


const featuringRegex = /(?:^|[\s([{,-])(?:feat\.?|ft\.?|featuring)\s+.+$/i;
const artistSplitRegex = /\b(?:feat\.?|ft\.?|featuring)\b|,|;|&|\/|\||\s+x\s+/i;
const LEADING_PREFIX_MERGE_THRESHOLD_MS = 50;
const MATCH_ACCEPTANCE_THRESHOLD = 5;
const MATCH_CONFIDENCE_SCORE = 7;
const EARLY_RETURN_COVERAGE_RATIO = 0.9;
const AMBIGUITY_MAX_SCORE_GAP = 1.2;
/** Above this overlap, title-matched candidates use strict `isLikelySameTrack` only. */
const ARTIST_OVERLAP_CONFIDENT_THRESHOLD = 0.75;
/** Clear-winner fallback when no title-matched row exceeds the confident threshold. */
const CLEAR_WINNER_MIN_OVERLAP = 0.65;
const CLEAR_WINNER_MIN_OVERLAP_GAP = 0.15;
const VALID_SOURCE_KEYS = new Set([
  "auto",
  "local-vault",
  "kugou",
  "netease",
  "qq-direct",
  "musixmatch",
  "lrclib",
  "spicy-lyrics",
]);
const TEMPORARILY_DISABLED_SOURCES = new Set([]);
const SOURCE_ALIASES = Object.freeze({
  163: "netease",
  "netease-cloud-music": "netease",
  "qq-mirror": "qq-direct",
  mxm: "musixmatch",
  "musixmatch-token": "musixmatch",
  spicy: "spicy-lyrics",
  spicylyrics: "spicy-lyrics",
  spicy_lyrics: "spicy-lyrics",
  vault: "local-vault",
  "local-vault-line": "local-vault",
  "local-vault-karaoke": "local-vault",
  "kugou-music": "kugou",
  kugoumusic: "kugou",
});
const KUGOU_KRC_XOR_KEY = Uint8Array.from([
  64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105,
]);
const MAX_QUERY_VARIANTS = 3;
const MAX_MUSIXMATCH_ARTIST_VARIANTS = 3;
const MAX_QQ_LEGACY_CANDIDATES = 8;
const MAX_QQ_DIRECT_CANDIDATES = 10;
const QQ_DIRECT_CANDIDATE_PARALLELISM = 4;
const QQ_DIRECT_CANDIDATE_PROBE_CAP = 8;
const QQ_DIRECT_LYRIC_FETCH_TIMEOUT_MS = 8_000;
const MAX_SPOTIFY_TRACK_CANDIDATES = 12;
const MAX_SPICY_STRICT_SPOTIFY_CANDIDATES = 3;
const SPICY_QQ_FINGERPRINT_TIMEOUT_MS = 3_000;
const VERSION_HINTS = [
  "japanese",
  "jpn",
  "jp ver",
  "japanese ver",
  "japanese version",
  "english",
  "eng ver",
  "english ver",
  "english version",
  "korean",
  "kr ver",
  "korean ver",
  "korean version",
  "romanized",
  "romaji",
  "live",
  "remix",
  "acoustic",
  "instrumental",
  "inst",
  "karaoke",
  "sped up",
  "slowed",
  "tv size",
  "short ver",
  "version",
  "ver",
];
const LANGUAGE_VARIANT_HINTS = [
  "japanese",
  "jpn",
  "jp ver",
  "japanese ver",
  "japanese version",
  "english",
  "eng ver",
  "english ver",
  "english version",
  "korean",
  "kr ver",
  "korean ver",
  "korean version",
  "romanized",
  "romaji",
];

function foldDiacritics(input) {
  return String(input || "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "");
}

function normalizeText(input) {
  return foldDiacritics(String(input || ""))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip feat. suffixes from artist strings (Spotify artist field is primary-only). */
function normalizeArtistText(input) {
  return foldDiacritics(String(input || ""))
    .toLowerCase()
    .replace(featuringRegex, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ponytail: alias kept to avoid updating 20+ call sites in shared VM scope
const normalizeMatchText = normalizeText;

function extractParentheticalAliases(input) {
  const raw = String(input || "");
  const matches = raw.match(/\(([^)]+)\)/g) || [];
  const aliases = [];
  const seen = new Set();
  for (const match of matches) {
    const inner = normalizeMatchText(String(match || "").slice(1, -1));
    if (!inner || inner.length < 2 || seen.has(inner)) {
      continue;
    }
    seen.add(inner);
    aliases.push(inner);
  }
  return aliases;
}

function tokens(input) {
  return normalizeText(input).split(" ").filter(Boolean);
}

function getPrimaryArtistName(input) {
  return (
    String(input || "")
      .split(artistSplitRegex)
      .map((part) => part.trim())
      .filter(Boolean)[0] || String(input || "").trim()
  );
}

function getArtistNames(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    return [];
  }

  const names = [];
  const seen = new Set();
  const addName = (value) => {
    const safe = String(value || "").trim();
    if (!safe) {
      return;
    }
    const key = safe.toLowerCase().replace(/\s+/g, " ");
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    names.push(safe);
  };

  addName(raw);
  for (const fragment of raw.split(artistSplitRegex)) {
    addName(fragment);
  }
  addName(getPrimaryArtistName(raw));
  return names;
}

function buildMusixmatchArtistVariants(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    return [];
  }

  const variants = [];
  const seen = new Set();
  const addVariant = (value) => {
    const safe = String(value || "").trim();
    if (!safe) {
      return;
    }
    const key = safe.toLowerCase().replace(/\s+/g, " ");
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    variants.push(safe);
  };

  addVariant(raw);
  addVariant(getPrimaryArtistName(raw));
  for (const fragment of raw.split(artistSplitRegex)) {
    addVariant(fragment);
  }

  // Handle artist handles like "dabin.kr" where Musixmatch often indexes as "Dabin".
  const strippedDomain = raw.replace(/\.[a-z]{2,3}$/i, "").trim();
  addVariant(strippedDomain);

  const punctuationSplit = raw
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  addVariant(punctuationSplit);

  const normalizedTokens = tokens(raw);
  if (normalizedTokens.length > 1) {
    const maybeSuffix = normalizedTokens[normalizedTokens.length - 1];
    if (/^[a-z]{2,3}$/i.test(maybeSuffix)) {
      addVariant(normalizedTokens.slice(0, -1).join(" "));
    }
  }

  return variants.slice(0, MAX_MUSIXMATCH_ARTIST_VARIANTS);
}

function overlapRatio(a, b) {
  if (!a.length || !b.length) {
    return 0;
  }
  const bSet = new Set(b);
  let shared = 0;
  for (const token of a) {
    if (bSet.has(token)) {
      shared += 1;
    }
  }
  return shared / Math.max(a.length, b.length);
}

function hasTokenSequence(haystackTokens, needleTokens) {
  if (!haystackTokens.length || !needleTokens.length) {
    return false;
  }
  if (needleTokens.length > haystackTokens.length) {
    return false;
  }
  for (
    let startIndex = 0;
    startIndex <= haystackTokens.length - needleTokens.length;
    startIndex += 1
  ) {
    let matched = true;
    for (let index = 0; index < needleTokens.length; index += 1) {
      if (haystackTokens[startIndex + index] !== needleTokens[index]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return true;
    }
  }
  return false;
}

function hasWholeTextContainment(left, right) {
  const normalizedLeft = normalizeText(left);
  const normalizedRight = normalizeText(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }
  if (containsCjk(normalizedLeft) || containsCjk(normalizedRight)) {
    return (
      normalizedLeft.includes(normalizedRight) ||
      normalizedRight.includes(normalizedLeft)
    );
  }
  const leftTokens = tokens(normalizedLeft);
  const rightTokens = tokens(normalizedRight);
  return (
    hasTokenSequence(leftTokens, rightTokens) ||
    hasTokenSequence(rightTokens, leftTokens)
  );
}

function needsExactShortTextMatch(input) {
  const core = normalizeCoreTitle(input);
  if (!core || containsCjk(core)) {
    return false;
  }
  const coreTokens = tokens(core);
  return coreTokens.length <= 2 && core.length <= 8;
}

function hasExtraneousTitleWords(queryTitle, candidateTitle) {
  const queryCore = normalizeCoreTitle(queryTitle);
  const candidateCore = normalizeCoreTitle(candidateTitle);
  if (!queryCore || !candidateCore || queryCore === candidateCore) {
    return false;
  }
  const queryTokens = tokens(queryCore);
  const candidateTokens = tokens(candidateCore);
  if (!queryTokens.length || queryTokens.length > 2) {
    return false;
  }
  if (!hasTokenSequence(candidateTokens, queryTokens)) {
    return false;
  }
  if (candidateTokens.length <= queryTokens.length) {
    return false;
  }

  const allowedExtraTokens = new Set([
    ...collectFeaturedArtistHints(queryTitle),
    ...extractBracketedTitleSegments(queryTitle).flatMap((segment) =>
      tokens(segment),
    ),
  ]);
  for (const token of candidateTokens) {
    if (queryTokens.includes(token)) {
      continue;
    }
    if (allowedExtraTokens.has(token)) {
      continue;
    }
    if (collectVersionHints(token).length) {
      continue;
    }
    return true;
  }
  return false;
}

function collectComparableArtistNames(input) {
  const names = getArtistNames(input);
  for (const alias of extractParentheticalAliases(input)) {
    names.push(alias);
  }
  return names;
}

function getBestArtistOverlap(trackArtist, candidateArtist) {
  const queryNames = collectComparableArtistNames(
    getSpotifyPrimaryArtist(trackArtist) || trackArtist,
  ).map(normalizeArtistText);
  const candidateNames =
    collectComparableArtistNames(candidateArtist).map(normalizeArtistText);
  let best = 0;
  for (const queryName of queryNames) {
    for (const candidateName of candidateNames) {
      if (!queryName || !candidateName) {
        continue;
      }
      if (queryName === candidateName) {
        return 1;
      }
      const overlap = overlapRatio(tokens(queryName), tokens(candidateName));
      best = Math.max(best, overlap);
      if (
        !needsExactShortTextMatch(queryName) &&
        (hasWholeTextContainment(queryName, candidateName) ||
          hasWholeTextContainment(candidateName, queryName))
      ) {
        best = Math.max(best, 0.82);
      }
    }
  }
  return best;
}

function artistNamesLookRelated(trackArtist, candidateArtist) {
  const overlap = getBestArtistOverlap(trackArtist, candidateArtist);
  const trackPrimary = normalizeArtistText(
    getSpotifyPrimaryArtist(trackArtist),
  );
  const candidateTokens = tokens(normalizeArtistText(candidateArtist));
  if (
    trackPrimary &&
    needsExactShortTextMatch(trackPrimary) &&
    candidateTokens.includes(trackPrimary)
  ) {
    return true;
  }

  if (overlap >= 0.42) {
    const candidatePrimary = normalizeArtistText(
      getPrimaryArtistName(candidateArtist),
    );
    if (needsExactShortTextMatch(trackPrimary)) {
      return (
        trackPrimary === candidatePrimary ||
        overlap >= 0.88 ||
        (trackPrimary &&
          candidatePrimary &&
          (candidatePrimary.includes(trackPrimary) ||
            trackPrimary.includes(candidatePrimary)) &&
          overlap >= 0.75)
      );
    }
    return true;
  }
  const candidatePrimary = normalizeArtistText(
    getPrimaryArtistName(candidateArtist),
  );
  if (!trackPrimary || !candidatePrimary) {
    return false;
  }
  if (trackPrimary === candidatePrimary) {
    return true;
  }
  if (needsExactShortTextMatch(trackPrimary)) {
    return trackPrimary === candidatePrimary;
  }
  return (
    hasWholeTextContainment(trackPrimary, candidatePrimary) ||
    hasWholeTextContainment(candidatePrimary, trackPrimary)
  );
}

// ---- DesktopBridge/src/lyrics/parts/01b-candidate-matching.js ----
function compareCandidateMatchQuality(track, left, right) {
  const leftTitle = String(left?.title || left?.candidateTitle || "").trim();
  const rightTitle = String(right?.title || right?.candidateTitle || "").trim();
  const leftArtist = String(left?.artist || left?.candidateArtist || "").trim();
  const rightArtist = String(
    right?.artist || right?.candidateArtist || "",
  ).trim();
  const leftArtistOverlap = getBestArtistOverlap(track.artist, leftArtist);
  const rightArtistOverlap = getBestArtistOverlap(track.artist, rightArtist);
  const leftFeatPenalty = hasMissingFeaturedArtistHints(track.title, leftTitle)
    ? 1
    : 0;
  const rightFeatPenalty = hasMissingFeaturedArtistHints(
    track.title,
    rightTitle,
  )
    ? 1
    : 0;
  if (leftFeatPenalty !== rightFeatPenalty) {
    return leftFeatPenalty - rightFeatPenalty;
  }
  if (rightArtistOverlap !== leftArtistOverlap) {
    return rightArtistOverlap - leftArtistOverlap;
  }
  const leftExtraneous = hasExtraneousTitleWords(track.title, leftTitle);
  const rightExtraneous = hasExtraneousTitleWords(track.title, rightTitle);
  if (leftExtraneous !== rightExtraneous) {
    return leftExtraneous ? 1 : -1;
  }
  return Number(right?.score || 0) - Number(left?.score || 0);
}

function scoreDurationBonus(track, title, artist, durationMs = 0) {
  if (!(track.durationMs > 0 && durationMs > 0)) {
    return 0;
  }
  const delta = Math.abs(durationMs - track.durationMs);
  const artistRel = getBestArtistOverlap(track.artist, artist);
  const titleCore = normalizeCoreTitle(track.title);
  const candidateCore = normalizeCoreTitle(title);
  const titleExact = Boolean(
    titleCore && candidateCore && titleCore === candidateCore,
  );
  const shortTitle = needsExactShortTextMatch(titleCore);

  if (artistRel < 0.42) {
    if (shortTitle) {
      return delta > 8_000 ? -3.5 : -2;
    }
    if (titleExact && delta <= 2_500) {
      return 0.35;
    }
    if (delta > 12_000) {
      return -1.5;
    }
    return 0;
  }

  if (delta < 1200) {
    return 2.5;
  }
  if (delta < 4000) {
    return 1.5;
  }
  if (delta > 12_000) {
    return -2.5;
  }
  if (delta > 20_000) {
    return -2.5;
  }
  return 0;
}

function normalizeCoreTitle(input) {
  const noBracketed = String(input || "").replace(
    /\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g,
    " ",
  );
  return normalizeText(noBracketed);
}

function extractBracketedTitleSegments(input) {
  const raw = String(input || "");
  if (!raw) {
    return [];
  }
  const matches = raw.match(/\(([^)]*)\)|\[([^\]]*)\]|\{([^}]*)\}/g) || [];
  const segments = [];
  const seen = new Set();
  for (const match of matches) {
    const inner = String(match || "")
      .slice(1, -1)
      .trim();
    const normalized = normalizeText(inner);
    if (!normalized || normalized.length < 2) {
      continue;
    }
    // Ignore pure version labels like "(Live)" / "(Remix)".
    const versionHints = collectVersionHints(normalized);
    if (versionHints.length && tokens(normalized).length <= 3) {
      continue;
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    segments.push(normalized);
  }
  return segments;
}

function collectVersionHints(input) {
  const normalized = normalizeText(input);
  const hintTokens = tokens(normalized);
  return VERSION_HINTS.filter((hint) => {
    const hintParts = tokens(hint);
    if (hintParts.length === 1) {
      return hintTokens.includes(hintParts[0]);
    }
    return normalized.includes(hint);
  });
}

function collectFeaturedArtistHints(input) {
  const raw = String(input || "");
  const hints = [];
  const seen = new Set();
  const addHint = (value) => {
    for (const token of tokens(value)) {
      if (token.length < 3 || seen.has(token)) {
        continue;
      }
      if (/^(?:ft|feat|featuring)$/.test(token)) {
        continue;
      }
      if (collectVersionHints(token).length) {
        continue;
      }
      seen.add(token);
      hints.push(token);
    }
  };
  const addHintSegment = (value) => {
    for (const piece of String(value || "").split(
      /\s*(?:&|,|\+|\/|、|与|和|x|×)\s*/i,
    )) {
      addHint(piece);
    }
  };

  for (const segment of extractBracketedTitleSegments(raw)) {
    if (!collectVersionHints(segment).length) {
      addHintSegment(segment);
    }
  }

  const featuringMatch = raw.match(
    /\b(?:ft\.?|feat\.?|featuring)\s+([^)\]\[]+)/i,
  );
  if (featuringMatch?.[1]) {
    addHintSegment(featuringMatch[1]);
  }

  return hints;
}

function mergeNativePlaybackArtist(nativeArtist, catalogArtist) {
  const native = String(nativeArtist || "").trim();
  const catalog = String(catalogArtist || "").trim();
  if (!catalog) {
    return native;
  }
  if (!native) {
    return catalog;
  }
  const nativeNorm = native.toLowerCase();
  const catalogNorm = catalog.toLowerCase();
  if (catalogNorm === nativeNorm) {
    return catalog;
  }
  if (catalogNorm.includes(nativeNorm) && catalog.length >= native.length) {
    return catalog;
  }
  const nativeSeparators = (native.match(/[,;&]/g) || []).length;
  const catalogSeparators = (catalog.match(/[,;&]/g) || []).length;
  if (catalogSeparators > nativeSeparators) {
    return catalog;
  }
  return native;
}

/** Overlay Spotify catalog fields onto a playback track for lyrics matching only. */
function applySpotifyCatalogOverlay(playbackTrack, catalog) {
  if (!playbackTrack || typeof playbackTrack !== "object") {
    return playbackTrack;
  }
  if (!catalog || typeof catalog !== "object") {
    return { ...playbackTrack };
  }
  const overlay = { ...playbackTrack };
  const catalogDurationMs = Number(catalog.durationMs || 0);
  if (catalogDurationMs > 0) {
    overlay.durationMs = catalogDurationMs;
  }
  const catalogArtist = String(catalog.artist || "").trim();
  if (catalogArtist) {
    overlay.artist = mergeNativePlaybackArtist(
      playbackTrack.artist,
      catalogArtist,
    );
  }
  const catalogAlbum = String(catalog.album || "").trim();
  if (catalogAlbum && !String(overlay.album || "").trim()) {
    overlay.album = catalogAlbum;
  }
  return overlay;
}

function hasMissingFeaturedArtistHints(queryTitle, candidateTitle) {
  const queryHints = collectFeaturedArtistHints(queryTitle);
  if (!queryHints.length) {
    return false;
  }
  const candidateNorm = normalizeMatchText(candidateTitle);
  return queryHints.some((hint) => !candidateNorm.includes(hint));
}

function hasExtraneousFeaturedArtistHints(queryTitle, candidateTitle) {
  const candidateHints = collectFeaturedArtistHints(candidateTitle);
  if (!candidateHints.length) {
    return false;
  }
  const queryHints = collectFeaturedArtistHints(queryTitle);
  const queryNorm = normalizeMatchText(
    `${queryTitle} ${queryHints.join(" ")} ${normalizeCoreTitle(queryTitle)}`,
  );
  return candidateHints.some(
    (hint) => !queryHints.includes(hint) && !queryNorm.includes(hint),
  );
}

function collectLanguageVariantHints(input) {
  const normalized = normalizeText(input);
  return LANGUAGE_VARIANT_HINTS.filter((hint) => normalized.includes(hint));
}

function hasLanguageVariantMismatch(queryTitle, candidateTitle) {
  const queryHints = collectLanguageVariantHints(queryTitle);
  const candidateHints = collectLanguageVariantHints(candidateTitle);
  // Only treat as a mismatch when both sides explicitly declare a variant and disagree.
  if (!queryHints.length || !candidateHints.length) {
    return false;
  }
  return !queryHints.some((hint) => candidateHints.includes(hint));
}

function extractLyricVariantProbeText(lyricText) {
  const text = String(lyricText || "");
  if (!text.trim()) {
    return "";
  }
  const titleTag = text.match(/\[ti:([^\]]+)\]/i)?.[1] || "";
  const firstTimedLine = (
    text
      .split(/\r?\n/)
      .find((line) => /\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/.test(line)) || ""
  )
    .replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g, "")
    .trim();
  return `${titleTag} ${firstTimedLine}`.trim();
}

function shouldRejectLyricVariant(trackTitle, candidateTitle, lyricText) {
  const probeTitle =
    `${candidateTitle || ""} ${extractLyricVariantProbeText(lyricText)}`.trim();
  if (!probeTitle) {
    return false;
  }
  return hasLanguageVariantMismatch(trackTitle, probeTitle);
}

function extractPlainTextFromParsedLyrics(lyrics) {
  if (!Array.isArray(lyrics) || !lyrics.length) {
    return "";
  }
  const parts = [];
  for (const line of lyrics) {
    if (typeof line?.text === "string" && line.text.trim()) {
      parts.push(line.text);
      continue;
    }
    if (Array.isArray(line?.syllables)) {
      parts.push(
        line.syllables.map((part) => String(part?.text || "")).join(""),
      );
      continue;
    }
    if (Array.isArray(line?.words)) {
      parts.push(line.words.map((word) => String(word?.text || "")).join(""));
    }
  }
  return parts.join(" ");
}

const LYRIC_PRODUCER_CREDIT_TOKENS = new Set([
  "score",
  "megatone",
  "iluvjulia",
  "hitman",
  "bang",
  "kali",
  "jbach",
  "jake",
  "torrey",
  "supreme",
  "boi",
  "anthony",
  "watts",
  "amanda",
  "ibanez",
  "leven",
  "kidddo",
  "ai",
  "prod",
  "production",
  "composer",
  "composed",
  "written",
  "writer",
  "writers",
  "songwriter",
  "songwriters",
  "lyricist",
  "lyricists",
  "arranger",
  "arranged",
  "producer",
  "producers",
  "engineer",
  "master",
  "mix",
  "mixed",
  "recorded",
  "verse",
  "chorus",
  "bridge",
  "hook",
  "source",
  "music",
  "lyrics",
  "copyright",
  "publishing",
  "unknown",
]);

function isLikelyProducerCreditToken(token) {
  const value = String(token || "").toLowerCase();
  if (!value || value.length < 2) {
    return true;
  }
  if (/\d/.test(value)) {
    return true;
  }
  if (LYRIC_PRODUCER_CREDIT_TOKENS.has(value)) {
    return true;
  }
  return false;
}

function isLikelyProducerCreditName(nameNorm) {
  const nameTokens = tokens(nameNorm);
  if (!nameTokens.length) {
    return true;
  }
  if (nameTokens.some((token) => /\d/.test(token))) {
    return true;
  }
  return nameTokens.every((token) => isLikelyProducerCreditToken(token));
}

function collectAllowedFeatTokens(track) {
  const queryTitle = String(track?.title || "");
  const allowed = new Set();
  const primaryNorm = normalizeMatchText(
    getSpotifyPrimaryArtist(track?.artist || ""),
  );
  for (const token of tokens(primaryNorm)) {
    if (token.length >= 3) {
      allowed.add(token);
    }
  }
  for (const token of tokens(normalizeCoreTitle(queryTitle))) {
    if (token.length >= 3) {
      allowed.add(token);
    }
  }
  for (const hint of collectFeaturedArtistHints(queryTitle)) {
    allowed.add(hint);
    for (const token of tokens(hint)) {
      if (token.length >= 3) {
        allowed.add(token);
      }
    }
  }
  return allowed;
}

function lyricPerformerCreditMatchesAllowed(
  nameNorm,
  queryHints,
  allowedTokens,
) {
  if (
    queryHints.some(
      (hint) => nameNorm.includes(hint) || hint.includes(nameNorm),
    )
  ) {
    return true;
  }
  const nameTokens = tokens(nameNorm).filter(
    (token) => !isLikelyProducerCreditToken(token),
  );
  if (!nameTokens.length) {
    return true;
  }
  const significantAllowed = [...allowedTokens].filter(
    (token) => token.length >= 4,
  );
  if (
    nameTokens.every((token) =>
      significantAllowed.some(
        (allowed) => token.includes(allowed) || allowed.includes(token),
      ),
    )
  ) {
    return true;
  }
  return nameTokens.some((token) =>
    queryHints.some((hint) => token.includes(hint) || hint.includes(token)),
  );
}

function looksLikePerformerCreditName(nameNorm) {
  const nameTokens = tokens(nameNorm).filter(
    (token) => !isLikelyProducerCreditToken(token),
  );
  return (
    nameTokens.length >= 2 ||
    (nameTokens.length === 1 && nameTokens[0].length >= 7)
  );
}

function collectVocalCreditsFromSlashLine(value) {
  const scratch = [];
  normalizeCreditNameParts(value, scratch);
  const vocalNames = [];
  for (const part of scratch) {
    const nameNorm = normalizeMatchText(part);
    if (nameNorm.length < 4) {
      continue;
    }
    if (isLikelyProducerCreditName(nameNorm)) {
      break;
    }
    vocalNames.push(nameNorm);
  }
  return vocalNames;
}

/** Featured vocalists only — not the full composer/producer tail on 曲： lines. */
function collectLyricFeaturedPerformerNames(plainText) {
  const names = [];
  const seen = new Set();
  const addName = (nameNorm) => {
    if (nameNorm.length < 4 || seen.has(nameNorm)) {
      return;
    }
    seen.add(nameNorm);
    names.push(nameNorm);
  };
  const addFeatPhrase = (value) => {
    const scratch = [];
    normalizeCreditNameParts(value, scratch);
    for (const part of scratch) {
      addName(normalizeMatchText(part));
    }
  };
  const source = String(plainText || "");
  for (const match of source.matchAll(
    /\b(?:feat\.?|featuring|ft\.)\s+([^|\n\[\]]+)/gi,
  )) {
    addFeatPhrase(match[1]);
  }
  for (const match of source.matchAll(/(?:曲|唱)[:：]\s*([^\n]+)/gi)) {
    for (const nameNorm of collectVocalCreditsFromSlashLine(match[1])) {
      addName(nameNorm);
    }
  }
  return names;
}

function countRequestedFeaturedArtistGroups(queryTitle) {
  const raw = String(queryTitle || "");
  let maxGroups = 0;
  const featMatch = raw.match(/\b(?:ft\.?|feat\.?|featuring)\s+([^)\]]+)/i);
  if (featMatch?.[1]) {
    const parts = featMatch[1]
      .split(/\s*(?:&|,|\+|\/|、|与|和|x|×)\s*/i)
      .map((part) => part.trim())
      .filter((part) => tokens(part).length);
    maxGroups = Math.max(maxGroups, parts.length);
  }
  for (const segment of extractBracketedTitleSegments(raw)) {
    if (collectVersionHints(segment).length) {
      continue;
    }
    const featBody = segment
      .replace(/^(?:ft\.?|feat\.?|featuring)\s+/i, "")
      .trim();
    const hasFeatMarker =
      /^(?:ft\.?|feat\.?|featuring)\b/i.test(segment) || /[&＆,]/.test(segment);
    if (!hasFeatMarker) {
      continue;
    }
    const parts = featBody
      .split(/\s*(?:&|,|\+|\/|、|与|和|x|×)\s*/i)
      .map((part) => part.trim())
      .filter((part) => tokens(part).length);
    maxGroups = Math.max(
      maxGroups,
      parts.length || (tokens(featBody).length ? 1 : 0),
    );
  }
  if (maxGroups > 0) {
    return maxGroups;
  }
  return collectFeaturedArtistHints(raw).length > 0 ? 1 : 0;
}

function hasExtraneousFeatTokensInLyricBody(track, norm) {
  const queryTitle = String(track?.title || "");
  const queryHints = collectFeaturedArtistHints(queryTitle);
  if (!queryHints.length || !norm) {
    return false;
  }
  const queryNorm = normalizeText(queryTitle);
  if (/\bmash[\s-]?up\b/.test(norm) && !/\bmash[\s-]?up\b/.test(queryNorm)) {
    return true;
  }
  for (const hint of queryHints) {
    if (hint.length >= 6 && norm.includes(hint)) {
      return false;
    }
  }
  const longFeatHints = queryHints.filter(
    (hint) => /^[a-z0-9]+$/.test(hint) && hint.length >= 6,
  );
  if (!longFeatHints.length) {
    return false;
  }
  const opening = norm.slice(0, 800);
  if (longFeatHints.some((hint) => opening.includes(hint))) {
    return false;
  }
  const latinChars = (opening.match(/[a-z]/gi) || []).length;
  const latinRatio = latinChars / Math.max(opening.length, 1);
  return latinRatio < 0.1;
}

function hasExtraneousLyricPerformerCredits(track, plainText) {
  const queryTitle = String(track?.title || "");
  const queryHints = collectFeaturedArtistHints(queryTitle);
  if (!queryHints.length) {
    return false;
  }
  const allowedTokens = collectAllowedFeatTokens(track);
  for (const nameNorm of collectLyricFeaturedPerformerNames(plainText)) {
    if (isLikelyProducerCreditName(nameNorm)) {
      continue;
    }
    if (!looksLikePerformerCreditName(nameNorm)) {
      continue;
    }
    if (
      lyricPerformerCreditMatchesAllowed(nameNorm, queryHints, allowedTokens)
    ) {
      continue;
    }
    return true;
  }
  const norm = normalizeMatchText(plainText);
  for (const match of norm.matchAll(
    /\b(?:feat\.?|featuring|ft\.)\s+([a-z0-9][a-z0-9\s.'-]{2,48})/gi,
  )) {
    const featNorm = normalizeMatchText(match[1]);
    if (isLikelyProducerCreditName(featNorm)) {
      continue;
    }
    if (!looksLikePerformerCreditName(featNorm)) {
      continue;
    }
    if (
      lyricPerformerCreditMatchesAllowed(featNorm, queryHints, allowedTokens)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function hasChineseLyricCreditLabel(text) {
  return /(?:作词|作曲|编曲|监制|制作人|词|曲|唱|编)\s*[：:]/u.test(
    String(text || ""),
  );
}

function hasProductionRoleLabel(text) {
  const raw = String(text || "").trim();
  if (!raw || /^[\[(（]/.test(raw)) {
    return false;
  }
  if (hasChineseLyricCreditLabel(raw)) {
    return true;
  }
  return /^[A-Za-z][A-Za-z0-9\s/&.'@-]{0,56}[：:]\s*\S/u.test(raw);
}

function getMedianSyllableDurationMs(line) {
  const syllables = Array.isArray(line?.syllables) ? line.syllables : [];
  const durations = syllables
    .map((entry) =>
      Math.max(0, Number(entry?.endTime || 0) - Number(entry?.startTime || 0)),
    )
    .filter((duration) => duration > 0)
    .sort((left, right) => left - right);
  if (!durations.length) {
    return 0;
  }
  return durations[Math.floor(durations.length / 2)];
}

function isTimingCompressedPreludeLine(line) {
  const lineStart = Number(line?.lineStartTime || 0);
  const lineEnd = Number(line?.lineEndTime || 0);
  if (lineEnd > 90_000) {
    return false;
  }
  const lineDuration = Math.max(0, lineEnd - lineStart);
  const medianSyllableDuration = getMedianSyllableDurationMs(line);
  if (!medianSyllableDuration) {
    return lineDuration > 0 && lineDuration <= 300;
  }
  return lineDuration <= 300 && medianSyllableDuration <= 120;
}

function isLikelyCreditOrMetadataLine(text, track = null) {
  const raw = String(text || "").trim();
  if (!raw) {
    return true;
  }
  if (isLikelyMetadataLineText(raw, track || {})) {
    return true;
  }
  const norm = normalizeMatchText(raw);
  if (!norm) {
    return true;
  }
  if (hasChineseLyricCreditLabel(raw)) {
    return true;
  }
  if ((norm.match(/\//g) || []).length >= 2) {
    return true;
  }
  const substantiveTokens = tokens(norm).filter((token) => token.length >= 3);
  if (
    substantiveTokens.length >= 4 &&
    substantiveTokens.filter((token) => isLikelyProducerCreditToken(token))
      .length /
      substantiveTokens.length >=
      0.45
  ) {
    return true;
  }
  return false;
}

function isLikelyLeadingMetadataHeaderLine(text, track) {
  if (isLikelyMetadataLineText(text, track)) {
    return true;
  }
  const raw = String(text || "").trim();
  if (!raw) {
    return true;
  }
  const lineNorm = normalizeText(text);
  const lineNormTight = lineNorm.replace(/\s+/g, "");
  const trackCore = normalizeCoreTitle(track?.title || "");
  const trackArtist = normalizeText(track?.artist || "");
  const trackCoreTight = trackCore.replace(/\s+/g, "");
  const containsTrackTitle =
    Boolean(trackCore) &&
    (lineNorm.includes(trackCore) ||
      (trackCoreTight && lineNormTight.includes(trackCoreTight)));
  if (containsTrackTitle) {
    return false;
  }
  const trackArtistCandidates = [
    trackArtist,
    normalizeText(getSpotifyPrimaryArtist(track?.artist || "")),
    normalizeText(
      String(track?.artist || "")
        .replace(/\s*\([^)]*\)/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    ),
  ].filter(Boolean);
  const containsTrackArtist = trackArtistCandidates.some((candidate) => {
    const candidateTight = candidate.replace(/\s+/g, "");
    return (
      lineNorm.includes(candidate) ||
      (candidateTight && lineNormTight.includes(candidateTight))
    );
  });
  if (containsTrackArtist && /[/／、|]/.test(raw)) {
    return true;
  }
  return false;
}

// ---- DesktopBridge/src/lyrics/parts/01c-fingerprinting.js ----
function buildLyricsContentFingerprint(lyrics, track = null) {
  const payload = Array.isArray(lyrics) ? lyrics : [];
  const trackShape = track && typeof track === "object" ? track : {};
  const vocalLines = stripLeadingMetadataLines(payload, trackShape);
  const parts = [];
  for (const line of vocalLines) {
    const rawText = getLineText(line);
    const text = normalizeMatchText(rawText);
    if (text.length < 4) {
      continue;
    }
    if (isLikelyCreditOrMetadataLine(rawText, trackShape)) {
      continue;
    }
    parts.push(text);
    if (parts.length >= 12) {
      break;
    }
  }
  return parts.join("|");
}

function lyricsContentFingerprintsMatch(
  referenceFingerprint,
  candidateFingerprint,
) {
  const reference = String(referenceFingerprint || "");
  const candidate = String(candidateFingerprint || "");
  if (!reference || !candidate) {
    return true;
  }
  if (reference === candidate) {
    return true;
  }
  const shorter = reference.length <= candidate.length ? reference : candidate;
  const longer = reference.length <= candidate.length ? candidate : reference;
  if (shorter.length >= 28 && longer.includes(shorter)) {
    return true;
  }
  const referenceLines = reference.split("|").filter(Boolean);
  const candidateLines = candidate.split("|").filter(Boolean);
  if (!referenceLines.length || !candidateLines.length) {
    return false;
  }
  const compareCount = Math.min(
    referenceLines.length,
    candidateLines.length,
    10,
  );
  let matchedLines = 0;
  for (let index = 0; index < compareCount; index += 1) {
    const left = referenceLines[index];
    const right = candidateLines[index];
    if (
      left === right ||
      (left.length >= 8 && right.includes(left)) ||
      (right.length >= 8 && left.includes(right))
    ) {
      matchedLines += 1;
    }
  }
  if (matchedLines / compareCount >= 0.55) {
    return true;
  }

  const referenceBody = reference.replace(/\|/g, "");
  const candidateBody = candidate.replace(/\|/g, "");
  if (referenceBody.length < 16 || candidateBody.length < 16) {
    return false;
  }
  const shorterBody =
    referenceBody.length <= candidateBody.length
      ? referenceBody
      : candidateBody;
  const longerBody =
    referenceBody.length <= candidateBody.length
      ? candidateBody
      : referenceBody;
  if (shorterBody.length >= 20 && longerBody.includes(shorterBody)) {
    return true;
  }
  for (let index = 0; index <= shorterBody.length - 10; index += 3) {
    const slice = shorterBody.slice(index, index + 10);
    if (slice.length >= 8 && longerBody.includes(slice)) {
      return true;
    }
  }
  return false;
}

function trackNeedsFeaturedVariantVerification(track) {
  return collectFeaturedArtistHints(String(track?.title || "")).length > 0;
}

/** QQ cross-check only when catalogs commonly attach the wrong remix/mashup chart. */
function shouldUseQqFingerprintForSpicyVariantCheck(track) {
  if (!trackNeedsFeaturedVariantVerification(track)) {
    return false;
  }
  const title = String(track?.title || "");
  const normalizedTitle = normalizeText(title);
  if (
    /\bmash[\s-]?up\b/.test(normalizedTitle) ||
    /\bremix\b/.test(normalizedTitle)
  ) {
    return true;
  }
  const hints = collectFeaturedArtistHints(title);
  const core = normalizeCoreTitle(title);
  const hasRomanFeat = hints.some(
    (hint) => /^[a-z0-9]+$/.test(hint) && hint.length >= 6,
  );
  return (
    hasRomanFeat && core.length > 0 && core.length <= 16 && !containsCjk(core)
  );
}

function extractSpicyPayloadMetadata(payload) {
  const titles = [];
  const TITLE_KEY =
    /^(?:title|tracktitle|trackname|worktitle|songtitle|displaytitle|originaltitle|versiontitle|subtitle|albumtitle)$/i;
  const walk = (node, depth = 0, inMetadata = false) => {
    if (depth > 6 || !node || typeof node !== "object") {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, depth + 1, inMetadata);
      }
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const keyText = String(key || "");
      const nextMetadata =
        inMetadata || /ttml|metadata|upload|attribution|info/i.test(keyText);
      if (typeof value === "string") {
        const safe = value.trim();
        if (safe.length < 4 || safe.length > 160) {
          continue;
        }
        if (
          TITLE_KEY.test(keyText) ||
          (nextMetadata && /title/i.test(keyText))
        ) {
          titles.push(safe);
        }
        continue;
      }
      if (value && typeof value === "object") {
        walk(value, depth + 1, nextMetadata);
      }
    }
  };
  walk(payload, 0, false);
  const deduped = [];
  const seen = new Set();
  for (const title of titles) {
    const norm = normalizeMatchText(title);
    if (!norm || seen.has(norm)) {
      continue;
    }
    seen.add(norm);
    deduped.push(title);
  }
  return { titles: deduped };
}

function extractSpicyLeadVocalPlainText(lyrics) {
  if (!Array.isArray(lyrics) || !lyrics.length) {
    return "";
  }
  const lines = [];
  for (const line of lyrics) {
    if (!Array.isArray(line?.syllables) || !line.syllables.length) {
      continue;
    }
    lines.push(line.syllables.map((part) => String(part?.text || "")).join(""));
  }
  return lines.join("\n");
}

function spicyDeclaredTitlesMatchPlayback(track, declaredTitles = []) {
  if (!Array.isArray(declaredTitles) || !declaredTitles.length) {
    return null;
  }
  let sawRelevantTitle = false;
  for (const declaredTitle of declaredTitles) {
    const safeTitle = String(declaredTitle || "").trim();
    if (safeTitle.length < 4) {
      continue;
    }
    if (!titleCoreMatchesQuery(track, safeTitle)) {
      continue;
    }
    sawRelevantTitle = true;
    if (
      !hasMissingFeaturedArtistHints(track?.title || "", safeTitle) &&
      !hasExtraneousFeaturedArtistHints(track?.title || "", safeTitle) &&
      !hasLanguageVariantMismatch(track?.title || "", safeTitle)
    ) {
      return true;
    }
  }
  if (!sawRelevantTitle) {
    return null;
  }
  return false;
}

function spicyLeadDuetDensitySuggestsExtraFeat(track, lyrics) {
  if (countRequestedFeaturedArtistGroups(track?.title || "") !== 1) {
    return false;
  }
  const leadLines = (Array.isArray(lyrics) ? lyrics : []).filter(
    (line) => Array.isArray(line?.syllables) && line.syllables.length,
  );
  if (leadLines.length < 24) {
    return false;
  }
  const oppositeAlignedCount = leadLines.filter(
    (line) => line?.oppositeAligned,
  ).length;
  const backgroundHeavyCount = leadLines.filter(
    (line) =>
      Array.isArray(line?.backgroundSyllables) &&
      line.backgroundSyllables.length >= 4,
  ).length;
  const oppositeRatio = oppositeAlignedCount / leadLines.length;
  const backgroundRatio = backgroundHeavyCount / leadLines.length;
  return (
    oppositeAlignedCount >= 8 && oppositeRatio >= 0.2 && backgroundRatio >= 0.16
  );
}

function spicyFeaturedVariantLyricsMismatch(
  track,
  lyrics,
  spicyMetadata = {},
  variantOptions = {},
) {
  const queryTitle = String(track?.title || "");
  const hints = collectFeaturedArtistHints(queryTitle);
  if (!hints.length) {
    return false;
  }

  const qqReferenceFingerprint = String(
    variantOptions.qqReferenceFingerprint || "",
  );
  if (
    qqReferenceFingerprint &&
    shouldUseQqFingerprintForSpicyVariantCheck(track)
  ) {
    const spicyFingerprint = buildLyricsContentFingerprint(lyrics, track);
    return !lyricsContentFingerprintsMatch(
      qqReferenceFingerprint,
      spicyFingerprint,
    );
  }

  const declaredTitles = Array.isArray(spicyMetadata?.titles)
    ? spicyMetadata.titles
    : [];
  const declaredTitleMatch = spicyDeclaredTitlesMatchPlayback(
    track,
    declaredTitles,
  );
  if (declaredTitleMatch === true) {
    return false;
  }
  if (declaredTitleMatch === false) {
    return true;
  }

  const leadPlain = extractSpicyLeadVocalPlainText(lyrics);
  const leadNorm = normalizeMatchText(leadPlain);
  if (!leadNorm) {
    return false;
  }

  if (hasExtraneousFeatTokensInLyricBody(track, leadNorm)) {
    return true;
  }
  if (shouldRejectLyricVariant(queryTitle, queryTitle, leadPlain)) {
    return true;
  }
  if (spicyLeadDuetDensitySuggestsExtraFeat(track, lyrics)) {
    return true;
  }
  return false;
}

/**
 * True when the playback title requests a feat./bracket variant but lyric text
 * looks like the base album version (e.g. Korean CRAZY vs English PinkPantheress remix)
 * or credits reference a different feat lineup (e.g. mashup with Dashaun Wesley).
 */
function featuredVariantLyricsMismatch(track, lyrics, options = {}) {
  if (String(options?.source || "").toLowerCase() === "spicy") {
    return spicyFeaturedVariantLyricsMismatch(
      track,
      lyrics,
      {
        titles: options.spicyDeclaredTitles || [],
      },
      {
        qqReferenceFingerprint: options.qqReferenceFingerprint || "",
      },
    );
  }

  const queryTitle = String(track?.title || "");
  const hints = collectFeaturedArtistHints(queryTitle);
  if (!hints.length) {
    return false;
  }
  const plain = extractPlainTextFromParsedLyrics(lyrics);
  const norm = normalizeMatchText(plain);
  if (hasExtraneousLyricPerformerCredits(track, plain)) {
    return true;
  }
  if (hasExtraneousFeatTokensInLyricBody(track, norm)) {
    return true;
  }
  if (!norm) {
    return false;
  }
  if (shouldRejectLyricVariant(queryTitle, queryTitle, plain)) {
    return true;
  }
  if (hints.some((hint) => norm.includes(hint))) {
    return false;
  }
  const longRomanHints = hints.filter(
    (hint) => /^[a-z0-9]+$/.test(hint) && hint.length >= 6,
  );
  if (!longRomanHints.length) {
    return false;
  }
  const opening = norm.slice(0, 500);
  if (longRomanHints.some((hint) => opening.includes(hint))) {
    return false;
  }
  const latinChars = (opening.match(/[a-z]/gi) || []).length;
  const latinRatio = latinChars / Math.max(opening.length, 1);
  return latinRatio < 0.1;
}

// ---- DesktopBridge/src/lyrics/parts/01d-lyrics-parsing.js ----
function stripSearchDecoratorsFromTitle(input) {
  // Spotify passes the full display title (including feat. credits in brackets).
  // Only strip production/lyricist credits — never feat./ft. segments, since those
  // are not duplicated in the primary-artist field from native playback metadata.
  return String(input || "")
    .replace(
      /\s*[\(\[]\s*(?:prod(?:\.|uced)?\s*by|produced\s*by|arr(?:\.|anged)?\s*by|arranger|composed\s*by|written\s*by|lyrics?\s*by|lyricist)\b[^)\]]*[\)\]]/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

/** Native/Spotify playback supplies primary artist only; featured artists live in title. */
function getSpotifyPrimaryArtist(input) {
  const primary = getPrimaryArtistName(input);
  const primaryTokens = tokens(normalizeArtistText(primary));
  const fromIndex = primaryTokens.indexOf("from");
  if (fromIndex > 0) {
    return primaryTokens.slice(0, fromIndex).join(" ");
  }
  return primary;
}

function buildQueryVariants(track) {
  const rawTitle = String(track?.title || "").trim();
  const rawArtist = String(track?.artist || "").trim();
  const titleBase = stripSearchDecoratorsFromTitle(rawTitle) || rawTitle;
  const artistPrimary = getSpotifyPrimaryArtist(rawArtist);
  const artistSearchFriendly = rawArtist
    .replace(/[,:;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const titleFeatHints = collectFeaturedArtistHints(rawTitle);
  const titleBracketHints = extractBracketedTitleSegments(rawTitle);

  const variants = [
    `${rawTitle} ${artistPrimary}`.trim(),
    `${rawTitle} ${rawArtist}`.trim(),
    `${rawTitle} ${artistSearchFriendly}`.trim(),
    `${titleBase || rawTitle} ${artistPrimary}`.trim(),
    `${rawTitle} ${track?.album || ""} ${artistPrimary}`.trim(),
    rawTitle,
    `${titleBase || rawTitle} ${rawArtist}`.trim(),
  ];
  for (const hint of titleFeatHints) {
    variants.push(`${titleBase || rawTitle} ${hint} ${artistPrimary}`.trim());
  }
  for (const segment of titleBracketHints) {
    if (!collectVersionHints(segment).length) {
      variants.push(
        `${titleBase || rawTitle} ${segment} ${artistPrimary}`.trim(),
      );
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const value of variants) {
    const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(value);
  }
  return deduped;
}

function containsCjk(input) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
    String(input || ""),
  );
}

function isAmbiguousTopMatch(ranked) {
  const top = ranked[0];
  const second = ranked[1];
  if (!top || !second) {
    return false;
  }
  return (
    top.score < MATCH_CONFIDENCE_SCORE &&
    top.score - second.score < AMBIGUITY_MAX_SCORE_GAP
  );
}

function parseTimestampMs(raw) {
  const value = String(raw || "").trim();
  const matched = value.match(/^(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!matched) {
    return Number.NaN;
  }
  const [, min, sec, fraction = "0"] = matched;
  const millis =
    fraction.length === 1
      ? Number(fraction) * 100
      : fraction.length === 2
        ? Number(fraction) * 10
        : Number(String(fraction).slice(0, 3));
  return Number(min) * 60_000 + Number(sec) * 1_000 + millis;
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeSyllables(syllables, lineStartTime, lineEndTime) {
  const safeLineEnd = Math.max(lineStartTime + 250, lineEndTime);
  const next = [];
  for (const part of syllables) {
    if (!part || typeof part.text !== "string" || !part.text.trim()) {
      continue;
    }
    const start = Number.isFinite(part.startTime)
      ? clampNumber(part.startTime, lineStartTime, safeLineEnd)
      : lineStartTime;
    const end = Number.isFinite(part.endTime)
      ? clampNumber(part.endTime, start, safeLineEnd)
      : safeLineEnd;
    const safeEnd = end > start ? end : Math.min(safeLineEnd, start + 120);
    const hasIsPartOfWord = typeof part.isPartOfWord === "boolean";
    next.push({
      text: part.text,
      startTime: start,
      endTime: safeEnd,
      ...(hasIsPartOfWord ? { isPartOfWord: part.isPartOfWord } : {}),
    });
  }
  return next;
}

function parseEnhancedLrcSyllables(text, lineStartTime, lineEndTime) {
  const tagRegex = /<(\d{1,2}:\d{2}(?:\.\d{1,3})?)>/g;
  const tags = [];
  let match;
  while ((match = tagRegex.exec(text)) !== null) {
    const timeMs = parseTimestampMs(match[1]);
    if (!Number.isFinite(timeMs)) {
      continue;
    }
    tags.push({
      timeMs,
      tokenEnd: tagRegex.lastIndex,
      tokenStart: match.index,
    });
  }
  if (!tags.length) {
    return [];
  }

  const syllables = [];
  const leadingChunk = text.slice(0, tags[0].tokenStart);
  const shouldMergeLeadingChunk =
    leadingChunk.trim() &&
    tags[0].timeMs - lineStartTime <= LEADING_PREFIX_MERGE_THRESHOLD_MS;
  if (leadingChunk.trim() && !shouldMergeLeadingChunk) {
    syllables.push({
      text: leadingChunk,
      startTime: lineStartTime,
      endTime: tags[0].timeMs,
    });
  }

  for (let index = 0; index < tags.length; index += 1) {
    const current = tags[index];
    const next = tags[index + 1];
    const baseChunk = text.slice(
      current.tokenEnd,
      next ? next.tokenStart : text.length,
    );
    const chunk =
      index === 0 && shouldMergeLeadingChunk
        ? `${leadingChunk}${baseChunk}`
        : baseChunk;
    if (!chunk.trim()) {
      continue;
    }
    const endTime = next ? next.timeMs : lineEndTime;
    syllables.push({
      text: chunk,
      startTime: current.timeMs,
      endTime,
    });
  }

  return normalizeSyllables(syllables, lineStartTime, lineEndTime);
}

function getGraphemeCount(text) {
  const value = String(text || "");
  const Segmenter = Intl?.Segmenter;
  if (Segmenter) {
    return [
      ...new Segmenter(undefined, { granularity: "grapheme" }).segment(value),
    ].length;
  }
  return [...value].length;
}

const QRC_ACCENT_VOWEL_FRAGMENT_RE = /^[áéíóúüñÁÉÍÓÚÜÑ]$/u;
const QRC_POST_ACCENT_LETTER_RE = /^[a-zñ]$/i;
const QRC_POST_ACCENT_WORD_BREAK_RE =
  /^(?:y|o|a|e|de|el|la|los|las|en|un|una|que|por|con|se|es|al|del|yo|tu|no|si)$/i;

function isQrcAccentVowelFragment(text) {
  const trimmed = String(text || "").trim();
  return (
    trimmed.length > 0 &&
    getGraphemeCount(trimmed) === 1 &&
    QRC_ACCENT_VOWEL_FRAGMENT_RE.test(trimmed)
  );
}

function endsWithQrcAccentVowel(text) {
  return QRC_ACCENT_VOWEL_FRAGMENT_RE.test(
    String(text || "")
      .replace(/\s+$/u, "")
      .slice(-1),
  );
}

function isQrcPostAccentLetterFragment(text) {
  const trimmed = String(text || "").trim();
  return (
    trimmed.length > 0 &&
    getGraphemeCount(trimmed) === 1 &&
    QRC_POST_ACCENT_LETTER_RE.test(trimmed)
  );
}

function hasSingleLetterBeforeAccentVowel(text) {
  const core = String(text || "").replace(/\s+$/u, "");
  return /(?:^|\s)([a-zñ])[áéíóúüñÁÉÍÓÚÜÑ]$/u.test(core);
}

function isQrcPostAccentSyllableTail(text, maxLength) {
  const trimmed = String(text || "").trim();
  if (!trimmed || QRC_POST_ACCENT_WORD_BREAK_RE.test(trimmed)) {
    return false;
  }
  if (isQrcPostAccentLetterFragment(trimmed)) {
    return true;
  }
  return /^[a-zñ]+$/i.test(trimmed) && trimmed.length <= maxLength;
}

function hasQrcAccentWordBoundary(text) {
  // QQ QRC puts a space after a completed accented word token (e.g. "é ").
  return /[áéíóúüñÁÉÍÓÚÜÑ]\s+$/u.test(String(text || ""));
}

function shouldMergeQrcPostAccentTail(previousText, fragmentText) {
  const previous = String(previousText || "");
  if (hasQrcAccentWordBoundary(previous)) {
    return false;
  }
  const previousCore = previous.replace(/\s+$/u, "");
  if (!endsWithQrcAccentVowel(previousCore)) {
    return false;
  }
  const trimmed = String(fragmentText || "").trim();
  if (isQrcPostAccentLetterFragment(trimmed)) {
    return true;
  }
  if (hasSingleLetterBeforeAccentVowel(previousCore)) {
    return isQrcPostAccentSyllableTail(trimmed, 8);
  }
  return isQrcPostAccentSyllableTail(trimmed, 4);
}

function appendQrcSyllableText(previousText, fragmentText) {
  const previous = String(previousText || "");
  const fragment = String(fragmentText || "");
  const previousCore = previous.replace(/\s+$/u, "");
  const fragmentCore = fragment.trim();
  const trailingSpace = /\s$/u.test(fragment)
    ? " "
    : /\s$/u.test(previous)
      ? " "
      : "";
  return `${previousCore}${fragmentCore}${trailingSpace}`;
}

function mergeQrcTimedTextSyllables(syllables) {
  if (!Array.isArray(syllables) || syllables.length <= 1) {
    return syllables;
  }

  const merged = [];
  for (const syllable of syllables) {
    const previous = merged[merged.length - 1];
    const rawText = String(syllable?.text || "");
    const trimmed = rawText.trim();
    if (!previous || !trimmed) {
      merged.push({ ...syllable, text: rawText });
      continue;
    }

    const shouldMergeAccent = isQrcAccentVowelFragment(trimmed);
    const shouldMergePostAccent = shouldMergeQrcPostAccentTail(
      previous.text,
      rawText,
    );

    if (!shouldMergeAccent && !shouldMergePostAccent) {
      merged.push({ ...syllable, text: rawText });
      continue;
    }

    previous.text = appendQrcSyllableText(previous.text, rawText);
    previous.endTime = syllable.endTime;
  }

  return merged;
}

function appendQrcWhitespaceOnlyChunk(syllables, chunk) {
  const whitespace = String(chunk || "");
  if (!whitespace.trim() && whitespace && syllables.length) {
    syllables[syllables.length - 1].text += whitespace;
    return true;
  }
  return false;
}

function parseQrcSyllables(text, lineStartTime, lineEndTime) {
  const tokenRegex = /\((\d+),(\d+)(?:,[^)]*)?\)/g;
  const tokens = [];
  let match;
  while ((match = tokenRegex.exec(text)) !== null) {
    tokens.push({
      rawStart: Number(match[1]),
      rawDuration: Number(match[2]),
      tokenEnd: tokenRegex.lastIndex,
      tokenStart: match.index,
    });
  }
  if (!tokens.length) {
    return [];
  }

  const lineDuration = Math.max(1, lineEndTime - lineStartTime);
  const isRelative = tokens.every(
    (token) => token.rawStart <= lineDuration * 2,
  );
  const resolveStart = (rawStart) =>
    isRelative ? lineStartTime + rawStart : rawStart;

  const syllables = [];
  const leadingChunk = text.slice(0, tokens[0].tokenStart);
  const firstTokenStart = resolveStart(tokens[0].rawStart);
  const trailingTokenMode =
    leadingChunk.trim() &&
    Math.abs(firstTokenStart - lineStartTime) <=
      LEADING_PREFIX_MERGE_THRESHOLD_MS;

  if (trailingTokenMode) {
    // Some QQ-QRC lines place timing tokens after each word segment.
    for (let index = 0; index < tokens.length; index += 1) {
      const current = tokens[index];
      const next = tokens[index + 1];
      const chunk =
        index === 0
          ? leadingChunk
          : text.slice(tokens[index - 1].tokenEnd, current.tokenStart);
      if (appendQrcWhitespaceOnlyChunk(syllables, chunk)) {
        continue;
      }
      if (!chunk.trim()) {
        continue;
      }
      const startTime = resolveStart(current.rawStart);
      const endTime =
        current.rawDuration > 0
          ? startTime + current.rawDuration
          : next
            ? resolveStart(next.rawStart)
            : lineEndTime;
      syllables.push({
        text: chunk,
        startTime,
        endTime,
      });
    }
  } else {
    if (leadingChunk.trim()) {
      syllables.push({
        text: leadingChunk,
        startTime: lineStartTime,
        endTime: firstTokenStart,
      });
    }

    for (let index = 0; index < tokens.length; index += 1) {
      const current = tokens[index];
      const next = tokens[index + 1];
      const chunk = text.slice(
        current.tokenEnd,
        next ? next.tokenStart : text.length,
      );
      if (appendQrcWhitespaceOnlyChunk(syllables, chunk)) {
        continue;
      }
      if (!chunk.trim()) {
        continue;
      }
      const startTime = resolveStart(current.rawStart);
      const endTime =
        current.rawDuration > 0
          ? startTime + current.rawDuration
          : next
            ? resolveStart(next.rawStart)
            : lineEndTime;
      syllables.push({
        text: chunk,
        startTime,
        endTime,
      });
    }
  }

  return normalizeSyllables(
    mergeQrcTimedTextSyllables(syllables),
    lineStartTime,
    lineEndTime,
  );
}

// ---- DesktopBridge/src/lyrics/parts/01e-utilities.js ----
function stripTimingMarkup(text) {
  return String(text || "")
    .replace(/<\d{1,2}:\d{2}(?:\.\d{1,3})?>/g, "")
    .replace(/\(\d+,\d+(?:,[^)]*)?\)/g, "")
    .trim();
}

function parseSyllablesWithFallback(lineText, lineStart, lineEnd) {
  const enhanced = parseEnhancedLrcSyllables(lineText, lineStart, lineEnd);
  if (enhanced.length) {
    return enhanced;
  }

  const qrc = parseQrcSyllables(lineText, lineStart, lineEnd);
  if (qrc.length) {
    return qrc;
  }

  const plainText = stripTimingMarkup(lineText);
  const words = (plainText || "...").split(/\s+/).filter(Boolean);
  const durationPerWord = Math.max(
    120,
    (lineEnd - lineStart) / Math.max(1, words.length),
  );
  const syllables = words.map((word, wordIndex) => {
    const start = lineStart + wordIndex * durationPerWord;
    const end = Math.min(lineEnd, start + durationPerWord);
    return {
      text: `${word}${wordIndex < words.length - 1 ? " " : ""}`,
      startTime: start,
      endTime: end,
    };
  });
  return normalizeSyllables(syllables, lineStart, lineEnd);
}

function decodeXmlEntities(input) {
  return String(input || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizeQrcLyricContentText(input) {
  return (
    String(input || "")
      // Some QQ payloads keep escaped newlines inside LyricContent.
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\n")
      // Preserve literal quotes that were escaped inside the attribute payload.
      .replace(/\\"/g, '"')
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trim()
  );
}

function extractLyricContentFromLyricTag(tag) {
  const source = String(tag || "");
  if (!source) {
    return "";
  }

  // Fast path for common well-formed tags.
  const greedyTerminalMatch = source.match(
    /\bLyricContent="([\s\S]*)"\s*\/?>$/i,
  );
  if (greedyTerminalMatch?.[1]) {
    return normalizeQrcLyricContentText(
      decodeXmlEntities(greedyTerminalMatch[1]),
    );
  }

  // Fallback scanner for malformed tags where LyricContent includes escaped quotes.
  const anchor = source.search(/\bLyricContent="/i);
  if (anchor < 0) {
    return "";
  }
  const valueStart = source.indexOf('"', anchor);
  if (valueStart < 0) {
    return "";
  }
  let end = valueStart + 1;
  while (end < source.length) {
    if (source[end] === '"' && source[end - 1] !== "\\") {
      break;
    }
    end += 1;
  }
  if (end <= valueStart || end >= source.length) {
    return "";
  }
  return normalizeQrcLyricContentText(
    decodeXmlEntities(source.slice(valueStart + 1, end)),
  );
}

function extractKaraokeBody(rawText) {
  const raw = String(rawText || "").trim();
  if (!raw) {
    return "";
  }
  // QQ QRC payloads come in a few XML shapes:
  // - `<Lyric_1 ... />` (self-closing)
  // - `<Lyric_1 ...></Lyric_1>` (explicit close)
  // - `<Lyric_1 ...>` (rare; sometimes formatted strangely)
  // Extract LyricContent from any opening Lyric_N tag.
  const lyricTagMatches =
    raw.match(/<Lyric_\d+\b[^>]*\/?>/g)?.filter((tag) => !/^<\//.test(tag)) ||
    [];
  if (lyricTagMatches.length) {
    const lyricContents = lyricTagMatches
      .map((tag) => {
        if (/\bIsTitle\s*=\s*"1"/i.test(tag)) {
          return "";
        }
        return extractLyricContentFromLyricTag(tag);
      })
      .filter(Boolean);
    if (lyricContents.length) {
      return lyricContents.join("\n").trim();
    }
  }
  const cdataMatch = raw.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdataMatch?.[1]) {
    return cdataMatch[1].trim();
  }
  const attrMatch = raw.match(/LyricContent="([\s\S]*?)"/);
  if (attrMatch?.[1]) {
    return normalizeQrcLyricContentText(decodeXmlEntities(attrMatch[1]));
  }
  if (/^\s*\[(\d{2}:\d{2}|\d+,\d+)\]/m.test(raw)) {
    return raw;
  }
  const decoded = decodeXmlEntities(raw);
  const firstBracket = decoded.search(/\[(\d{2}:\d{2}|\d+,\d+)\]/);
  if (firstBracket >= 0) {
    return decoded.slice(firstBracket).trim();
  }
  return decoded.trim();
}

function hasQqTitleFlag(input) {
  const text = String(input || "");
  return /\bIsTitle\b\s*(?:[:=]\s*"?1"?|\b)/i.test(text);
}

function parseLrc(lrc) {
  const lines = String(lrc || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed = [];

  for (const line of lines) {
    if (hasQqTitleFlag(line)) {
      continue;
    }

    const lrcMatch = line.match(/\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\](.*)$/);
    if (lrcMatch) {
      const [, min, sec, fraction = "0", text] = lrcMatch;
      if (hasQqTitleFlag(text)) {
        continue;
      }
      const millis =
        fraction.length === 2
          ? Number(fraction) * 10
          : Number(String(fraction).padEnd(3, "0"));
      const timeMs = Number(min) * 60_000 + Number(sec) * 1_000 + millis;
      parsed.push({
        timeMs,
        text: String(text || "").trim(),
        explicitEndTime: null,
      });
      continue;
    }

    const qrcMatch = line.match(/\[(\d+),(\d+)\](.*)$/);
    if (qrcMatch) {
      const [, rawStart, rawDuration, text] = qrcMatch;
      if (hasQqTitleFlag(text)) {
        continue;
      }
      const timeMs = Number(rawStart);
      const explicitEndTime = timeMs + Math.max(0, Number(rawDuration));
      parsed.push({ timeMs, text: String(text || "").trim(), explicitEndTime });
    }
  }

  return parsed
    .map((entry, index) => {
      const next = parsed[index + 1];
      const hasExplicitLineEnd =
        Number.isFinite(entry.explicitEndTime) &&
        entry.explicitEndTime > entry.timeMs;
      const lineEnd = hasExplicitLineEnd
        ? entry.explicitEndTime
        : next
          ? next.timeMs
          : entry.timeMs + 2_000;
      const syllables = parseSyllablesWithFallback(
        entry.text,
        entry.timeMs,
        lineEnd,
      );
      if (!syllables.length) {
        return null;
      }
      const lastSyllableEnd = syllables[syllables.length - 1]?.endTime;
      const hasInlineSyllableTiming =
        /\(\d+,\d+/.test(entry.text) ||
        /<\d{1,2}:\d{2}(?:\.\d{1,3})?>/.test(entry.text);
      let resolvedLineEnd = lineEnd;
      if (Number.isFinite(lastSyllableEnd) && lastSyllableEnd > entry.timeMs) {
        if (!hasExplicitLineEnd) {
          resolvedLineEnd = lastSyllableEnd;
        } else if (hasInlineSyllableTiming && lastSyllableEnd < lineEnd) {
          // QQ QRC often pads line duration to the next line while syllable
          // tokens end earlier — keep the highlight window tight to the words.
          resolvedLineEnd = lastSyllableEnd;
        }
      }
      return {
        lineStartTime: entry.timeMs,
        lineEndTime: resolvedLineEnd,
        syllables,
      };
    })
    .filter(Boolean);
}

function cleanNeteaseSpacing(rawText) {
  return String(rawText || "")
    .replace(/\s+((?:\(\d+,\d+,-?\d+\)\s*)*)([,.?!:*\]})])/g, "$1$2")
    .replace(/([(\[{])((?:\s*\(\d+,\d+,-?\d+\))*)\s+/g, "$1$2");
}

function ensureNeteaseCensorshipSpacing(syllables) {
  if (!Array.isArray(syllables) || syllables.length <= 1) {
    return syllables;
  }
  const censorGlyph = /^[*＊•·]+$/;
  for (let index = 1; index < syllables.length; index += 1) {
    const previous = syllables[index - 1];
    const current = syllables[index];
    if (!previous || !current) {
      continue;
    }
    const previousText = String(previous.text || "");
    const currentTrim = String(current.text || "").trim();
    const previousTrim = previousText.trim();
    if (
      !currentTrim ||
      !previousTrim ||
      !censorGlyph.test(currentTrim) ||
      censorGlyph.test(previousTrim) ||
      /\s$/.test(previousText)
    ) {
      continue;
    }
    previous.text = `${previousTrim} `;
  }
  return syllables;
}

function mergeConsecutiveCensorSyllables(syllables) {
  if (!Array.isArray(syllables) || syllables.length <= 1) {
    return syllables;
  }
  const censorGlyph = /^[*＊•·]+$/;
  const merged = [];
  for (const syllable of syllables) {
    const previous = merged[merged.length - 1];
    const trimmed = String(syllable?.text || "").trim();
    const previousTrim = String(previous?.text || "").trim();
    if (
      previous &&
      censorGlyph.test(trimmed) &&
      censorGlyph.test(previousTrim)
    ) {
      const previousText = String(previous.text || "").replace(/\s+$/u, "");
      const trailingSpace = /\s$/u.test(syllable.text) ? " " : "";
      previous.text = `${previousText}${trimmed}${trailingSpace}`;
      previous.endTime = syllable.endTime;
      continue;
    }
    merged.push({ ...syllable });
  }
  return merged;
}

function parseNeteaseYrc(yrc) {
  const lines = String(yrc || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed = [];

  for (const line of lines) {
    const lineMatch = line.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!lineMatch) {
      continue;
    }
    const [, rawLineStart, rawLineDuration, body = ""] = lineMatch;
    const lineStartTime = Number(rawLineStart);
    const lineDuration = Math.max(0, Number(rawLineDuration));
    const lineEndTime = lineStartTime + lineDuration;
    const syllables = [];
    const segmentPattern = /\((\d+),(\d+),-?\d+\)([^()]*)/g;
    let segmentMatch = segmentPattern.exec(body);
    while (segmentMatch) {
      const [, rawStart, rawDuration, rawText = ""] = segmentMatch;
      const absoluteStart = Number(rawStart);
      const duration = Math.max(0, Number(rawDuration));
      const text = String(rawText || "");
      if (Number.isFinite(absoluteStart) && text.length > 0) {
        const startTime =
          absoluteStart < lineStartTime && absoluteStart <= lineDuration
            ? lineStartTime + absoluteStart
            : absoluteStart;
        syllables.push({
          text,
          startTime,
          endTime: startTime + duration,
        });
      }
      segmentMatch = segmentPattern.exec(body);
    }

    if (!syllables.length) {
      const plainText = body.replace(/\(\d+,\d+,-?\d+\)/g, "").trim();
      if (!plainText) {
        continue;
      }
      parsed.push({
        lineStartTime,
        lineEndTime: Math.max(lineStartTime + 250, lineEndTime),
        syllables: normalizeSyllables(
          [
            {
              text: plainText,
              startTime: lineStartTime,
              endTime: Math.max(lineStartTime + 250, lineEndTime),
            },
          ],
          lineStartTime,
          Math.max(lineStartTime + 250, lineEndTime),
        ),
      });
      continue;
    }

    const normalized = normalizeSyllables(
      mergeConsecutiveCensorSyllables(
        ensureNeteaseCensorshipSpacing(syllables),
      ),
      lineStartTime,
      Math.max(lineEndTime, syllables[syllables.length - 1].endTime),
    );
    if (!normalized.length) {
      continue;
    }
    parsed.push({
      lineStartTime: normalized[0].startTime,
      lineEndTime: Math.max(
        Math.max(lineStartTime + 250, lineEndTime),
        normalized[normalized.length - 1].endTime,
      ),
      syllables: normalized,
    });
  }

  return parsed.filter((line) => line?.syllables?.length);
}

function decodeKugouKrc(encodedContent) {
  const zlib = mobileZlib;
  const bytes = Buffer.from(String(encodedContent || "").trim(), "base64");
  if (bytes.length <= 4) {
    return "";
  }
  const encrypted = bytes.subarray(4);
  const decrypted = Buffer.alloc(encrypted.length);
  for (let index = 0; index < encrypted.length; index += 1) {
    decrypted[index] = encrypted[index] ^ KUGOU_KRC_XOR_KEY[index % 16];
  }
  return zlib
    .inflateSync(decrypted)
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .replace(/\0/g, "");
}

function preserveKugouKrcSpacing(syllables) {
  if (!Array.isArray(syllables) || syllables.length === 0) {
    return syllables;
  }

  const preserved = [];
  let leadingWhitespace = "";
  for (const syllable of syllables) {
    const text = String(syllable?.text || "");
    // KRC commonly times Korean one syllable at a time and represents word
    // boundaries as standalone space segments, which normalization drops.
    if (/^\s+$/u.test(text)) {
      const previous = preserved[preserved.length - 1];
      if (previous) {
        previous.text += text;
        previous.endTime = Math.max(previous.endTime, syllable.endTime);
      } else {
        leadingWhitespace += text;
      }
      continue;
    }

    preserved.push({
      ...syllable,
      text: `${leadingWhitespace}${text}`,
    });
    leadingWhitespace = "";
  }

  if (leadingWhitespace && preserved.length > 0) {
    preserved[preserved.length - 1].text += leadingWhitespace;
  }
  return preserved;
}

function parseKugouKrc(krc) {
  const lines = String(krc || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed = [];

  for (const line of lines) {
    const lineMatch = line.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!lineMatch) {
      continue;
    }
    const [, rawLineStart, rawLineDuration, body = ""] = lineMatch;
    const lineStartTime = Number(rawLineStart);
    const lineDuration = Math.max(0, Number(rawLineDuration));
    const lineEndTime = lineStartTime + lineDuration;
    const syllables = [];
    const segmentPattern = /<(\d+),(\d+),-?\d+>([^<]*)/g;
    let segmentMatch = segmentPattern.exec(body);
    while (segmentMatch) {
      const [, rawStart, rawDuration, rawText = ""] = segmentMatch;
      const relativeStart = Number(rawStart);
      const duration = Math.max(0, Number(rawDuration));
      const text = String(rawText || "");
      if (Number.isFinite(relativeStart) && text.length > 0) {
        const startTime = lineStartTime + relativeStart;
        syllables.push({
          text,
          startTime,
          endTime: startTime + duration,
        });
      }
      segmentMatch = segmentPattern.exec(body);
    }

    if (!syllables.length) {
      const plainText = body.replace(/<\d+,\d+,-?\d+>/g, "").trim();
      if (!plainText) {
        continue;
      }
      parsed.push({
        lineStartTime,
        lineEndTime: Math.max(lineStartTime + 250, lineEndTime),
        syllables: normalizeSyllables(
          [
            {
              text: plainText,
              startTime: lineStartTime,
              endTime: Math.max(lineStartTime + 250, lineEndTime),
            },
          ],
          lineStartTime,
          Math.max(lineStartTime + 250, lineEndTime),
        ),
      });
      continue;
    }

    const normalized = normalizeSyllables(
      mergeConsecutiveCensorSyllables(
        ensureNeteaseCensorshipSpacing(
          preserveKugouKrcSpacing(syllables),
        ),
      ),
      lineStartTime,
      Math.max(lineEndTime, syllables[syllables.length - 1].endTime),
    );
    if (!normalized.length) {
      continue;
    }
    parsed.push({
      lineStartTime: normalized[0].startTime,
      lineEndTime: Math.max(
        lineStartTime + 250,
        normalized[normalized.length - 1].endTime,
      ),
      syllables: normalized,
    });
  }

  return parsed.filter((line) => line?.syllables?.length);
}

function coerceFiniteNumber(value, fallback = NaN) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

/** Spicy Lyrics payloads use seconds; Spicetify applies `ConvertTime(t) => t * 1000` before playback. */
function spicyApiSecondsToMs(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric * 1000 : NaN;
}

function parseOptionalBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === 1 || value === "1") {
    return true;
  }
  if (value === 0 || value === "0") {
    return false;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return undefined;
}

function readSpicyIsPartOfWord(item = {}) {
  return parseOptionalBoolean(
    item?.IsPartOfWord ?? item?.isPartOfWord ?? item?.SyllableWithinWord,
  );
}

function isSpicyVocalEntry(item = {}) {
  return (
    String(item?.Type ?? item?.type ?? "")
      .trim()
      .toLowerCase() === "vocal"
  );
}

function collectSpicyTagTokens(rawValue, outputSet) {
  if (!rawValue) {
    return;
  }
  if (Array.isArray(rawValue)) {
    for (const part of rawValue) {
      collectSpicyTagTokens(part, outputSet);
    }
    return;
  }
  if (typeof rawValue === "object") {
    for (const value of Object.values(rawValue)) {
      collectSpicyTagTokens(value, outputSet);
    }
    return;
  }

  const text = String(rawValue || "")
    .trim()
    .toLowerCase();
  if (!text) {
    return;
  }
  outputSet.add(text);
  const compact = text.replace(/[\s_-]+/g, "");
  if (compact) {
    outputSet.add(compact);
  }

  const splitParts = text
    .split(/[\s,;|/]+/g)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const part of splitParts) {
    outputSet.add(part);
    outputSet.add(part.replace(/[\s_-]+/g, ""));
  }
}

function isSpicyBackgroundTaggedVocal(item = {}) {
  const explicitBackground = parseOptionalBoolean(
    item?.IsBackground ??
      item?.isBackground ??
      item?.BackgroundTag ??
      item?.backgroundTag,
  );
  if (explicitBackground === true) {
    return true;
  }

  const roleHint = String(
    item?.Role ??
      item?.role ??
      item?.VocalType ??
      item?.vocalType ??
      item?.Kind ??
      item?.kind ??
      "",
  )
    .trim()
    .toLowerCase();
  if (roleHint.includes("background") || roleHint.includes("backing")) {
    return true;
  }

  const tagTokens = new Set();
  collectSpicyTagTokens(item?.Tag, tagTokens);
  collectSpicyTagTokens(item?.Tags, tagTokens);
  collectSpicyTagTokens(item?.tag, tagTokens);
  collectSpicyTagTokens(item?.tags, tagTokens);
  collectSpicyTagTokens(item?.LineTag, tagTokens);
  collectSpicyTagTokens(item?.LineTags, tagTokens);

  return (
    tagTokens.has("background") ||
    tagTokens.has("bg") ||
    tagTokens.has("backing") ||
    tagTokens.has("backgroundvocal") ||
    tagTokens.has("backgroundvocals")
  );
}

// Spicy often encodes word gaps with zero-width or thin spaces instead of ASCII space.
const SPICY_MULTI_WORD_SEPARATOR_RE =
  /[\s\u00a0\u2009\u202f\u200b-\u200d\u2060\ufeff\r\n]+/u;

function normalizeSpicySyllableText(text) {
  return String(text || "")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, " ")
    .replace(/[\u00a0\u2009\u202f]/g, " ")
    .replace(/\r?\n/g, " ");
}

function tokenizeSpicyMultiWordSyllableText(text) {
  return String(text || "")
    .trim()
    .split(SPICY_MULTI_WORD_SEPARATOR_RE)
    .filter(Boolean);
}

const ATTACHED_OPENING_QUOTE_TOKEN_RE = /^([A-Za-z0-9]+)([""«"\u201c][^\s]*)$/;

function splitTokenAtAttachedOpeningQuote(token) {
  const value = String(token || "");
  const trimmed = value.trim();
  if (!trimmed) {
    return [value];
  }
  const match = trimmed.match(ATTACHED_OPENING_QUOTE_TOKEN_RE);
  if (!match) {
    return [value];
  }
  const start = value.indexOf(trimmed);
  const end = start + trimmed.length;
  const lead = value.slice(0, start);
  const trail = value.slice(end);
  return [`${lead}${match[1]}${trail}`, `${lead}${match[2]}${trail}`];
}

function expandSpicyAttachedQuoteSyllables(syllables) {
  if (!Array.isArray(syllables) || !syllables.length) {
    return syllables;
  }

  const expanded = [];
  for (const part of syllables) {
    const tokens = splitTokenAtAttachedOpeningQuote(part?.text);
    if (!tokens || tokens.length <= 1) {
      expanded.push(part);
      continue;
    }

    const startTime = Number(part?.startTime) || 0;
    const endTime = Number(part?.endTime) || startTime + 220;
    const slotMs = Math.max(1, endTime - startTime) / tokens.length;
    for (let index = 0; index < tokens.length; index += 1) {
      const isLast = index >= tokens.length - 1;
      expanded.push({
        ...part,
        text: tokens[index],
        startTime: startTime + slotMs * index,
        endTime: isLast ? endTime : startTime + slotMs * (index + 1),
        ...(isLast && typeof part?.isPartOfWord === "boolean"
          ? { isPartOfWord: part.isPartOfWord }
          : { isPartOfWord: true }),
      });
    }
  }

  return expanded.length ? expanded : syllables;
}

function shouldExpandSpicyMultiWordSyllable(text) {
  const words = tokenizeSpicyMultiWordSyllableText(text);
  if (words.length <= 1) {
    return false;
  }
  return !words.some((word) => isLikelySyllableFragmentWord(word));
}

function splitSpicyMultiWordSyllableText(rawText) {
  const value = String(rawText || "");
  const words = tokenizeSpicyMultiWordSyllableText(value).flatMap(
    splitTokenAtAttachedOpeningQuote,
  );
  if (words.length <= 1) {
    return null;
  }
  const leadPrefix = value.slice(0, value.search(/\S/));
  const trailSuffix = value.slice(value.trimEnd().length);
  return words.map((word, index) => {
    let text = word;
    if (index === 0 && leadPrefix) {
      text = `${leadPrefix}${word}`;
    }
    if (index < words.length - 1) {
      text += " ";
    } else if (trailSuffix) {
      text += trailSuffix;
    }
    return text;
  });
}

function isLikelySyllableFragmentWord(word) {
  const trimmed = String(word || "").trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.length === 1 && /^[a-zA-Z]$/.test(trimmed)) {
    return !/^[aAiI]$/.test(trimmed);
  }
  return false;
}

function isStandaloneWordToken(text) {
  return /^(a|i|an|am|as|at|be|by|do|go|he|if|in|is|it|me|my|no|of|oh|ok|on|or|ow|so|to|up|us|we)$/i.test(
    String(text || "").trim(),
  );
}

function isSyllableWordContinuation(leftText, rightText) {
  const left = String(leftText || "").trim();
  const right = String(rightText || "").trim();
  if (!left || !right) {
    return false;
  }
  if (
    /\s$/.test(String(leftText || "")) ||
    /^\s/.test(String(rightText || ""))
  ) {
    return false;
  }
  if (isStandaloneWordToken(left) || isStandaloneWordToken(right)) {
    return false;
  }
  if (left.length !== 1 || !/^[a-z]$/.test(left)) {
    return false;
  }
  return /^[a-z]/.test(right);
}

function inferMissingSyllableWordFlags(syllables) {
  if (!Array.isArray(syllables)) {
    return;
  }
  for (let index = 0; index < syllables.length; index += 1) {
    const current = syllables[index];
    const next = syllables[index + 1];
    if (typeof current?.isPartOfWord === "boolean") {
      continue;
    }
    current.isPartOfWord =
      next && isSyllableWordContinuation(current.text, next.text);
  }
}

function expandSpicyMultiWordTimedSyllables(syllables) {
  if (!Array.isArray(syllables) || !syllables.length) {
    return syllables;
  }

  const expanded = [];
  for (const part of syllables) {
    if (!part || typeof part.text !== "string") {
      continue;
    }

    const rawText = part.text;
    if (!shouldExpandSpicyMultiWordSyllable(rawText)) {
      expanded.push(part);
      continue;
    }

    const wordTexts = splitSpicyMultiWordSyllableText(rawText);
    if (!wordTexts?.length) {
      expanded.push(part);
      continue;
    }
    const startTime = Number(part.startTime) || 0;
    const endTime = Number(part.endTime) || startTime + 220;
    const slotMs = Math.max(1, endTime - startTime) / wordTexts.length;

    for (let index = 0; index < wordTexts.length; index += 1) {
      const isLast = index >= wordTexts.length - 1;
      const syllableStart = startTime + slotMs * index;
      const syllableEnd = isLast ? endTime : startTime + slotMs * (index + 1);
      expanded.push({
        text: wordTexts[index],
        startTime: syllableStart,
        endTime: syllableEnd,
        isPartOfWord: false,
      });
    }
  }

  return expanded.length ? expanded : syllables;
}

const OPENING_DOUBLE_QUOTE_WORD_LEAD_RE = /^[""«"\u201c]([A-Za-z0-9])/;

function nextSyllableLeadsWithOpeningDoubleQuotedWord(leftText, nextText) {
  const leftTrim = String(leftText || "").trim();
  const nextTrim = String(nextText || "").trim();
  if (!leftTrim || !nextTrim || !/[A-Za-z0-9]$/.test(leftTrim)) {
    return false;
  }
  return OPENING_DOUBLE_QUOTE_WORD_LEAD_RE.test(nextTrim);
}

function nextSyllableLeadsWithAttachPunctuation(nextText) {
  const trimmed = String(nextText || "").trim();
  if (!trimmed) {
    return false;
  }
  if (/^[,;.!?)\]\}%\-–—]/.test(trimmed)) {
    return true;
  }
  // Apostrophe-led contractions (e.g. 'm, 's) stay tight with the previous syllable.
  if (/^['’‘](m|re|s|d|ll|ve|t|n|clock|all)\b/i.test(trimmed)) {
    return true;
  }
  // Standalone closing quote syllables attach to the previous word.
  if (/^['’‘"”]$/.test(trimmed)) {
    return true;
  }
  return false;
}

function shouldInsertSpaceBeforeNextSyllable(
  syllable,
  nextSyllable,
  { ignoreWordFlags = false } = {},
) {
  const text = String(syllable?.text || "");
  const nextText = String(nextSyllable?.text || "");
  if (!text || !nextText) {
    return false;
  }
  if (/\s$/.test(text) || /^\s/.test(nextText)) {
    return false;
  }
  if (nextSyllableLeadsWithOpeningDoubleQuotedWord(text, nextText)) {
    return true;
  }
  if (nextSyllableLeadsWithAttachPunctuation(nextText)) {
    return false;
  }
  if (/[(\[{]$/.test(text.trim())) {
    return false;
  }
  if (!ignoreWordFlags && typeof syllable?.isPartOfWord === "boolean") {
    if (syllable.isPartOfWord === true) {
      return false;
    }
    return true;
  }
  if (/[,.;:!?…](?:['"’”])?$/.test(text.trim())) {
    return true;
  }
  return shouldInsertSyllableBoundarySpace(text, nextText);
}

function ensureSyllableDisplaySpacing(syllables) {
  if (!Array.isArray(syllables) || syllables.length <= 1) {
    return syllables;
  }

  const hasWordFlags = syllables.some(
    (part) => typeof part?.isPartOfWord === "boolean",
  );
  const hasWordBoundaryFlags = syllables.some(
    (part) => part?.isPartOfWord === false,
  );
  const ignoreWordFlags =
    hasWordFlags &&
    !hasWordBoundaryFlags &&
    syllables.every((part) => part?.isPartOfWord === true);

  return syllables.map((syllable, index) => {
    const next = syllables[index + 1];
    if (
      !next ||
      !shouldInsertSpaceBeforeNextSyllable(syllable, next, { ignoreWordFlags })
    ) {
      return syllable;
    }
    const text = String(syllable?.text || "");
    if (/\s$/.test(text)) {
      return syllable;
    }
    return { ...syllable, text: `${text} ` };
  });
}

function readSpicyOppositeAligned(entry) {
  return Boolean(entry?.OppositeAligned ?? entry?.oppositeAligned);
}

function createSingleTextLine(text, startTime, endTime) {
  const safeStart = Math.max(0, coerceFiniteNumber(startTime, 0));
  const safeEnd = Math.max(
    safeStart + 250,
    coerceFiniteNumber(endTime, safeStart + 1_800),
  );
  return {
    lineStartTime: safeStart,
    lineEndTime: safeEnd,
    syllables: normalizeSyllables(
      [{ text: String(text || ""), startTime: safeStart, endTime: safeEnd }],
      safeStart,
      safeEnd,
    ),
  };
}

function createInterpolatedWordLine(text, startTime, endTime) {
  const safeStart = Math.max(0, coerceFiniteNumber(startTime, 0));
  const safeEnd = Math.max(
    safeStart + 250,
    coerceFiniteNumber(endTime, safeStart + 1_800),
  );
  const rawText = String(text || "").trim();
  if (!rawText) {
    return createSingleTextLine(rawText, safeStart, safeEnd);
  }

  const words = rawText.split(/\s+/).filter(Boolean);
  if (words.length <= 1) {
    return createSingleTextLine(rawText, safeStart, safeEnd);
  }

  const slotMs = (safeEnd - safeStart) / words.length;
  const rawSyllables = words.map((word, index) => {
    const syllableStart = safeStart + slotMs * index;
    const syllableEnd =
      index >= words.length - 1 ? safeEnd : safeStart + slotMs * (index + 1);
    return {
      text: `${word}${index < words.length - 1 ? " " : ""}`,
      startTime: syllableStart,
      endTime: syllableEnd,
    };
  });

  const syllables = normalizeSyllables(rawSyllables, safeStart, safeEnd);
  if (!syllables.length) {
    return createSingleTextLine(rawText, safeStart, safeEnd);
  }

  return {
    lineStartTime: safeStart,
    lineEndTime: safeEnd,
    syllables,
  };
}

function hasSpicyStaticLineTiming(lines = []) {
  return (Array.isArray(lines) ? lines : []).some((line) => {
    const startTime = Number(line?.StartTime ?? line?.Time ?? NaN);
    const endTime = Number(line?.EndTime ?? NaN);
    return Number.isFinite(startTime) || Number.isFinite(endTime);
  });
}

function readSpicyStaticLineText(line) {
  return String(line?.Text ?? line?.text ?? "").trim();
}

function parseSpicyPlainStaticLyrics(lines = []) {
  const vocals = (Array.isArray(lines) ? lines : [])
    .map((line) => ({
      text: readSpicyStaticLineText(line),
      oppositeAligned: readSpicyOppositeAligned(line),
    }))
    .filter((line) => line.text);
  if (!vocals.length) {
    return [];
  }

  return vocals.map((entry) => {
    const line = {
      lineStartTime: 0,
      lineEndTime: 0,
      syllables: [
        {
          text: entry.text,
          startTime: 0,
          endTime: 0,
        },
      ],
    };
    if (entry.oppositeAligned) {
      line.oppositeAligned = true;
    }
    return line;
  });
}

function parseSpicyStaticLyrics(lines = [], durationMs = 0) {
  void durationMs;
  return parseSpicyPlainStaticLyrics(lines);
}

function parseSpicyLineLyrics(payload = {}) {
  const content = Array.isArray(payload?.Content) ? payload.Content : [];
  const vocals = content.filter((item) => isSpicyVocalEntry(item));
  const payloadStartMs = spicyApiSecondsToMs(
    payload?.StartTime ?? payload?.Time,
  );
  const payloadEndMs = spicyApiSecondsToMs(payload?.EndTime);
  const parsed = [];
  const pendingBackgroundLines = [];

  const attachBackgroundLine = (backgroundLine) => {
    if (!backgroundLine?.syllables?.length) {
      return;
    }
    const leadLine = parsed.length ? parsed[parsed.length - 1] : null;
    if (leadLine) {
      mergeSpicyBackgroundLineIntoLeadLine(leadLine, backgroundLine);
      return;
    }
    pendingBackgroundLines.push(backgroundLine);
  };

  for (let index = 0; index < vocals.length; index += 1) {
    const line = vocals[index];
    const next = vocals[index + 1];
    const text = String(line?.Text || "").trim();
    if (!text) {
      continue;
    }
    const rawStart = line?.StartTime ?? line?.Time;
    const hasApiStart = Number.isFinite(Number(rawStart));
    const fallbackStart =
      Number.isFinite(payloadStartMs) && index === 0
        ? payloadStartMs
        : index * 2_000;
    const startTime = hasApiStart
      ? spicyApiSecondsToMs(rawStart)
      : fallbackStart;
    const safeStart = Number.isFinite(startTime) ? startTime : fallbackStart;
    const hasApiEnd = Number.isFinite(Number(line?.EndTime));
    const rawNextStart = next ? (next?.StartTime ?? next?.Time) : NaN;
    const hasNextApiStart = Number.isFinite(Number(rawNextStart));
    let endTime;
    if (hasApiEnd) {
      endTime = spicyApiSecondsToMs(line.EndTime);
    } else if (hasNextApiStart) {
      endTime = spicyApiSecondsToMs(rawNextStart);
    } else if (Number.isFinite(payloadEndMs) && payloadEndMs > safeStart) {
      endTime = payloadEndMs;
    } else {
      endTime = safeStart + 2_000;
    }

    const lineCandidate = createInterpolatedWordLine(text, safeStart, endTime);
    if (readSpicyOppositeAligned(line)) {
      lineCandidate.oppositeAligned = true;
    }
    if (isSpicyBackgroundTaggedVocal(line)) {
      attachBackgroundLine(lineCandidate);
      continue;
    }

    parsed.push(lineCandidate);
    if (pendingBackgroundLines.length) {
      while (pendingBackgroundLines.length) {
        const pending = pendingBackgroundLines.shift();
        mergeSpicyBackgroundLineIntoLeadLine(lineCandidate, pending);
      }
    }
  }

  if (pendingBackgroundLines.length) {
    if (parsed.length) {
      const fallbackLeadLine = parsed[parsed.length - 1];
      while (pendingBackgroundLines.length) {
        const pending = pendingBackgroundLines.shift();
        mergeSpicyBackgroundLineIntoLeadLine(fallbackLeadLine, pending);
      }
    } else {
      while (pendingBackgroundLines.length) {
        const pending = pendingBackgroundLines.shift();
        if (pending?.syllables?.length) {
          parsed.push(pending);
        }
      }
    }
  }

  return parsed.filter((line) => line?.syllables?.length);
}

function spicyBuildKaraokeLineFromWordSyllables(vocal, block) {
  const words = block?.Syllables;
  if (!Array.isArray(words) || !words.length) {
    return null;
  }
  const rawSyllables = [];
  for (let index = 0; index < words.length; index += 1) {
    const syllable = words[index];
    const next = words[index + 1];
    const baseText = normalizeSpicySyllableText(syllable?.Text);
    if (!baseText) {
      continue;
    }
    const isPartOfWord = readSpicyIsPartOfWord(syllable);
    const text = baseText;
    const fallbackStartSec =
      block?.StartTime ?? vocal?.Lead?.StartTime ?? vocal?.StartTime;
    const startTime = Number.isFinite(Number(syllable?.StartTime))
      ? spicyApiSecondsToMs(syllable.StartTime)
      : Number.isFinite(Number(fallbackStartSec))
        ? spicyApiSecondsToMs(fallbackStartSec)
        : 0;
    let endTime;
    if (Number.isFinite(Number(syllable?.EndTime))) {
      endTime = spicyApiSecondsToMs(syllable.EndTime);
    } else if (Number.isFinite(Number(next?.StartTime))) {
      endTime = spicyApiSecondsToMs(next.StartTime);
    } else if (Number.isFinite(Number(block?.EndTime))) {
      endTime = spicyApiSecondsToMs(block.EndTime);
    } else if (Number.isFinite(Number(vocal?.Lead?.EndTime))) {
      endTime = spicyApiSecondsToMs(vocal.Lead.EndTime);
    } else if (Number.isFinite(Number(vocal?.EndTime))) {
      endTime = spicyApiSecondsToMs(vocal.EndTime);
    } else {
      endTime = startTime + 220;
    }
    rawSyllables.push({ text, startTime, endTime, isPartOfWord });
  }
  if (!rawSyllables.length) {
    return null;
  }
  const expandedRawSyllables = expandSpicyMultiWordTimedSyllables(
    expandSpicyAttachedQuoteSyllables(rawSyllables),
  );
  inferMissingSyllableWordFlags(expandedRawSyllables);
  const lineStart = Math.max(
    0,
    Number.isFinite(Number(block?.StartTime))
      ? spicyApiSecondsToMs(block.StartTime)
      : rawSyllables[0].startTime,
  );
  const lineEnd = Math.max(
    rawSyllables[rawSyllables.length - 1].endTime,
    Number.isFinite(Number(block?.EndTime))
      ? spicyApiSecondsToMs(block.EndTime)
      : rawSyllables[rawSyllables.length - 1].endTime,
  );
  const syllables = ensureSyllableDisplaySpacing(
    normalizeSyllables(expandedRawSyllables, lineStart, lineEnd),
  );
  if (!syllables.length) {
    return null;
  }
  return {
    lineStartTime: syllables[0].startTime,
    lineEndTime: Math.max(lineEnd, syllables[syllables.length - 1].endTime),
    syllables,
    ...(readSpicyOppositeAligned(vocal) || readSpicyOppositeAligned(block)
      ? { oppositeAligned: true }
      : {}),
  };
}

function mergeSpicyBackgroundLineIntoLeadLine(leadLine, backgroundLine) {
  if (
    !leadLine ||
    !Array.isArray(backgroundLine?.syllables) ||
    !backgroundLine.syllables.length
  ) {
    return false;
  }

  const existingBackground = Array.isArray(leadLine.backgroundSyllables)
    ? leadLine.backgroundSyllables
    : [];
  const mergedRaw = [...existingBackground, ...backgroundLine.syllables]
    .map((syllable) => {
      const next = {
        text: String(syllable?.text || ""),
        startTime: Number(syllable?.startTime || 0),
        endTime: Number(syllable?.endTime || 0),
      };
      if (typeof syllable?.isPartOfWord === "boolean") {
        next.isPartOfWord = syllable.isPartOfWord;
      }
      return next;
    })
    .filter((syllable) => syllable.text.trim().length > 0);

  if (!mergedRaw.length) {
    return false;
  }

  const leadStart = Number(leadLine.lineStartTime || 0);
  const bgStart = Number(backgroundLine.lineStartTime || leadStart);
  const firstBgStart = Number(mergedRaw[0].startTime || 0);
  const mergedStart = Math.max(
    0,
    Math.min(
      Number.isFinite(leadStart) ? leadStart : firstBgStart,
      Number.isFinite(bgStart) ? bgStart : firstBgStart,
      firstBgStart,
    ),
  );

  const leadEnd = Number(leadLine.lineEndTime || mergedStart + 250);
  const bgEnd = Number(backgroundLine.lineEndTime || leadEnd);
  const lastBgEnd = Number(mergedRaw[mergedRaw.length - 1].endTime || leadEnd);
  const mergedEnd = Math.max(
    mergedStart + 250,
    Number.isFinite(leadEnd) ? leadEnd : mergedStart,
    Number.isFinite(bgEnd) ? bgEnd : mergedStart,
    Number.isFinite(lastBgEnd) ? lastBgEnd : mergedStart,
  );

  const normalizedBackground = normalizeSyllables(
    mergedRaw,
    mergedStart,
    mergedEnd,
  );
  if (!normalizedBackground.length) {
    return false;
  }

  leadLine.backgroundSyllables = normalizedBackground;
  leadLine.lineStartTime = Math.min(
    Number.isFinite(leadStart) ? leadStart : normalizedBackground[0].startTime,
    normalizedBackground[0].startTime,
  );
  leadLine.lineEndTime = Math.max(
    Number.isFinite(leadEnd)
      ? leadEnd
      : normalizedBackground[normalizedBackground.length - 1].endTime,
    normalizedBackground[normalizedBackground.length - 1].endTime,
  );
  return true;
}

function parseSpicySyllableLyrics(content = []) {
  const vocals = (Array.isArray(content) ? content : []).filter((item) =>
    isSpicyVocalEntry(item),
  );
  const parsed = [];
  const pendingBackgroundLines = [];

  const attachBackgroundLine = (backgroundLine, preferredLeadLine = null) => {
    if (!backgroundLine?.syllables?.length) {
      return;
    }
    if (preferredLeadLine) {
      mergeSpicyBackgroundLineIntoLeadLine(preferredLeadLine, backgroundLine);
      return;
    }
    const fallbackLeadLine = parsed.length ? parsed[parsed.length - 1] : null;
    if (fallbackLeadLine) {
      mergeSpicyBackgroundLineIntoLeadLine(fallbackLeadLine, backgroundLine);
      return;
    }
    pendingBackgroundLines.push(backgroundLine);
  };

  const flushPendingBackgroundLines = (leadLine) => {
    if (!leadLine || !pendingBackgroundLines.length) {
      return;
    }
    while (pendingBackgroundLines.length) {
      const pending = pendingBackgroundLines.shift();
      mergeSpicyBackgroundLineIntoLeadLine(leadLine, pending);
    }
  };

  for (const vocal of vocals) {
    const leadLine = vocal?.Lead?.Syllables?.length
      ? spicyBuildKaraokeLineFromWordSyllables(vocal, vocal.Lead)
      : null;
    const fallbackText = String(vocal?.Text || "").trim();
    const fallbackLine = fallbackText
      ? createSingleTextLine(
          fallbackText,
          Number.isFinite(Number(vocal?.StartTime))
            ? spicyApiSecondsToMs(vocal.StartTime)
            : 0,
          Number.isFinite(Number(vocal?.EndTime))
            ? spicyApiSecondsToMs(vocal.EndTime)
            : Number.isFinite(Number(vocal?.StartTime))
              ? spicyApiSecondsToMs(vocal.StartTime) + 2_000
              : 2_000,
        )
      : null;
    const lineCandidate = leadLine || fallbackLine;
    if (lineCandidate && readSpicyOppositeAligned(vocal)) {
      lineCandidate.oppositeAligned = true;
    }
    const backgroundTagged = isSpicyBackgroundTaggedVocal(vocal);

    let currentLeadLine = null;
    if (!backgroundTagged && lineCandidate) {
      parsed.push(lineCandidate);
      currentLeadLine = lineCandidate;
      flushPendingBackgroundLines(currentLeadLine);
    } else if (backgroundTagged && lineCandidate) {
      attachBackgroundLine(
        lineCandidate,
        parsed.length ? parsed[parsed.length - 1] : null,
      );
    }

    const backgrounds = vocal?.Background;
    if (!Array.isArray(backgrounds)) {
      continue;
    }
    for (const bg of backgrounds) {
      const bgLine = spicyBuildKaraokeLineFromWordSyllables(vocal, bg);
      if (bgLine) {
        attachBackgroundLine(bgLine, currentLeadLine);
      }
    }
  }

  if (pendingBackgroundLines.length) {
    if (parsed.length) {
      const fallbackLeadLine = parsed[parsed.length - 1];
      for (const pendingBackgroundLine of pendingBackgroundLines) {
        mergeSpicyBackgroundLineIntoLeadLine(
          fallbackLeadLine,
          pendingBackgroundLine,
        );
      }
    } else {
      for (const pendingBackgroundLine of pendingBackgroundLines) {
        if (pendingBackgroundLine?.syllables?.length) {
          parsed.push(pendingBackgroundLine);
        }
      }
    }
  }

  return parsed.filter((line) => line?.syllables?.length);
}

function hasSpicyTimedSyllables(block) {
  const syllables = block?.Syllables;
  if (!Array.isArray(syllables) || !syllables.length) {
    return false;
  }
  return syllables.some((syllable) => {
    if (!syllable || typeof syllable !== "object") {
      return false;
    }
    const text = String(syllable?.Text ?? syllable?.text ?? "").trim();
    return (
      text &&
      (Number.isFinite(Number(syllable?.StartTime)) ||
        Number.isFinite(Number(syllable?.EndTime)))
    );
  });
}

function hasSpicySyllableTimingContent(payload = {}) {
  const content = Array.isArray(payload?.Content) ? payload.Content : [];
  return content.some((entry) => {
    if (hasSpicyTimedSyllables(entry?.Lead)) {
      return true;
    }
    const backgrounds = Array.isArray(entry?.Background) ? entry.Background : [];
    return backgrounds.some((background) => hasSpicyTimedSyllables(background));
  });
}
function resolveSpicyPayloadType(payload = {}) {
  const typeLabel = String(payload?.Type || "")
    .trim()
    .toLowerCase();
  if (hasSpicySyllableTimingContent(payload)) {
    return "syllable";
  }
  if (typeLabel === "syllable") {
    return "syllable";
  }
  if (typeLabel === "line") {
    return "line";
  }
  if (typeLabel === "static") {
    return "static";
  }
  if (Array.isArray(payload?.Lines) && payload.Lines.length) {
    return "static";
  }
  return "";
}

function getSpicySourceLabel(payload, _durationMs = 0) {
  const payloadType = resolveSpicyPayloadType(payload);
  if (payloadType === "syllable") {
    return "spicy-lyrics-syllable";
  }
  if (payloadType === "line") {
    return "spicy-lyrics-line";
  }
  if (payloadType === "static") {
    return "spicy-lyrics-static";
  }
  return "spicy-lyrics-static";
}

function parseSpicyLyrics(payload, durationMs = 0) {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const payloadType = resolveSpicyPayloadType(payload);
  if (payloadType === "syllable") {
    return parseSpicySyllableLyrics(payload.Content);
  }
  if (payloadType === "line") {
    return parseSpicyLineLyrics(payload);
  }
  if (payloadType === "static") {
    return parseSpicyStaticLyrics(payload.Lines, durationMs);
  }
  return [];
}

function normalizeCreditNameParts(value, output = []) {
  if (value === null || value === undefined) {
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      normalizeCreditNameParts(item, output);
    }
    return output;
  }
  if (typeof value === "object") {
    for (const key of [
      "Name",
      "name",
      "FullName",
      "fullName",
      "DisplayName",
      "displayName",
      "ArtistName",
      "artistName",
      "WriterName",
      "writerName",
      "ComposerName",
      "composerName",
    ]) {
      if (value?.[key]) {
        normalizeCreditNameParts(value[key], output);
        return output;
      }
    }
    return output;
  }
  const text = String(value || "")
    .replace(
      /\b(?:written|writer|writers|songwriter|songwriters|composer|composers|lyrics|lyricist|lyricists)\s*(?:by)?\s*[:=-]\s*/gi,
      "",
    )
    .trim();
  if (!text) {
    return output;
  }
  for (const part of text.split(/\s*(?:,|;|\/|\||&|\band\b|\+)\s*/i)) {
    const safe = String(part || "")
      .replace(/^\s*(?:by|and)\s+/i, "")
      .trim();
    if (
      safe &&
      safe.length <= 80 &&
      !/^(?:unknown|n\/a|null|undefined)$/i.test(safe) &&
      !output.some((entry) => entry.toLowerCase() === safe.toLowerCase())
    ) {
      output.push(safe);
    }
  }
  return output;
}

function extractSpicySongwritersFromNode(node, output, depth = 0) {
  if (depth > 5 || !node || typeof node !== "object") {
    return output;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      extractSpicySongwritersFromNode(item, output, depth + 1);
    }
    return output;
  }

  for (const [key, value] of Object.entries(node)) {
    const normalizedKey = String(key || "").toLowerCase();
    const isCreditKey =
      normalizedKey.includes("songwriter") ||
      normalizedKey.includes("writer") ||
      normalizedKey.includes("composer") ||
      normalizedKey.includes("lyricist") ||
      normalizedKey === "writtenby" ||
      normalizedKey === "written_by";
    if (isCreditKey) {
      normalizeCreditNameParts(value, output);
      continue;
    }
    const isMetadataContainer =
      normalizedKey.includes("credit") ||
      normalizedKey.includes("metadata") ||
      normalizedKey.includes("info") ||
      normalizedKey.includes("attribution");
    if (isMetadataContainer && value && typeof value === "object") {
      extractSpicySongwritersFromNode(value, output, depth + 1);
    }
  }
  return output;
}

function extractSpicySongwriters(payload) {
  const songwriters = extractSpicySongwritersFromNode(payload, []);
  return songwriters.slice(0, 12);
}

function trimLeadingMetaLines(lyrics, startTs) {
  if (!Array.isArray(lyrics) || !lyrics.length) {
    return [];
  }
  const start = Number(startTs);
  if (!Number.isFinite(start) || start <= 0) {
    return lyrics;
  }
  // QQ musicu returns intro/title/credits before the true vocal start in some tracks.
  const preludeCutoff = start - 250;
  const trimmed = lyrics.filter((line) => {
    const lineStart = Number(line?.lineStartTime || 0);
    const lineEnd = Number(line?.lineEndTime || 0);
    return lineEnd >= preludeCutoff && lineStart >= preludeCutoff;
  });
  return trimmed.length ? trimmed : lyrics;
}

function isCjkBoundaryChar(char) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
    String(char || ""),
  );
}

function shouldInsertSyllableBoundarySpace(leftText, rightText) {
  const left = String(leftText || "");
  const right = String(rightText || "");
  if (!left || !right) {
    return false;
  }
  if (/\s$/.test(left) || /^\s/.test(right)) {
    return false;
  }
  if (nextSyllableLeadsWithOpeningDoubleQuotedWord(left, right)) {
    return true;
  }
  if (nextSyllableLeadsWithAttachPunctuation(right)) {
    return false;
  }

  const leftChar = left.slice(-1);
  const rightChar = right.slice(0, 1);
  if (!leftChar || !rightChar) {
    return false;
  }
  if (isCjkBoundaryChar(leftChar) || isCjkBoundaryChar(rightChar)) {
    return false;
  }

  if (isCensorshipBoundary(left, right)) {
    return true;
  }

  const latinOrDigit = /[A-Za-z0-9]/;
  return latinOrDigit.test(leftChar) && latinOrDigit.test(rightChar);
}

function getLineText(line) {
  const parts = (line?.syllables || [])
    .map((s) => ({
      text: String(s?.text || ""),
      isPartOfWord:
        typeof s?.isPartOfWord === "boolean" ? s.isPartOfWord : undefined,
    }))
    .filter((part) => part.text.length > 0);
  if (!parts.length) {
    return "";
  }

  let text = parts[0].text;
  for (let index = 1; index < parts.length; index += 1) {
    const nextPart = parts[index];
    const prevPart = parts[index - 1];
    const hasWhitespaceBoundary = /\s$/.test(text) || /^\s/.test(nextPart.text);
    const boundaryFromWordFlag = prevPart.isPartOfWord === false;
    const boundaryFromHeuristic =
      prevPart.isPartOfWord !== true &&
      prevPart.isPartOfWord !== false &&
      shouldInsertSyllableBoundarySpace(text, nextPart.text);
    if (
      !hasWhitespaceBoundary &&
      (boundaryFromWordFlag || boundaryFromHeuristic)
    ) {
      text += " ";
    }
    text += nextPart.text;
  }
  return text.trim();
}

function getSyllableText(syllables = []) {
  const parts = (Array.isArray(syllables) ? syllables : [])
    .map((s) => ({
      text: String(s?.text || ""),
      isPartOfWord:
        typeof s?.isPartOfWord === "boolean" ? s.isPartOfWord : undefined,
    }))
    .filter((part) => part.text.length > 0);
  if (!parts.length) {
    return "";
  }

  let text = parts[0].text;
  for (let index = 1; index < parts.length; index += 1) {
    const nextPart = parts[index];
    const prevPart = parts[index - 1];
    const hasWhitespaceBoundary = /\s$/.test(text) || /^\s/.test(nextPart.text);
    const boundaryFromWordFlag = prevPart.isPartOfWord === false;
    const boundaryFromHeuristic =
      prevPart.isPartOfWord !== true &&
      prevPart.isPartOfWord !== false &&
      shouldInsertSyllableBoundarySpace(text, nextPart.text);
    if (
      !hasWhitespaceBoundary &&
      (boundaryFromWordFlag || boundaryFromHeuristic)
    ) {
      text += " ";
    }
    text += nextPart.text;
  }
  return text.trim();
}

function getBackgroundLineText(line) {
  return getSyllableText(line?.backgroundSyllables || []);
}

function appendBackgroundTranslatedSegment(existingText, backgroundTranslated) {
  const existing = String(existingText || "").trim();
  const segment = String(backgroundTranslated || "").trim();
  if (!segment) {
    return existing;
  }

  const wrapped = `(${segment})`;
  if (!existing) {
    return wrapped;
  }

  const existingNorm = normalizeTranslationVisibilityText(existing);
  const wrappedNorm = normalizeTranslationVisibilityText(wrapped);
  const segmentNorm = normalizeTranslationVisibilityText(segment);
  if (
    (wrappedNorm && existingNorm.includes(wrappedNorm)) ||
    (segmentNorm && existingNorm.includes(segmentNorm))
  ) {
    return existing;
  }
  return `${existing} ${wrapped}`.trim();
}

function buildTranslatedTextForLineFromLookup(line, translatedByText = {}) {
  let translatedText = "";
  const leadText = String(getLineText(line) || "").trim();
  if (leadText) {
    const leadTranslated = String(translatedByText[leadText] || "").trim();
    if (leadTranslated && !shouldHideTranslatedText(leadText, leadTranslated)) {
      translatedText = appendTranslatedSegment(translatedText, leadTranslated);
    }
  }

  const backgroundText = String(getBackgroundLineText(line) || "").trim();
  if (backgroundText) {
    const backgroundTranslated = String(
      translatedByText[backgroundText] || "",
    ).trim();
    if (
      backgroundTranslated &&
      !shouldHideTranslatedText(backgroundText, backgroundTranslated)
    ) {
      translatedText = appendBackgroundTranslatedSegment(
        translatedText,
        backgroundTranslated,
      );
    }
  }

  return translatedText;
}

function isLikelyMetadataLineText(text, track) {
  const raw = String(text || "").trim();
  if (!raw) {
    return true;
  }
  if (hasChineseLyricCreditLabel(raw) || hasProductionRoleLabel(raw)) {
    return true;
  }

  const normalized = normalizeText(text).replace(/\s+/g, "");
  if (!normalized) {
    return true;
  }

  const metadataKeywordRegex =
    /(writtenby|writer|writers|songwriter|songwriters|composedby|composer|composers|producedby|producer|producers|arrangedby|arranger|arrangers|masteredby|mastering|mixedby|recordedby|engineer|engineers|lyricist|lyricists|credits?|credit|作词|作曲|编曲|制作人|词[:：]|曲[:：]|编[:：]|唱[:：]|lyrics?[:：]|music[:：]|prod(?:uced)?\.?by|arr\.?by|master(?:ed)?\.?by|mix(?:ed)?\.?by|record(?:ed)?\.?by)/i;
  if (metadataKeywordRegex.test(normalized)) {
    return true;
  }

  const metadataTagLineRegex =
    /^\s*[\[(](?:ti|ar|al|by|offset|re|ve|au|tool|kana|language|trans(?:lation)?|roma)[\]:=]/i;
  if (metadataTagLineRegex.test(String(text || ""))) {
    return true;
  }

  const bracketedCreditRegex =
    /^\s*[\[(](?:作词|作曲|编曲|制作人|词|曲|编|监制|lyric(?:s|ist)?|composer|arranger|producer|credit)[\]）)]?\s*[:：-]/i;
  if (bracketedCreditRegex.test(String(text || ""))) {
    return true;
  }

  const lineCore = normalizeCoreTitle(text);
  const trackCore = normalizeCoreTitle(track?.title || "");
  const trackArtist = normalizeText(track?.artist || "");
  const lineNorm = normalizeText(text);
  const lineNormTight = lineNorm.replace(/\s+/g, "");
  const trackCoreTight = trackCore.replace(/\s+/g, "");
  const trackArtistTight = trackArtist.replace(/\s+/g, "");
  const containsTrackTitle =
    Boolean(trackCore) &&
    (lineCore.includes(trackCore) ||
      lineNorm.includes(trackCore) ||
      (trackCoreTight && lineNormTight.includes(trackCoreTight)));
  const trackArtistCandidates = [
    trackArtist,
    normalizeText(getSpotifyPrimaryArtist(track?.artist || "")),
    normalizeText(
      String(track?.artist || "")
        .replace(/\s*\([^)]*\)/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    ),
  ].filter(Boolean);
  const containsTrackArtist = trackArtistCandidates.some((candidate) => {
    const candidateTight = candidate.replace(/\s+/g, "");
    return (
      lineNorm.includes(candidate) ||
      (candidateTight && lineNormTight.includes(candidateTight))
    );
  });
  if (containsTrackTitle && containsTrackArtist) {
    return true;
  }

  return false;
}

function isSkippableLeadingLine(text, line, track) {
  if (!String(text || "").trim()) {
    return true;
  }
  if (isLikelyLeadingMetadataHeaderLine(text, track)) {
    return true;
  }
  if (hasChineseLyricCreditLabel(text)) {
    return true;
  }
  if (hasProductionRoleLabel(text)) {
    return true;
  }
  const norm = normalizeMatchText(String(text || "").trim());
  if ((norm.match(/\//g) || []).length >= 2) {
    return true;
  }
  if (
    isTimingCompressedPreludeLine(line) &&
    (hasProductionRoleLabel(text) ||
      (String(text || "")
        .trim()
        .startsWith("(") &&
        (String(text || "").match(/\//g) || []).length >= 2))
  ) {
    return true;
  }
  return false;
}

function stripLeadingMetadataLines(lyrics, track) {
  if (!Array.isArray(lyrics) || !lyrics.length) {
    return [];
  }

  const isPreludeWindowLine = (line) =>
    Number(line?.lineEndTime || 0) <= 90_000;

  // Detect whether this payload begins with a metadata header block.
  // When QQ/Netease embed credits at the top, those lines are typically short/tight
  // in time and can exceed 4 lines, so scan a wider window than before.
  const metadataProbeLimit = Math.min(20, lyrics.length);
  let metadataLikePrefixCount = 0;
  for (let index = 0; index < metadataProbeLimit; index += 1) {
    const line = lyrics[index];
    const text = getLineText(line);
    if (
      !text ||
      (isPreludeWindowLine(line) && isSkippableLeadingLine(text, line, track))
    ) {
      metadataLikePrefixCount += 1;
      continue;
    }
    break;
  }

  const aggressiveTrimEnabled = metadataLikePrefixCount >= 3;
  let startIndex = 0;
  const maxScan = aggressiveTrimEnabled
    ? Math.min(24, lyrics.length)
    : Math.min(6, lyrics.length);
  while (startIndex < lyrics.length && startIndex < maxScan) {
    const line = lyrics[startIndex];
    const text = getLineText(line);
    if (!text) {
      startIndex += 1;
      continue;
    }
    if (!isPreludeWindowLine(line)) {
      break;
    }
    if (!isSkippableLeadingLine(text, line, track)) {
      break;
    }
    startIndex += 1;
  }

  while (
    startIndex < lyrics.length &&
    startIndex < Math.min(24, lyrics.length)
  ) {
    const line = lyrics[startIndex];
    const text = getLineText(line);
    if (!isPreludeWindowLine(line)) {
      break;
    }
    const lineDuration = Math.max(
      0,
      Number(line?.lineEndTime || 0) - Number(line?.lineStartTime || 0),
    );
    const medianSyllableDuration = getMedianSyllableDurationMs(line);
    const vocalLike =
      lineDuration >= 500 &&
      medianSyllableDuration >= 100 &&
      !isSkippableLeadingLine(text, line, track);
    if (vocalLike) {
      break;
    }
    if (!isTimingCompressedPreludeLine(line)) {
      break;
    }
    if (!isSkippableLeadingLine(text, line, track)) {
      break;
    }
    startIndex += 1;
  }

  const stripped = lyrics.slice(startIndex);
  return stripped.length ? stripped : lyrics;
}

function scoreCandidate(track, title, artist) {
  const titleTokens = tokens(title);
  const targetTitleTokens = tokens(track.title);
  const titleOverlap = overlapRatio(titleTokens, targetTitleTokens);
  const artistOverlap = getBestArtistOverlap(
    getSpotifyPrimaryArtist(track.artist),
    artist,
  );

  const t = normalizeMatchText(title);
  const targetT = normalizeMatchText(track.title);
  const coreT = normalizeCoreTitle(title);
  const targetCoreT = normalizeCoreTitle(track.title);
  let score = 0;
  if (t && targetT && t === targetT) {
    score += 6;
  } else if (coreT && targetCoreT && coreT === targetCoreT) {
    score += 4;
  } else if (targetT && hasWholeTextContainment(t, targetT)) {
    score += 1.5;
  }
  if (artistOverlap >= 0.95) {
    score += 5;
  } else if (artistOverlap >= 0.55) {
    score += 3;
  } else if (artistOverlap >= 0.35) {
    score += 1.5;
  } else if (artistOverlap > 0 && artistOverlap < 0.2) {
    score -= 2;
  }

  score += titleOverlap * 3.5;
  score += artistOverlap * 4;

  if (hasExtraneousTitleWords(track.title, title)) {
    score -= needsExactShortTextMatch(targetCoreT) ? 5 : 2.5;
  }

  const queryHasFeaturing =
    featuringRegex.test(String(track?.artist || "")) ||
    featuringRegex.test(String(track?.title || ""));
  const candidateHasFeaturing =
    featuringRegex.test(String(artist || "")) ||
    featuringRegex.test(String(title || ""));
  if (!queryHasFeaturing && candidateHasFeaturing) {
    score -= needsExactShortTextMatch(targetCoreT) ? 3 : 1.5;
  }
  if (
    hasMissingFeaturedArtistHints(track.title, title) &&
    !featuredArtistHintsPresentInCandidate(track.title, title, artist)
  ) {
    score -= 4;
  }

  const queryHints = collectVersionHints(track.title);
  const candidateHints = collectVersionHints(title);
  const unmatchedCandidateHints = candidateHints.filter(
    (hint) => !queryHints.includes(hint),
  );
  score -= unmatchedCandidateHints.length * 2.5;
  if (!queryHints.length && candidateHints.length) {
    score -= 1.5;
  }

  const queryHasCjk = containsCjk(track.title);
  const candidateHasCjk = containsCjk(title);
  if (!queryHasCjk && candidateHasCjk) {
    score -= 2.5;
  }

  const queryArtistLatin = normalizeMatchText(track.artist);
  const candidateArtistHasCjk = containsCjk(artist);
  if (queryArtistLatin && !containsCjk(track.artist) && candidateArtistHasCjk) {
    if (artistOverlap < 0.35) {
      score -= 1.5;
    }
  }

  return score;
}

function titleMatchesViaBracketedAlias(trackCore, candidateTitle) {
  if (!trackCore || !candidateTitle) {
    return false;
  }
  return extractBracketedTitleSegments(candidateTitle).some((segment) => {
    if (segment === trackCore) {
      return true;
    }
    return (
      hasWholeTextContainment(trackCore, segment) ||
      hasWholeTextContainment(segment, trackCore) ||
      overlapRatio(tokens(trackCore), tokens(segment)) >= 0.62
    );
  });
}

function titleCoreMatchesQuery(track, candidateTitle) {
  const trackCore = normalizeCoreTitle(track?.title || "");
  const candidateCore = normalizeCoreTitle(candidateTitle);
  if (!trackCore || !candidateCore) {
    return false;
  }
  if (trackCore === candidateCore) {
    return true;
  }
  if (needsExactShortTextMatch(trackCore)) {
    if (candidateCore === trackCore) {
      return true;
    }
    return titleMatchesViaBracketedAlias(trackCore, candidateTitle);
  }
  if (
    hasWholeTextContainment(trackCore, candidateCore) ||
    hasWholeTextContainment(candidateCore, trackCore) ||
    overlapRatio(tokens(trackCore), tokens(candidateCore)) >= 0.62
  ) {
    return true;
  }
  // QQ/Korean catalogs often list tracks as "Hangul (English)" while Spotify uses English.
  if (!containsCjk(trackCore) && containsCjk(candidateCore)) {
    return titleMatchesViaBracketedAlias(trackCore, candidateTitle);
  }
  return false;
}

function featuredArtistHintsPresentInCandidate(
  queryTitle,
  candidateTitle,
  candidateArtist,
) {
  const hints = collectFeaturedArtistHints(queryTitle);
  if (!hints.length) {
    return true;
  }
  const haystack = normalizeMatchText(`${candidateTitle} ${candidateArtist}`);
  return hints.every((hint) => haystack.includes(hint));
}

function candidateMeetsClearWinnerGuards(track, title, artist) {
  if (hasLanguageVariantMismatch(track.title, title)) {
    return false;
  }
  if (!titleCoreMatchesQuery(track, title)) {
    return false;
  }
  const queryCore = normalizeCoreTitle(track?.title || "");
  const candidateCore = normalizeCoreTitle(title);
  if (!queryCore || !candidateCore || queryCore !== candidateCore) {
    return false;
  }
  if (hasMissingFeaturedArtistHints(track.title, title)) {
    if (!featuredArtistHintsPresentInCandidate(track.title, title, artist)) {
      return false;
    }
  }
  if (hasExtraneousFeaturedArtistHints(track.title, title)) {
    return false;
  }
  return true;
}

function isDurationAcceptableForClearWinner(track, durationMs = 0) {
  if (!(track.durationMs > 0 && durationMs > 0)) {
    return true;
  }
  const durationDelta = Math.abs(durationMs - track.durationMs);
  const trackCore = normalizeCoreTitle(track?.title || "");
  const exactShortTitleMatchRequired = needsExactShortTextMatch(trackCore);
  const durationToleranceMs = exactShortTitleMatchRequired
    ? 35_000
    : Math.max(
        14_000,
        Math.min(90_000, Math.floor((track.durationMs || 0) * 0.45)),
      );
  return durationDelta <= durationToleranceMs;
}

function findClearWinnerAmongTitleMatched(track, candidates) {
  const titleMatched = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => ({
      ...candidate,
      overlap: getBestArtistOverlap(track.artist, candidate.artist),
    }))
    .filter((candidate) =>
      candidateMeetsClearWinnerGuards(track, candidate.title, candidate.artist),
    );

  if (!titleMatched.length) {
    return null;
  }

  const maxOverlap = Math.max(
    ...titleMatched.map((candidate) => candidate.overlap),
  );
  if (maxOverlap > ARTIST_OVERLAP_CONFIDENT_THRESHOLD) {
    return null;
  }

  titleMatched.sort((left, right) => {
    if (right.overlap !== left.overlap) {
      return right.overlap - left.overlap;
    }
    return Number(right.score || 0) - Number(left.score || 0);
  });

  const top = titleMatched[0];
  const second = titleMatched[1];
  if (!top || top.overlap < CLEAR_WINNER_MIN_OVERLAP) {
    return null;
  }
  if (second && top.overlap - second.overlap < CLEAR_WINNER_MIN_OVERLAP_GAP) {
    return null;
  }
  if (!isDurationAcceptableForClearWinner(track, top.durationMs || 0)) {
    return null;
  }
  return top;
}

function filterLikelySameTrackCandidates(
  track,
  rankedCandidates,
  accessors = {},
) {
  const getTitle =
    typeof accessors.getTitle === "function"
      ? accessors.getTitle
      : (candidate) => candidate.title || "";
  const getArtist =
    typeof accessors.getArtist === "function"
      ? accessors.getArtist
      : (candidate) => candidate.artist || "";
  const getDurationMs =
    typeof accessors.getDurationMs === "function"
      ? accessors.getDurationMs
      : (candidate) => Number(candidate.durationMs || 0);
  const getScore =
    typeof accessors.getScore === "function"
      ? accessors.getScore
      : (candidate) => Number(candidate.score || 0);

  const entries = (Array.isArray(rankedCandidates) ? rankedCandidates : []).map(
    (raw) => ({
      raw,
      title: String(getTitle(raw) || "").trim(),
      artist: String(getArtist(raw) || "").trim(),
      durationMs: Number(getDurationMs(raw) || 0),
      score: Number(getScore(raw) || 0),
    }),
  );

  const strictMatches = entries.filter((entry) =>
    isLikelySameTrack(track, entry.title, entry.artist, entry.durationMs),
  );
  if (strictMatches.length) {
    return strictMatches.map((entry) => entry.raw);
  }

  const clearWinner = findClearWinnerAmongTitleMatched(track, entries);
  if (!clearWinner) {
    return [];
  }

  return entries
    .filter(
      (entry) =>
        normalizeCoreTitle(entry.title) ===
          normalizeCoreTitle(clearWinner.title) &&
        normalizeMatchText(entry.artist) ===
          normalizeMatchText(clearWinner.artist),
    )
    .map((entry) => entry.raw);
}

function isLikelySameTrack(track, title, artist, durationMs = 0) {
  if (hasLanguageVariantMismatch(track.title, title)) {
    return false;
  }
  if (hasMissingFeaturedArtistHints(track.title, title)) {
    if (!featuredArtistHintsPresentInCandidate(track.title, title, artist)) {
      return false;
    }
  }
  if (!titleCoreMatchesQuery(track, title)) {
    return false;
  }
  const trackCore = normalizeCoreTitle(track.title);
  const candidateCore = normalizeCoreTitle(title);
  const titleTokenOverlap = overlapRatio(
    tokens(trackCore),
    tokens(candidateCore),
  );
  const artistOverlap = getBestArtistOverlap(track.artist, artist);
  const artistLooksRelated = artistNamesLookRelated(track.artist, artist);

  if (!trackCore || !candidateCore) {
    return false;
  }

  const queryTitleCandidates = [
    trackCore,
    ...extractBracketedTitleSegments(track?.title || ""),
  ].filter(Boolean);
  const candidateTitleCandidates = [
    candidateCore,
    ...extractBracketedTitleSegments(title),
  ].filter(Boolean);
  const exactShortTitleMatchRequired = needsExactShortTextMatch(trackCore);
  let strongestTitleOverlap = 0;
  let titleContainmentMatch = false;
  const titleLooksRelated = queryTitleCandidates.some((queryCandidate) =>
    candidateTitleCandidates.some((candidateOption) => {
      if (!queryCandidate || !candidateOption) {
        return false;
      }
      const overlap = overlapRatio(
        tokens(queryCandidate),
        tokens(candidateOption),
      );
      strongestTitleOverlap = Math.max(strongestTitleOverlap, overlap);
      if (queryCandidate === candidateOption) {
        titleContainmentMatch = true;
        return true;
      }
      if (exactShortTitleMatchRequired) {
        if (
          queryCandidate === candidateOption ||
          (queryCandidate === trackCore &&
            candidateOption === candidateCore &&
            !hasMissingFeaturedArtistHints(track.title, title))
        ) {
          titleContainmentMatch = true;
          return true;
        }
        return false;
      }
      if (hasWholeTextContainment(queryCandidate, candidateOption)) {
        titleContainmentMatch = true;
        return true;
      }
      return overlap >= 0.62;
    }),
  );

  if (!titleLooksRelated) {
    return false;
  }

  if (exactShortTitleMatchRequired && !titleContainmentMatch) {
    return false;
  }

  if (
    exactShortTitleMatchRequired &&
    hasExtraneousTitleWords(track.title, title)
  ) {
    return false;
  }

  const durationDelta =
    track.durationMs > 0 && durationMs > 0
      ? Math.abs(durationMs - track.durationMs)
      : 0;
  const hasDurationComparison = track.durationMs > 0 && durationMs > 0;
  if (exactShortTitleMatchRequired && !artistLooksRelated) {
    return false;
  }
  const strongShortTitleArtistMatch =
    exactShortTitleMatchRequired && titleContainmentMatch && artistLooksRelated;
  const exactTitleArtistMatch =
    titleContainmentMatch && artistLooksRelated && trackCore === candidateCore;
  const durationToleranceMs = strongShortTitleArtistMatch
    ? 35_000
    : exactTitleArtistMatch
      ? Math.max(
          14_000,
          Math.min(90_000, Math.floor((track.durationMs || 0) * 0.45)),
        )
      : 12_000;
  const durationCloseEnough = hasDurationComparison
    ? durationDelta <= durationToleranceMs
    : true;

  if (artistLooksRelated) {
    if (exactShortTitleMatchRequired && !titleContainmentMatch) {
      return false;
    }
    return durationCloseEnough;
  }

  if (!artistLooksRelated) {
    if (artistOverlap < 0.12) {
      return false;
    }
    if (!durationCloseEnough) {
      return false;
    }
    const titleStrongEnough =
      titleContainmentMatch || strongestTitleOverlap >= 0.9;
    if (!titleStrongEnough) {
      return false;
    }
    if (!hasDurationComparison) {
      return false;
    }
    const queryCoreTokens = tokens(trackCore);
    if (queryCoreTokens.length < 2 && String(trackCore || "").length < 10) {
      return false;
    }
    const strictDurationMatch = durationDelta <= 6_000;
    const ultraCloseDurationMatch = durationDelta <= 2_500;
    const queryHasSpecificBracketDetail =
      extractBracketedTitleSegments(track?.title || "").length > 0;
    const queryTitleCoreLength = String(trackCore || "").length;
    const multiTokenTitle = tokens(trackCore).length >= 2;
    if (
      ultraCloseDurationMatch ||
      (strictDurationMatch &&
        (queryHasSpecificBracketDetail ||
          multiTokenTitle ||
          queryTitleCoreLength >= 8))
    ) {
      return true;
    }
    return false;
  }
  return durationCloseEnough;
}

function computeCandidateMatchRank(
  track,
  title,
  artist,
  durationMs = 0,
  searchScore = 0,
) {
  const trackCore = normalizeCoreTitle(track?.title || "");
  const candidateCore = normalizeCoreTitle(title);
  let rank = Number(searchScore || 0);
  rank += getBestArtistOverlap(track.artist, artist) * 12;
  if (trackCore && candidateCore && trackCore === candidateCore) {
    rank += 22;
  }
  if (needsExactShortTextMatch(trackCore)) {
    const bracketHasCore = extractBracketedTitleSegments(title).some(
      (segment) =>
        segment === trackCore ||
        tokens(segment).includes(trackCore) ||
        hasWholeTextContainment(segment, trackCore),
    );
    if (bracketHasCore || candidateCore === trackCore) {
      rank += 18;
    } else {
      rank -= 50;
    }
  }
  rank += scoreDurationBonus(track, title, artist, durationMs) * 0.4;
  return rank;
}

function shouldPreferLyricsCandidate(
  track,
  current,
  candidate,
  currentCoverage,
  candidateCoverage,
) {
  const currentRank = computeCandidateMatchRank(
    track,
    current.title,
    current.artist,
    current.durationMs,
    current.searchScore,
  );
  const candidateRank = computeCandidateMatchRank(
    track,
    candidate.title,
    candidate.artist,
    candidate.durationMs,
    candidate.searchScore,
  );
  if (candidateRank > currentRank + 0.5) {
    return true;
  }
  if (currentRank > candidateRank + 0.5) {
    return false;
  }
  return candidateCoverage > currentCoverage;
}

function explainTrackMatch(track, title, artist, durationMs = 0) {
  const trackCore = normalizeCoreTitle(track?.title || "");
  const candidateCore = normalizeCoreTitle(title);
  const featuredHints = collectFeaturedArtistHints(track?.title || "");
  const candidateNorm = normalizeMatchText(title);
  return {
    likely: isLikelySameTrack(track, title, artist, durationMs),
    languageVariantMismatch: hasLanguageVariantMismatch(track.title, title),
    missingFeaturedArtistHints:
      hasMissingFeaturedArtistHints(track.title, title) &&
      !featuredArtistHintsPresentInCandidate(track.title, title, artist),
    extraneousTitleWords: hasExtraneousTitleWords(track.title, title),
    featuredHints,
    featuredHintChecks: featuredHints.map((hint) => ({
      hint,
      present: candidateNorm.includes(hint),
    })),
    candidateNorm,
    artistOverlap: getBestArtistOverlap(track.artist, artist),
    artistLooksRelated: artistNamesLookRelated(track.artist, artist),
    trackCore,
    candidateCore,
    exactShortTitle: needsExactShortTextMatch(trackCore),
    titleCoreMatchesQuery: titleCoreMatchesQuery(track, title),
  };
}

async function fetchJson(
  url,
  { params = {}, headers = {}, timeoutMs = 8_000 } = {},
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && `${value}`.length > 0) {
      query.set(key, String(value));
    }
  }
  const queryString = query.toString();
  const finalUrl = queryString ? `${url}?${queryString}` : url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(finalUrl, {
      method: "GET",
      headers: makeMobileSafeHeaders({
        Accept: "application/json,text/plain,*/*",
        "User-Agent": "KineSyncDesktopBridge/1.0",
        ...headers,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await response.text();
    return parseJsonLenient(text);
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonLenient(rawText) {
  const text = String(rawText || "").trim();
  if (!text) {
    throw new Error("Empty response body");
  }
  const direct = tryParseJson(text);
  if (direct.ok) {
    return direct.value;
  }

  const jsonpMatch = text.match(/^[^(]+\(([\s\S]+)\)\s*;?\s*$/);
  if (jsonpMatch?.[1]) {
    const parsedJsonp = tryParseJson(jsonpMatch[1].trim());
    if (parsedJsonp.ok) {
      return parsedJsonp.value;
    }
  }

  const prefixed = text.replace(/^\)\]\}',?\s*/, "");
  const parsedPrefixed = tryParseJson(prefixed);
  if (parsedPrefixed.ok) {
    return parsedPrefixed.value;
  }

  throw new Error(`Invalid JSON response (${text.slice(0, 80)})`);
}

function tryParseJson(input) {
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch {
    return { ok: false, value: null };
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryRequest(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    error?.name === "AbortError" ||
    message.includes("network") ||
    message.includes("fetch") ||
    message.includes("timeout") ||
    message.includes("econn") ||
    message.includes("etimedout")
  );
}

async function fetchJsonWithRetry(
  url,
  options = {},
  { attempts = 3, backoffMs = 350 } = {},
) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchJson(url, options);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetryRequest(error)) {
        throw error;
      }
      await wait(backoffMs * attempt);
    }
  }
  throw lastError || new Error("Request failed");
}

function normalizeJsososoSongs(searchData) {
  const list =
    searchData?.data?.song?.itemlist ||
    searchData?.data?.list ||
    searchData?.data?.body?.song?.list ||
    searchData?.data?.song?.list ||
    searchData?.data?.song?.items ||
    searchData?.data?.song?.songlist ||
    searchData?.song?.itemlist ||
    searchData?.song?.list ||
    [];
  return Array.isArray(list) ? list : [];
}

function extractJsososoLyricText(lyricData) {
  return (
    lyricData?.data?.qrc ||
    lyricData?.data?.lyric ||
    lyricData?.data?.body?.lyric ||
    lyricData?.data?.body?.qrc ||
    lyricData?.qrc ||
    lyricData?.lyric ||
    ""
  );
}

function describeSourceError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  if (message.includes("cooldown active")) {
    return "rate-limited";
  }
  if (message === "__no_match__" || message.includes("no match")) {
    return "no-match";
  }
  if (message.includes("url blocked") || message.includes("error 54113")) {
    return "url-blocked";
  }
  if (
    message.includes("token was rejected") ||
    message.includes("unauthorized")
  ) {
    return "unauthorized";
  }
  if (
    message.includes("missing musixmatch") ||
    message.includes("token format is invalid") ||
    message.includes("missing spotify web token")
  ) {
    return "missing-config";
  }
  if (
    message.includes("spotify web token exchange") ||
    message.includes("access token")
  ) {
    return "unauthorized";
  }
  if (message.includes("captcha")) {
    return "rate-limited";
  }
  if (error?.name === "AbortError" || message.includes("timeout")) {
    return "timeout";
  }
  if (message.includes("http 403") || message.includes("http 429")) {
    return "rate-limited";
  }
  if (message.includes("http ")) {
    return "http";
  }
  if (message.includes("invalid json")) {
    return "invalid-json";
  }
  if (
    message.includes("unsupported payload") ||
    message.includes("unsupported format")
  ) {
    return "unsupported-format";
  }
  if (message.includes("slobjpack unpack")) {
    return "unpack-failed";
  }
  if (
    message.includes("still queued") ||
    /\bstatus 503\b/.test(message) ||
    message.includes("http 503")
  ) {
    return "queued";
  }
  if (message.includes("static results") || message.includes("stale catalog")) {
    return "stale-catalog";
  }
  return "network";
}

function createSourceStageError(source, stage, error) {
  const wrapped =
    error instanceof Error
      ? error
      : new Error(String(error || `${source} ${stage} failed`));
  wrapped.sourceFailureReason = `${source}:${stage}-${describeSourceError(error)}`;
  return wrapped;
}

function createSourceStageNoMatchError(source, stage) {
  const error = new Error(`${source} ${stage} returned no match`);
  error.sourceFailureReason = `${source}:${stage}-no-match`;
  return error;
}

// ---- DesktopBridge/src/lyrics/parts/02-network-and-spotify.js ----
// Endpoint constants, retry/fetch helpers, Spicy Lyrics network setup, Spotify token/search helpers, and coverage scoring.
// This file is evaluated by ../index.js in a shared compatibility context.
// Keep behavior changes deliberate; most code here was moved verbatim from src/lyricsService.js.

const JSOSOSO_BASE_URLS = [
  "https://api.qq.jsososo.com",
  "http://api.qq.jsososo.com",
  "https://qq-api-soso.vercel.app",
];
const QQ_MUSICU_ENDPOINTS = [
  "https://u.y.qq.com/cgi-bin/musicu.fcg",
  "https://u6.y.qq.com/cgi-bin/musicu.fcg",
];
const QQ_SEARCH_ENDPOINTS = [
  "https://c.y.qq.com/soso/fcgi-bin/client_search_cp",
  "https://c6.y.qq.com/soso/fcgi-bin/client_search_cp",
  "https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp",
  "https://c6.y.qq.com/soso/fcgi-bin/search_for_qq_cp",
];
const QQ_LYRIC_ENDPOINTS = [
  "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg",
  "https://c6.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg",
  "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_yqq.fcg",
  "https://c6.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_yqq.fcg",
];
const QQ_LEGACY_SEARCH_ENDPOINTS = [
  "https://c.y.qq.com/lyric/fcgi-bin/fcg_search_pc_lrc.fcg",
  "https://c6.y.qq.com/lyric/fcgi-bin/fcg_search_pc_lrc.fcg",
];
const QQ_LEGACY_DOWNLOAD_ENDPOINTS = [
  "https://c.y.qq.com/qqmusic/fcgi-bin/lyric_download.fcg",
  "https://c6.y.qq.com/qqmusic/fcgi-bin/lyric_download.fcg",
];
const METING_SEARCH_ENDPOINTS = ["https://api.i-meto.com/meting/api"];
const NETEASE_BASE_URLS = [
  "https://netease-cloud-music-api.jinghuashang.cn",
  "https://neteasecloudmusicapi.vercel.app",
];
const NETEASE_DIRECT_API_URL = "https://interface.music.163.com";
const SPICY_LYRICS_API_URL = "https://api.spicylyrics.org";
/** Fallback only; the official client fetches the active version from /version. */
const SPICY_LYRICS_CLIENT_VERSION = "6.3.1";
const SPICY_LYRICS_VERSION_CACHE_TTL_MS = 15 * 60 * 1000;
const SPICY_LYRICS_VERSION_FAILURE_CACHE_TTL_MS = 2 * 60 * 1000;
const spicyLyricsClientVersionCache = {
  value: "",
  expiresAt: 0,
  promise: null,
};
const SPICY_QUEUE_BASE_DELAY_MS = 2_000;
const SPICY_QUEUE_MAX_DELAY_MS = 10_000;
const SPICY_QUEUE_BACKOFF_FACTOR = 1.5;
/** Official Spicy client retries 503 indefinitely; static lyrics often need long queue waits. */
const SPICY_QUEUE_MAX_WAIT_MS = 12 * 60 * 1000;
const SPICY_QUEUE_MAX_ATTEMPTS = 120;
const spicyLyricsObjPack = new SLObjPack();
/** Public CORS proxy; POST + JSON body and custom headers are forwarded per https://corsproxy.io/ */
const SPICY_LYRICS_CORSPROXY_PREFIX = "https://corsproxy.io/?url=";
const SPICY_PROXY_FALLBACK_STATUSES = new Set([403, 429, 502, 503, 504]);
const SPICY_DIRECT_429_MAX_RETRIES = 2;
const SPICY_DIRECT_429_BASE_DELAY_MS = 2_500;
const SPICY_DEBUG_ENABLED = ["1", "true", "yes", "on"].includes(
  String(process.env.SPICY_DEBUG || "")
    .trim()
    .toLowerCase(),
);

const spicyLyricsNetworkRef = {
  /** @type {null | (() => boolean)} */
  getSpicyLyricsUseCorsProxyFromBridge: null,
};
function setSpicyLyricsNetworkOptions({
  getSpicyLyricsUseCorsProxy = null,
} = {}) {
  spicyLyricsNetworkRef.getSpicyLyricsUseCorsProxyFromBridge =
    typeof getSpicyLyricsUseCorsProxy === "function"
      ? getSpicyLyricsUseCorsProxy
      : null;
}

function shouldFetchSpicyLyricsViaCorsProxy() {
  const envFlag = String(process.env.SPICY_LYRICS_USE_CORSPROXY ?? "")
    .trim()
    .toLowerCase();
  if (["0", "false", "no", "off"].includes(envFlag)) {
    return false;
  }
  if (["1", "true", "yes", "on"].includes(envFlag)) {
    return true;
  }
  if (spicyLyricsNetworkRef.getSpicyLyricsUseCorsProxyFromBridge) {
    return (
      spicyLyricsNetworkRef.getSpicyLyricsUseCorsProxyFromBridge() === true
    );
  }
  return false;
}

function spicyDebugLog(message, meta = undefined) {
  if (!SPICY_DEBUG_ENABLED) {
    return;
  }
  if (meta === undefined) {
    console.log(`[spicy-debug] ${message}`);
    return;
  }
  console.log(`[spicy-debug] ${message}`, meta);
}

function maskTokenPreview(value) {
  const safe = String(value || "").trim();
  if (!safe) {
    return "";
  }
  const unprefixed = safe.replace(/^bearer\s+/i, "");
  if (unprefixed.length <= 10) {
    return `${unprefixed.slice(0, 2)}...${unprefixed.slice(-2)}`;
  }
  return `${unprefixed.slice(0, 6)}...${unprefixed.slice(-4)}`;
}

function sanitizeSpicyHeaders(headers = {}) {
  const entries = Object.entries(headers || {});
  const sanitized = {};
  for (const [key, value] of entries) {
    const lower = String(key || "").toLowerCase();
    if (
      lower.includes("auth") ||
      lower.includes("token") ||
      lower === "cookie"
    ) {
      sanitized[key] = maskTokenPreview(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function buildSpicyLyricsQueryVariables(spotifyTrackId) {
  return {
    id: String(spotifyTrackId || "").trim(),
    auth: "SpicyLyrics-WebAuth",
  };
}

function normalizeSpicyLyricsQueryData(data) {
  if (!data) {
    return data;
  }
  if (isSpicyObjPackPayload(data)) {
    return spicyLyricsObjPack.unpack(data);
  }
  return data;
}

function resolveSpicyResultTrackId(data) {
  if (!data) {
    return "";
  }
  if (!isSpicyObjPackPayload(data)) {
    return String(data?.id || "").trim();
  }
  try {
    return String(spicyLyricsObjPack.unpack(data)?.id || "").trim();
  } catch {
    return "";
  }
}

function computeSpicyQueueDelayMs(attempt) {
  const scaled =
    SPICY_QUEUE_BASE_DELAY_MS * SPICY_QUEUE_BACKOFF_FACTOR ** attempt;
  return Math.min(SPICY_QUEUE_MAX_DELAY_MS, Math.round(scaled));
}

function getSpicyLyricsQueryHttpStatus(
  queryResults,
  {
    expectedOperation = "lyrics",
    expectedOperationId = "0",
    expectedTrackId = "",
  } = {},
) {
  const entry = selectSpicyQueryResult(queryResults, {
    expectedOperation,
    expectedOperationId,
    expectedTrackId,
  });
  return Number(entry?.result?.httpStatus || 0);
}

function summarizeSpicyPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return {
      kind: typeof payload,
    };
  }
  if (isSpicyObjPackPayload(payload)) {
    return {
      packed: true,
      valuesLength: Array.isArray(payload[0]) ? payload[0].length : 0,
      streamLength: Array.isArray(payload[1]) ? payload[1].length : 0,
    };
  }
  return {
    type: payload.Type || "",
    id: payload.id || "",
    provider: payload.Provider || payload.ProviderDisplayName || "",
    lineCount: Array.isArray(payload.Content)
      ? payload.Content.length
      : Array.isArray(payload.Lines)
        ? payload.Lines.length
        : 0,
    hasContent: Array.isArray(payload.Content),
    hasLines: Array.isArray(payload.Lines),
    includesRomanization: Boolean(payload.IncludesRomanization),
    songwriterCount: extractSpicySongwriters(payload).length,
    hasTimedStaticLines: Array.isArray(payload.Lines)
      ? hasSpicyStaticLineTiming(payload.Lines)
      : false,
  };
}

function hasSpicyLyricsQueryPayload(result) {
  if (!result || typeof result !== "object") {
    return false;
  }
  const data = result.data;
  if (data === null || data === undefined || data === "") {
    return false;
  }
  const format = String(result.format || "").toLowerCase();
  // Static lyrics commonly return format "text"; syllable/line use "json".
  // The official Spicy client unpacks either without checking format.
  if (!format || format === "json" || format === "text") {
    return true;
  }
  return false;
}

function buildSpicyLyricsDirectUrl(path) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${SPICY_LYRICS_API_URL}${normalizedPath}`;
}

function buildSpicyLyricsFetchUrl(path) {
  const direct = buildSpicyLyricsDirectUrl(path);
  if (!shouldFetchSpicyLyricsViaCorsProxy()) {
    return direct;
  }
  return `${SPICY_LYRICS_CORSPROXY_PREFIX}${encodeURIComponent(direct)}`;
}
const SPOTIFY_PARTNER_API_URL =
  "https://api-partner.spotify.com/pathfinder/v1/query";
const SPOTIFY_WEB_ACCESS_TOKEN_URL =
  "https://open.spotify.com/get_access_token";
const SPOTIFY_PARTNER_SEARCH_DESKTOP_HASH =
  "75bbf6bfcfdf85b8fc828417bfad92b7cd66bf7f556d85670f4da8292373ebec";
const SPOTIFY_WEB_APP_PLATFORM = "WebPlayer";
const SPOTIFY_WEB_APP_VERSION = "1.2.66.447.g4e37e896";
const MUSIXMATCH_DEFAULT_BASE_URLS = [
  "https://apic-desktop.musixmatch.com/ws/1.1",
  "https://apic.musixmatch.com/ws/1.1",
  "https://www.musixmatch.com/ws/1.1",
];
const MUSIXMATCH_TOKEN_PRIORITY_KEYS = [
  "web-desktop-app-v1.0",
  "mxm-com-v1.0",
  "mxm-account-v1.0",
  "mxm-pro-web-v1.0",
];
const MUSIXMATCH_CLIENT_PROFILES = [
  {
    appId: "android-player-v1.0",
    tokenKey: "android-player-v1.0",
    userAgent: "Musixmatch/7.13.5 (Linux; Android 14) okhttp/4.12.0",
    userLanguage: "en",
    cookieHeader: "AWSELB=0; AWSELBCORS=0",
    baseUrls: [
      "https://apic-desktop.musixmatch.com/ws/1.1",
      "https://apic.musixmatch.com/ws/1.1",
    ],
  },
  {
    appId: "mac-ios-v2.0",
    tokenKey: "mac-ios-v2.0",
    userAgent:
      "Musixmatch/6.8.1 (iPhone; iOS 17.0; Scale/3.00) CFNetwork/1492.0.1 Darwin/23.0.0",
    userLanguage: "en",
    cookieHeader: "AWSELB=0; AWSELBCORS=0",
    baseUrls: [
      "https://apic.musixmatch.com/ws/1.1",
      "https://apic-desktop.musixmatch.com/ws/1.1",
    ],
  },
  {
    appId: "web-desktop-app-v1.0",
    tokenKey: "web-desktop-app-v1.0",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Musixmatch/0.19.4 Chrome/58.0.3029.110 Electron/1.7.6 Safari/537.36",
    userLanguage: "en",
    cookieHeader: "AWSELB=0; AWSELBCORS=0",
    baseUrls: [
      "https://apic-desktop.musixmatch.com/ws/1.1",
      "https://www.musixmatch.com/ws/1.1",
      "https://apic.musixmatch.com/ws/1.1",
    ],
  },
];
const MUSIXMATCH_IOS_DEBUG_CONTEXT = Object.freeze({
  appVersion: "8.2.0",
  appBuild: "2025120901",
  osVersion: "26.0.1",
  userId: "apl:000483.9ddc76a6e14646e689eac195e5d1c818.0532",
  deviceId: "3A4BBD14-0470-41C2-AB2D-F1F00BB96C2C",
  country: "en_US",
});
const MUSIXMATCH_TOKEN_FALLBACK_KEYS = ["user_token", "usertoken", "token"];
const MUSIXMATCH_KNOWN_TOKEN_KEYS = [
  "android-player-v1.0",
  "web-desktop-app-v1.0",
  "mac-ios-v2.0",
  "ios-v2.0",
  "ios-v1.0",
  "iphone-app-v1.0",
  "iphone-app-v2.0",
  "iphone-app-v3.0",
  "iphone-app-v4.0",
  "iphone-app-v5.0",
  "iphone-app-v6.0",
];
const MUSIXMATCH_SIGNATURE_FALLBACK_SECRET =
  "741941edc264ea6293cb9a6458103b4eda3ac8ed";
const MUSIXMATCH_SIGNATURE_CACHE_TTL_MS = 30 * 60 * 1000;
const MUSIXMATCH_RESULT_CACHE_TTL_MS = 25 * 60 * 1000;
const MUSIXMATCH_COOLDOWN_MS = 20 * 60 * 1000;
const MUSIXMATCH_TRANSLATION_LANGUAGE = "en";
const MUSIXMATCH_TRANSLATION_LANGUAGE_FALLBACKS = ["en", "en-US", "en-GB"];
const GEMINI_TRANSLATION_TARGET_LANGUAGE = "English";
const GEMINI_TRANSLATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const GEMINI_TRANSLATION_MAX_RETRIES = 2;
const GEMINI_TRANSLATION_RETRY_BASE_MS = 450;
const GEMINI_TRANSLATION_CHUNK_SIZE = 50;
const GEMINI_TRANSLATION_MAX_PARALLEL_CHUNKS = 3;
/** Above this unique-line count, translate in parallel chunks instead of one huge request. */
const GEMINI_TRANSLATION_PROACTIVE_CHUNK_LINES = 55;
const GEMINI_RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000;
const GEMINI_RATE_LIMIT_MAX_COOLDOWN_MS = 10 * 60 * 1000;
const GEMINI_MODEL_CANDIDATES = [
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash",
  "gemma-4-31b-it",
];
const musixmatchSignatureSecretCache = {
  value: "",
  expiresAt: 0,
};
const musixmatchRuntimeState = {
  resultCache: new Map(),
  translationCache: new Map(),
  preferredClientByTokenHash: new Map(),
  rejectedClientIdsByTokenHash: new Map(),
  cooldownUntil: 0,
  cooldownReason: "",
  lastRateLimitAt: 0,
};
const geminiRuntimeState = {
  cooldownUntil: 0,
  cooldownReason: "",
  lastRateLimitAt: 0,
};
const MUSIXMATCH_IOS_APP_ID_CANDIDATES = [
  "mac-ios-v2.0",
  "iphone-app-v8.2.0",
  "iphone-app-v8.2",
  "ios-player-v8.2.0",
  "ios-player-v8.2",
  "iphone-player-v8.2.0",
  "iphone-player-v8.2",
];
const MUSIXMATCH_RAW_TOKEN_PROFILE_PRIORITY = [
  "mac-ios-v2.0",
  "android-player-v1.0",
  "web-desktop-app-v1.0",
];

function cleanupExpiredMusixmatchResultCache(now = Date.now()) {
  for (const [key, entry] of musixmatchRuntimeState.resultCache.entries()) {
    if (!entry || Number(entry.expiresAt || 0) <= now) {
      musixmatchRuntimeState.resultCache.delete(key);
    }
  }
  for (const [
    key,
    entry,
  ] of musixmatchRuntimeState.translationCache.entries()) {
    if (!entry || Number(entry.expiresAt || 0) <= now) {
      musixmatchRuntimeState.translationCache.delete(key);
    }
  }
}

function getMusixmatchTokenHash(rawToken) {
  const safe = String(rawToken || "").trim();
  if (!safe) {
    return "none";
  }
  return crypto.createHash("sha1").update(safe).digest("hex").slice(0, 12);
}

function buildMusixmatchCacheKey(track, rawToken) {
  const title = normalizeCoreTitle(track?.title || "");
  const artist = normalizeText(track?.artist || "");
  const album = normalizeCoreTitle(track?.album || "");
  const durationBucket =
    Number(track?.durationMs || 0) > 0
      ? Math.round(Number(track.durationMs) / 1000)
      : 0;
  const tokenHash = getMusixmatchTokenHash(rawToken);
  return [title, artist, album, durationBucket, tokenHash].join("|");
}

function getMusixmatchCachedResult(track, rawToken) {
  cleanupExpiredMusixmatchResultCache();
  const key = buildMusixmatchCacheKey(track, rawToken);
  const entry = musixmatchRuntimeState.resultCache.get(key);
  if (!entry || !entry.result) {
    return null;
  }
  return {
    ...entry.result,
    source: `${entry.result.source}|cache`,
    metadata: entry.result.metadata || {},
  };
}

function setMusixmatchCachedResult(track, rawToken, result) {
  if (!result?.lyrics?.length) {
    return;
  }
  cleanupExpiredMusixmatchResultCache();
  const key = buildMusixmatchCacheKey(track, rawToken);
  musixmatchRuntimeState.resultCache.set(key, {
    expiresAt: Date.now() + MUSIXMATCH_RESULT_CACHE_TTL_MS,
    result: {
      lyrics: Array.isArray(result.lyrics) ? result.lyrics : [],
      source: String(result.source || "musixmatch"),
      metadata: result.metadata || {},
    },
  });
}

function buildMusixmatchTranslationCacheKey(track, rawToken, language = "en") {
  return `${buildMusixmatchCacheKey(track, rawToken)}|translation|${String(
    language || "en",
  )
    .trim()
    .toLowerCase()}`;
}

function getMusixmatchCachedTranslations(track, rawToken, language = "en") {
  cleanupExpiredMusixmatchResultCache();
  const key = buildMusixmatchTranslationCacheKey(track, rawToken, language);
  const entry = musixmatchRuntimeState.translationCache.get(key);
  return Array.isArray(entry?.translations) ? entry.translations : [];
}

function setMusixmatchCachedTranslations(
  track,
  rawToken,
  language,
  translations,
) {
  if (!Array.isArray(translations)) {
    return;
  }
  cleanupExpiredMusixmatchResultCache();
  const key = buildMusixmatchTranslationCacheKey(track, rawToken, language);
  musixmatchRuntimeState.translationCache.set(key, {
    expiresAt: Date.now() + MUSIXMATCH_RESULT_CACHE_TTL_MS,
    translations,
  });
}

function rememberMusixmatchPreferredClient(rawToken, appId) {
  const tokenHash = getMusixmatchTokenHash(rawToken);
  const safeAppId = String(appId || "").trim();
  if (!tokenHash || tokenHash === "none" || !safeAppId) {
    return;
  }
  musixmatchRuntimeState.preferredClientByTokenHash.set(tokenHash, safeAppId);
}

function prioritizeMusixmatchClientCandidates(clientCandidates, rawToken) {
  const candidates = Array.isArray(clientCandidates)
    ? [...clientCandidates]
    : [];
  if (!candidates.length) {
    return [];
  }
  const tokenHash = getMusixmatchTokenHash(rawToken);
  const preferredAppId =
    musixmatchRuntimeState.preferredClientByTokenHash.get(tokenHash);
  const rejectedAppIds =
    musixmatchRuntimeState.rejectedClientIdsByTokenHash.get(tokenHash) ||
    new Set();
  const rankedCandidates = candidates.filter(
    (candidate) => !rejectedAppIds.has(String(candidate?.appId || "")),
  );
  const usableCandidates = rankedCandidates.length
    ? rankedCandidates
    : candidates;
  if (!preferredAppId) {
    return usableCandidates;
  }
  const preferred = [];
  const rest = [];
  for (const candidate of usableCandidates) {
    if (String(candidate?.appId || "") === preferredAppId) {
      preferred.push(candidate);
    } else {
      rest.push(candidate);
    }
  }
  return [...preferred, ...rest];
}

function activateMusixmatchCooldown(reason = "captcha") {
  musixmatchRuntimeState.cooldownUntil = Date.now() + MUSIXMATCH_COOLDOWN_MS;
  musixmatchRuntimeState.cooldownReason = String(reason || "captcha");
  musixmatchRuntimeState.lastRateLimitAt = Date.now();
}

function rememberMusixmatchRejectedClient(rawToken, appId) {
  const tokenHash = getMusixmatchTokenHash(rawToken);
  const safeAppId = String(appId || "").trim();
  if (!tokenHash || tokenHash === "none" || !safeAppId) {
    return;
  }
  const rejected =
    musixmatchRuntimeState.rejectedClientIdsByTokenHash.get(tokenHash) ||
    new Set();
  rejected.add(safeAppId);
  musixmatchRuntimeState.rejectedClientIdsByTokenHash.set(tokenHash, rejected);
  if (
    musixmatchRuntimeState.preferredClientByTokenHash.get(tokenHash) ===
    safeAppId
  ) {
    musixmatchRuntimeState.preferredClientByTokenHash.delete(tokenHash);
  }
}

function clearMusixmatchCooldownIfExpired() {
  if (musixmatchRuntimeState.cooldownUntil > Date.now()) {
    return;
  }
  musixmatchRuntimeState.cooldownUntil = 0;
  musixmatchRuntimeState.cooldownReason = "";
}

function getMusixmatchCooldownInfo() {
  clearMusixmatchCooldownIfExpired();
  const remainingMs = Math.max(
    0,
    musixmatchRuntimeState.cooldownUntil - Date.now(),
  );
  return {
    active: remainingMs > 0,
    remainingMs,
    reason: musixmatchRuntimeState.cooldownReason || "",
    startedAt: musixmatchRuntimeState.lastRateLimitAt || 0,
  };
}

function clearMusixmatchRuntimeState() {
  musixmatchRuntimeState.resultCache.clear();
  musixmatchRuntimeState.translationCache.clear();
  musixmatchRuntimeState.preferredClientByTokenHash.clear();
  musixmatchRuntimeState.rejectedClientIdsByTokenHash.clear();
  musixmatchRuntimeState.cooldownUntil = 0;
  musixmatchRuntimeState.cooldownReason = "";
  musixmatchRuntimeState.lastRateLimitAt = 0;
}

function activateGeminiCooldown(reason = "http-429", cooldownMs = 0) {
  const safeMs = Number.isFinite(Number(cooldownMs))
    ? Math.max(0, Math.floor(Number(cooldownMs)))
    : 0;
  const boundedMs = Math.min(
    GEMINI_RATE_LIMIT_MAX_COOLDOWN_MS,
    safeMs || GEMINI_RATE_LIMIT_COOLDOWN_MS,
  );
  geminiRuntimeState.cooldownUntil = Date.now() + boundedMs;
  geminiRuntimeState.cooldownReason = String(reason || "http-429");
  geminiRuntimeState.lastRateLimitAt = Date.now();
}

function clearGeminiCooldownIfExpired() {
  if (geminiRuntimeState.cooldownUntil > Date.now()) {
    return;
  }
  geminiRuntimeState.cooldownUntil = 0;
  geminiRuntimeState.cooldownReason = "";
}

function getGeminiCooldownInfo() {
  clearGeminiCooldownIfExpired();
  const remainingMs = Math.max(
    0,
    geminiRuntimeState.cooldownUntil - Date.now(),
  );
  return {
    active: remainingMs > 0,
    remainingMs,
    reason: geminiRuntimeState.cooldownReason || "",
    startedAt: geminiRuntimeState.lastRateLimitAt || 0,
  };
}

function isGeminiTranslationRateLimitedMessage(message = "") {
  const lowerMessage = String(message || "").toLowerCase();
  return (
    lowerMessage.includes("openrouter 429") ||
    lowerMessage.includes("openrouter 503") ||
    lowerMessage.includes("gemini 429") ||
    lowerMessage.includes("gemini 503") ||
    lowerMessage.includes("http 429") ||
    lowerMessage.includes("http 503") ||
    lowerMessage.includes("resource_exhausted") ||
    lowerMessage.includes("temporarily rate-limited") ||
    lowerMessage.includes("rate limit") ||
    lowerMessage.includes("service unavailable")
  );
}

async function fetchJsososoWithFallback(path, options = {}, retryOptions = {}) {
  let lastError = null;
  for (const baseUrl of JSOSOSO_BASE_URLS) {
    try {
      return await fetchJsonWithRetry(
        `${baseUrl}${path}`,
        options,
        retryOptions,
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("All jsososo endpoints failed");
}

async function fetchText(url, { headers = {}, timeoutMs = 8_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: makeMobileSafeHeaders({
        Accept: "application/json,text/plain,*/*",
        "User-Agent": "KineSyncDesktopBridge/1.0",
        ...headers,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

function buildUrlWithParams(url, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && `${value}`.length > 0) {
      query.set(key, String(value));
    }
  }
  const queryString = query.toString();
  return queryString ? `${url}?${queryString}` : url;
}

function buildMusixmatchUrlWithParams(url, params = {}) {
  const queryParts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || `${value}`.length === 0) {
      continue;
    }
    queryParts.push(
      `${encodeURIComponent(String(key))}=${encodeURIComponent(String(value))}`,
    );
  }
  return queryParts.length ? `${url}?${queryParts.join("&")}` : url;
}

async function fetchJsonFromAnyEndpoint(
  endpoints,
  { params = {}, headers = {}, timeoutMs = 8_000 } = {},
) {
  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      return await fetchJson(endpoint, { params, headers, timeoutMs });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("All endpoint attempts failed");
}

async function fetchTextFromAnyEndpoint(
  endpoints,
  { params = {}, headers = {}, timeoutMs = 8_000 } = {},
) {
  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      return await fetchText(buildUrlWithParams(endpoint, params), {
        headers,
        timeoutMs,
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("All endpoint attempts failed");
}

async function fetchJsonPost(
  url,
  body,
  { headers = {}, timeoutMs = 10_000 } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: makeMobileSafeHeaders({
        "Content-Type": "application/json",
        ...headers,
      }),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      const retrySuffix = retryAfter ? ` (retry-after=${retryAfter})` : "";
      throw new Error(`HTTP ${response.status}${retrySuffix}`);
    }
    const text = await response.text();
    return parseJsonLenient(text);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonPostFromAnyEndpoint(
  endpoints,
  body,
  { headers = {}, timeoutMs = 10_000 } = {},
) {
  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      return await fetchJsonPost(endpoint, body, { headers, timeoutMs });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("All endpoint attempts failed");
}

async function fetchNeteaseJson(
  path,
  { params = {}, timeoutMs = 10_000 } = {},
) {
  let lastError = null;
  for (const baseUrl of NETEASE_BASE_URLS) {
    try {
      return await fetchJsonWithRetry(
        `${baseUrl}${path}`,
        {
          params,
          timeoutMs,
          headers: {
            Accept: "application/json",
            Referer: "https://music.163.com/",
            Origin: "https://music.163.com",
            "User-Agent":
              "KineSyncDesktopBridge/1.0 (+https://github.com)",
          },
        },
        { attempts: 3, backoffMs: 450 },
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("All Netease endpoints failed");
}

async function fetchNeteaseDirectApiJson(
  path,
  params,
  { timeoutMs = 10_000 } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null) body.set(key, String(value));
    }
    const response = await fetch(`${NETEASE_DIRECT_API_URL}${path}`, {
      method: "POST",
      headers: makeMobileSafeHeaders({
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Referer: "https://music.163.com/",
        Origin: "https://music.163.com",
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 KineSync/1.0",
      }),
      body: body.toString(),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Netease direct API HTTP ${response.status}`);
    }
    return parseJsonLenient(await response.text());
  } finally {
    clearTimeout(timer);
  }
}

async function fetchNeteaseSearchJson(query, { timeoutMs = 10_000 } = {}) {
  try {
    return await fetchNeteaseJson("/search", {
      params: { keywords: query, type: 1, limit: 30 },
      timeoutMs,
    });
  } catch {
    return fetchNeteaseDirectApiJson(
      "/api/search/get",
      { s: query, type: 1, limit: 30, offset: 0 },
      { timeoutMs },
    );
  }
}

async function fetchNeteaseLyricsJson(songId, { timeoutMs = 10_000 } = {}) {
  try {
    return await fetchNeteaseJson("/lyric/new", {
      params: { id: songId },
      timeoutMs,
    });
  } catch {
    return fetchNeteaseDirectApiJson(
      "/api/song/lyric/v1",
      { id: songId, cp: false, tv: 0, lv: 0, rv: 0, kv: 0, yv: 0, ytv: 0, yrv: 0 },
      { timeoutMs },
    );
  }
}

function parseSpotifyWebTokenInput(rawToken) {
  const trimmed = String(rawToken || "").trim();
  if (!trimmed) {
    return { mode: "missing", value: "", cookieHeader: "" };
  }
  const bearerMatch = trimmed.match(/^(?:authorization:\s*)?bearer\s+(.+)$/i);
  if (bearerMatch?.[1]) {
    return {
      mode: "access-token",
      value: bearerMatch[1].trim(),
      cookieHeader: "",
    };
  }
  if (/^BQ[A-Za-z0-9_-]{20,}$/.test(trimmed)) {
    return {
      mode: "access-token",
      value: trimmed,
      cookieHeader: "",
    };
  }
  if (/sp_dc=/.test(trimmed)) {
    const cookieParts = trimmed
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean);
    return {
      mode: "cookie",
      value: trimmed,
      cookieHeader: cookieParts.join("; "),
    };
  }
  if (/^[A-Za-z0-9-_]{40,}$/.test(trimmed) && !trimmed.includes(".")) {
    return {
      mode: "cookie",
      value: trimmed,
      cookieHeader: `sp_dc=${trimmed}`,
    };
  }
  return {
    mode: "access-token",
    value: trimmed,
    cookieHeader: "",
  };
}

async function getSpotifyWebAccessToken(rawToken) {
  const parsed = parseSpotifyWebTokenInput(rawToken);
  if (parsed.mode === "missing") {
    throw new Error(
      "Missing Spotify web token. Paste a Spotify bearer token or sp_dc cookie value in desktop bridge settings.",
    );
  }
  if (parsed.mode === "access-token") {
    return parsed.value;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let response = null;
  try {
    response = await fetch(
      buildUrlWithParams(SPOTIFY_WEB_ACCESS_TOKEN_URL, {
        reason: "transport",
        productType: "web_player",
      }),
      {
        method: "GET",
        headers: makeMobileSafeHeaders({
          Accept: "application/json,text/plain,*/*",
          Cookie: parsed.cookieHeader,
          Referer: "https://open.spotify.com/",
          Origin: "https://open.spotify.com",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36",
        }),
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(timer);
  }
  const rawBody = await response.text();
  if (!response.ok) {
    const normalizedBody = String(rawBody || "").toLowerCase();
    if (
      response.status === 403 &&
      (normalizedBody.includes("url blocked") ||
        normalizedBody.includes("error 54113"))
    ) {
      throw new Error(
        "Spotify web token exchange URL Blocked (HTTP 403, Error 54113).",
      );
    }
    if (response.status === 429) {
      throw new Error("Spotify web token exchange HTTP 429.");
    }
    throw new Error(`Spotify web token exchange HTTP ${response.status}.`);
  }
  const payload = parseJsonLenient(rawBody);
  const accessToken = String(
    payload?.accessToken || payload?.access_token || "",
  ).trim();
  if (!accessToken) {
    throw new Error(
      "Spotify web token exchange did not return an access token.",
    );
  }
  return accessToken;
}

async function resolveSpicyLyricsClientVersion() {
  const now = Date.now();
  if (
    spicyLyricsClientVersionCache.value &&
    spicyLyricsClientVersionCache.expiresAt > now
  ) {
    return spicyLyricsClientVersionCache.value;
  }
  if (spicyLyricsClientVersionCache.promise) {
    return spicyLyricsClientVersionCache.promise;
  }

  const promise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(buildSpicyLyricsDirectUrl("/version"), {
        method: "GET",
        headers: makeSpicyLyricsHeaders({
          Accept: "text/plain,*/*",
          Origin: "https://xpui.app.spotify.com",
          Referer: "https://xpui.app.spotify.com/",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.179 Spotify/1.2.94.583 Safari/537.36",
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Spicy version HTTP ${response.status}.`);
      }
      const version = String(await response.text()).trim();
      if (!/^\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?$/.test(version)) {
        throw new Error("Spicy version endpoint returned an invalid version.");
      }
      spicyLyricsClientVersionCache.value = version;
      spicyLyricsClientVersionCache.expiresAt =
        Date.now() + SPICY_LYRICS_VERSION_CACHE_TTL_MS;
      return version;
    } catch (error) {
      spicyDebugLog("Spicy /version lookup failed; using fallback", {
        fallbackVersion: SPICY_LYRICS_CLIENT_VERSION,
        error: error instanceof Error ? error.message : String(error),
      });
      spicyLyricsClientVersionCache.value = SPICY_LYRICS_CLIENT_VERSION;
      spicyLyricsClientVersionCache.expiresAt =
        Date.now() + SPICY_LYRICS_VERSION_FAILURE_CACHE_TTL_MS;
      return SPICY_LYRICS_CLIENT_VERSION;
    } finally {
      clearTimeout(timer);
      spicyLyricsClientVersionCache.promise = null;
    }
  })();

  spicyLyricsClientVersionCache.promise = promise;
  return promise;
}
async function fetchSpicyLyricsQuery(queries, headers = {}) {
  const version = await resolveSpicyLyricsClientVersion();
  const body = JSON.stringify({
    queries,
    client: {
      version,
    },
  });
  const baseHeaders = {
    Accept: "*/*",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-Latn-US,en-US;q=0.9,en-Latn;q=0.8,en;q=0.7",
    "Content-Type": "application/json",
    "SpicyLyrics-Version": version,
    "X-Mode": "2",
    Origin: "https://xpui.app.spotify.com",
    Referer: "https://xpui.app.spotify.com/",
    Priority: "u=1, i",
    "Sec-CH-UA": '"Not-A.Brand";v="24", "Chromium";v="146"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "cross-site",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.179 Spotify/1.2.94.583 Safari/537.36",
    ...headers,
  };

  const doPost = async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      return await fetch(url, {
        method: "POST",
        headers: makeSpicyLyricsHeaders(baseHeaders),
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  const primaryUrl = buildSpicyLyricsFetchUrl("/query");
  const directUrl = buildSpicyLyricsDirectUrl("/query");
  const primaryWasProxied = primaryUrl !== directUrl;

  spicyDebugLog("Spicy /query request", {
    version,
    primaryUrl,
    directUrl,
    primaryWasProxied,
    headers: sanitizeSpicyHeaders(baseHeaders),
    queryJsonPreview: JSON.stringify(
      Array.isArray(queries)
        ? queries.map((query) => ({
            operation: String(query?.operation || ""),
            variables: query?.variables || {},
          }))
        : [],
    ),
    queryCount: Array.isArray(queries) ? queries.length : 0,
    queryOperations: Array.isArray(queries)
      ? queries.map((query) => ({
          operation: String(query?.operation || ""),
          variables: query?.variables || {},
        }))
      : [],
  });

  let response = await doPost(primaryUrl);
  spicyDebugLog("Spicy /query response received", {
    url: primaryUrl,
    status: response.status,
    retryAfter: response.headers.get("retry-after") || "",
    contentType: response.headers.get("content-type") || "",
    server: response.headers.get("server") || "",
  });
  if (
    !response.ok &&
    primaryWasProxied &&
    SPICY_PROXY_FALLBACK_STATUSES.has(response.status)
  ) {
    spicyDebugLog("Spicy /query retrying direct after proxied failure", {
      proxiedStatus: response.status,
      directUrl,
    });
    response = await doPost(directUrl);
    spicyDebugLog("Spicy /query direct retry response received", {
      url: directUrl,
      status: response.status,
      retryAfter: response.headers.get("retry-after") || "",
      contentType: response.headers.get("content-type") || "",
      server: response.headers.get("server") || "",
    });
  }

  let attempt = 0;
  while (
    !response.ok &&
    response.status === 429 &&
    attempt < SPICY_DIRECT_429_MAX_RETRIES
  ) {
    const headerSec = Number(response.headers.get("retry-after") || 0);
    const headerMs =
      Number.isFinite(headerSec) && headerSec > 0 ? headerSec * 1000 : 0;
    const backoffMs = SPICY_DIRECT_429_BASE_DELAY_MS * (attempt + 1);
    const delayMs = Math.min(
      45_000,
      Math.max(backoffMs, headerMs || backoffMs),
    );
    spicyDebugLog("Spicy /query backing off after 429", {
      attempt: attempt + 1,
      status: response.status,
      retryAfterHeader: response.headers.get("retry-after") || "",
      delayMs,
      directUrl,
    });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    response = await doPost(directUrl);
    spicyDebugLog("Spicy /query retry response received", {
      attempt: attempt + 1,
      status: response.status,
      retryAfter: response.headers.get("retry-after") || "",
      contentType: response.headers.get("content-type") || "",
      server: response.headers.get("server") || "",
    });
    attempt += 1;
  }

  if (!response.ok) {
    const hint =
      primaryWasProxied && response.status === 429
        ? " (corsproxy.io often returns 429 for POST; leave Spicy proxy off in the bridge for desktop.)"
        : "";
    throw new Error(`HTTP ${response.status}${hint}`);
  }

  const rawText = await response.text();
  const payload = parseJsonLenient(rawText);
  const returnedQueries = Array.isArray(payload?.queries)
    ? payload.queries
    : [];
  spicyDebugLog("Spicy /query payload summary", {
    returnedQueryCount: returnedQueries.length,
    payloadKeys:
      payload && typeof payload === "object"
        ? Object.keys(payload).slice(0, 12)
        : [],
    firstQueryOperationId: String(returnedQueries[0]?.operationId ?? ""),
    firstQueryStatus: Number(returnedQueries[0]?.result?.httpStatus || 0),
    firstQueryFormat: String(returnedQueries[0]?.result?.format || ""),
    firstQueryData: summarizeSpicyPayload(returnedQueries[0]?.result?.data),
    rawPreview: String(rawText || "").slice(0, 500),
  });
  return returnedQueries.map((entry, index) => ({
    operation: String(entry?.operation || ""),
    operationId: String(entry?.operationId ?? index),
    result: entry?.result || null,
  }));
}

async function fetchSpicyLyricsQueryWithQueueRetry(
  queries,
  headers = {},
  {
    expectedOperation = "lyrics",
    expectedOperationId = "0",
    expectedTrackId = "",
    maxAttempts = SPICY_QUEUE_MAX_ATTEMPTS,
    maxWaitMs = SPICY_QUEUE_MAX_WAIT_MS,
    signal = null,
  } = {},
) {
  let attempt = 0;
  let lastResults = null;
  const startedAt = Date.now();
  while (
    attempt < maxAttempts &&
    Date.now() - startedAt < Math.max(5_000, Number(maxWaitMs) || 0)
  ) {
    lastResults = await fetchSpicyLyricsQuery(queries, headers);
    const status = getSpicyLyricsQueryHttpStatus(lastResults, {
      expectedOperation,
      expectedOperationId,
      expectedTrackId,
    });
    if (status !== 503) {
      if (attempt > 0) {
        spicyDebugLog("Spicy /query queue resolved", {
          attempt,
          status,
          waitedMs: Date.now() - startedAt,
        });
      }
      return lastResults;
    }

    const delayMs = computeSpicyQueueDelayMs(attempt);
    attempt += 1;
    spicyDebugLog("Spicy /query queued (HTTP 503), retrying", {
      attempt,
      delayMs,
      maxAttempts,
      waitedMs: Date.now() - startedAt,
      maxWaitMs,
      expectedTrackId: String(expectedTrackId || ""),
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      if (!signal) {
        return;
      }
      if (signal.aborted) {
        clearTimeout(timer);
        reject(signal.reason || new Error("Spicy queue retry aborted"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason || new Error("Spicy queue retry aborted"));
        },
        { once: true },
      );
    });
  }
  spicyDebugLog("Spicy /query queue wait exhausted", {
    attempt,
    waitedMs: Date.now() - startedAt,
    maxWaitMs,
    maxAttempts,
    expectedTrackId: String(expectedTrackId || ""),
    lastStatus: getSpicyLyricsQueryHttpStatus(lastResults, {
      expectedOperation,
      expectedOperationId,
      expectedTrackId,
    }),
  });
  return lastResults;
}

function selectSpicyQueryResult(
  queryResults,
  {
    expectedOperation = "",
    expectedOperationId = "",
    expectedTrackId = "",
  } = {},
) {
  const entries = Array.isArray(queryResults) ? queryResults : [];
  if (!entries.length) {
    return null;
  }

  const normalizedOperation = String(expectedOperation || "")
    .trim()
    .toLowerCase();
  const normalizedOperationId = String(expectedOperationId || "").trim();
  const normalizedTrackId = String(expectedTrackId || "").trim();

  const hasResult = (entry) => Boolean(entry?.result);
  const matchesOperation = (entry) =>
    Boolean(normalizedOperation) &&
    String(entry?.operation || "")
      .trim()
      .toLowerCase() === normalizedOperation;
  const matchesOperationId = (entry) =>
    Boolean(normalizedOperationId) &&
    String(entry?.operationId || "").trim() === normalizedOperationId;
  const matchesTrackId = (entry) =>
    Boolean(normalizedTrackId) &&
    resolveSpicyResultTrackId(entry?.result?.data) === normalizedTrackId;

  return (
    entries.find(
      (entry) =>
        hasResult(entry) && matchesOperation(entry) && matchesTrackId(entry),
    ) ||
    entries.find(
      (entry) =>
        hasResult(entry) && matchesOperationId(entry) && matchesTrackId(entry),
    ) ||
    entries.find((entry) => hasResult(entry) && matchesOperation(entry)) ||
    entries.find((entry) => hasResult(entry) && matchesOperationId(entry)) ||
    entries.find((entry) => hasResult(entry) && matchesTrackId(entry)) ||
    entries.find((entry) => hasResult(entry)) ||
    null
  );
}

async function fetchSpotifyPartnerSearch(query, accessToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(
      buildUrlWithParams(SPOTIFY_PARTNER_API_URL, {
        operationName: "searchDesktop",
        variables: JSON.stringify({
          searchTerm: query,
          offset: 0,
          limit: 25,
          numberOfTopResults: 10,
        }),
        extensions: JSON.stringify({
          persistedQuery: {
            version: 1,
            sha256Hash: SPOTIFY_PARTNER_SEARCH_DESKTOP_HASH,
          },
        }),
      }),
      {
        method: "GET",
        headers: makeMobileSafeHeaders({
          Accept: "application/json,text/plain,*/*",
          Authorization: `Bearer ${accessToken}`,
          "app-platform": SPOTIFY_WEB_APP_PLATFORM,
          "spotify-app-version": SPOTIFY_WEB_APP_VERSION,
          Origin: "https://open.spotify.com",
          Referer: "https://open.spotify.com/",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36",
        }),
        signal: controller.signal,
      },
    );
    const rawBody = await response.text();
    if (!response.ok) {
      const normalizedBody = String(rawBody || "").toLowerCase();
      if (
        response.status === 403 &&
        (normalizedBody.includes("url blocked") ||
          normalizedBody.includes("error 54113"))
      ) {
        throw new Error(
          "Spotify partner search URL Blocked (HTTP 403, Error 54113).",
        );
      }
      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        throw new Error(
          `Spotify partner search HTTP 429${retryAfter ? ` (retry-after=${retryAfter})` : ""}.`,
        );
      }
      if (response.status === 403) {
        throw new Error(
          `Spotify partner search HTTP 403${normalizedBody ? ` (${normalizedBody.slice(0, 120)})` : ""}.`,
        );
      }
      throw new Error(`Spotify partner search HTTP ${response.status}.`);
    }
    return parseJsonLenient(rawBody);
  } finally {
    clearTimeout(timer);
  }
}

async function searchSpotifyTrackCandidates(track, accessToken) {
  const queryVariants = buildQueryVariants(track).slice(0, MAX_QUERY_VARIANTS);
  const seenIds = new Set();
  const matches = [];
  let lastError = null;
  for (const query of queryVariants) {
    try {
      const payload = await fetchSpotifyPartnerSearch(query, accessToken);
      const items = Array.isArray(payload?.data?.search?.tracks?.items)
        ? payload.data.search.tracks.items
        : Array.isArray(payload?.data?.search?.tracksV2?.items)
          ? payload.data.search.tracksV2.items
          : [];
      for (const item of items) {
        const trackItem = item?.track || item?.item?.data || item?.data || item;
        const id = String(
          trackItem?.id ||
            String(trackItem?.uri || "")
              .split(":")
              .pop() ||
            "",
        ).trim();
        if (!id || seenIds.has(id)) {
          continue;
        }
        seenIds.add(id);
        const title = String(trackItem?.name || trackItem?.title || "").trim();
        const artist = Array.isArray(trackItem?.artists?.items)
          ? trackItem.artists.items
              .map((entry) => entry?.profile?.name || entry?.name || "")
              .join(" ")
          : Array.isArray(trackItem?.artists)
            ? trackItem.artists.map((entry) => entry?.name || "").join(" ")
            : "";
        const durationMs = Number(
          trackItem?.duration?.totalMilliseconds || trackItem?.duration_ms || 0,
        );
        let score = scoreCandidate(track, title, artist);
        score += scoreDurationBonus(track, title, artist, durationMs);
        matches.push({ id, title, artist, durationMs, score });
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (!matches.length && lastError) {
    throw lastError;
  }
  const ranked = matches.sort((a, b) => b.score - a.score);
  if (!ranked.length) {
    return [];
  }
  const filtered = ranked.filter(
    (candidate) =>
      candidate.score >= MATCH_ACCEPTANCE_THRESHOLD &&
      isLikelySameTrack(
        track,
        candidate.title,
        candidate.artist,
        candidate.durationMs,
      ),
  );
  return filtered
    .slice(0, MAX_SPOTIFY_TRACK_CANDIDATES)
    .map((candidate) => candidate.id)
    .filter(Boolean);
}

function strictSpicySpotifyTitleArtistMatch(track, candidate) {
  if (!titleCoreMatchesQuery(track, candidate?.title || "")) {
    return false;
  }
  if (hasMissingFeaturedArtistHints(track?.title || "", candidate?.title || "")) {
    if (
      !featuredArtistHintsPresentInCandidate(
        track?.title || "",
        candidate?.title || "",
        candidate?.artist || "",
      )
    ) {
      return false;
    }
  }

  const requestedPrimaryArtist = normalizeText(
    getPrimaryArtistName(track?.artist || ""),
  );
  if (!requestedPrimaryArtist) {
    // If we don't know the artist, at least enforce exact core-title matching.
    return true;
  }
  const candidatePrimaryArtist = normalizeText(
    getPrimaryArtistName(candidate?.artist || ""),
  );
  if (!candidatePrimaryArtist) {
    return false;
  }

  // Windows media session often only provides the first artist; accept primary overlap.
  return (
    requestedPrimaryArtist === candidatePrimaryArtist ||
    requestedPrimaryArtist.includes(candidatePrimaryArtist) ||
    candidatePrimaryArtist.includes(requestedPrimaryArtist)
  );
}

function formatSpotifyArtistNames(artistEntries = []) {
  const names = [];
  const seen = new Set();
  for (const entry of artistEntries) {
    const name = String(entry?.name || entry?.profile?.name || "").trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) {
      continue;
    }
    seen.add(key);
    names.push(name);
  }
  return names.join(", ");
}

function formatSpotifyPartnerSearchArtists(trackItem = {}) {
  if (Array.isArray(trackItem?.artists?.items)) {
    return formatSpotifyArtistNames(trackItem.artists.items);
  }
  if (Array.isArray(trackItem?.artists)) {
    return formatSpotifyArtistNames(trackItem.artists);
  }
  return "";
}

const SPOTIFY_CATALOG_BY_ID_CACHE_TTL_MS = 5 * 60 * 1000;
const spotifyCatalogByIdCache = new Map();

async function fetchSpotifyWebApiTrackById(trackId, accessToken) {
  const safeId = String(trackId || "").trim();
  const safeToken = String(accessToken || "").trim();
  if (!safeId || !safeToken) {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(
      `https://api.spotify.com/v1/tracks/${encodeURIComponent(safeId)}`,
      {
        method: "GET",
        headers: {
          Authorization: safeToken.startsWith("Bearer ")
            ? safeToken
            : `Bearer ${safeToken}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      return null;
    }
    return response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function formatSpotifyWebApiTrackArtists(trackPayload = {}) {
  return formatSpotifyArtistNames(
    Array.isArray(trackPayload?.artists) ? trackPayload.artists : [],
  );
}

async function resolveSpotifyCatalogTrackById(spotifyTrackId, accessToken) {
  const safeId = String(spotifyTrackId || "").trim();
  const safeToken = String(accessToken || "").trim();
  if (!safeId || !safeToken) {
    return null;
  }

  const cached = spotifyCatalogByIdCache.get(safeId);
  if (
    cached &&
    Date.now() - Number(cached.cachedAt || 0) < SPOTIFY_CATALOG_BY_ID_CACHE_TTL_MS
  ) {
    return cached.data;
  }

  const webTrack = await fetchSpotifyWebApiTrackById(safeId, safeToken);
  if (!webTrack) {
    return null;
  }

  const data = {
    id: safeId,
    title: String(webTrack?.name || "").trim(),
    artist: formatSpotifyWebApiTrackArtists(webTrack),
    album: String(webTrack?.album?.name || "").trim(),
    durationMs: Number(webTrack?.duration_ms || 0),
  };
  spotifyCatalogByIdCache.set(safeId, {
    cachedAt: Date.now(),
    data,
  });
  return data;
}

async function buildLyricsMatchTrack(track, { spotifyAccessToken = "" } = {}) {
  const playbackTrack =
    track && typeof track === "object" ? { ...track } : track;
  if (!playbackTrack || typeof playbackTrack !== "object") {
    return playbackTrack;
  }

  const spotifyTrackId = String(playbackTrack.spotifyTrackId || "").trim();
  if (!spotifyTrackId) {
    return playbackTrack;
  }

  try {
    const catalog = await resolveSpotifyCatalogTrackById(
      spotifyTrackId,
      spotifyAccessToken,
    );
    return applySpotifyCatalogOverlay(playbackTrack, catalog);
  } catch {
    return playbackTrack;
  }
}

function collectSpotifyPartnerSearchMatches(track, payload, seenIds, matches) {
  const items = Array.isArray(payload?.data?.search?.tracks?.items)
    ? payload.data.search.tracks.items
    : Array.isArray(payload?.data?.search?.tracksV2?.items)
      ? payload.data.search.tracksV2.items
      : [];
  for (const item of items) {
    const trackItem = item?.track || item?.item?.data || item?.data || item;
    const id = String(
      trackItem?.id ||
        String(trackItem?.uri || "")
          .split(":")
          .pop() ||
        "",
    ).trim();
    if (!id || seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);
    const title = String(trackItem?.name || trackItem?.title || "").trim();
    const artist = formatSpotifyPartnerSearchArtists(trackItem);
    const durationMs = Number(
      trackItem?.duration?.totalMilliseconds || trackItem?.duration_ms || 0,
    );
    const album = String(
      trackItem?.album?.name ||
        trackItem?.album?.title ||
        trackItem?.albumName ||
        "",
    ).trim();
    let score = scoreCandidate(track, title, artist);
    score += scoreDurationBonus(track, title, artist, durationMs);
    matches.push({ id, title, artist, album, durationMs, score });
  }
}

function isSpotifyPartnerDurationAcceptable(track, candidateDurationMs = 0) {
  const trackDurationMs = Number(track?.durationMs || 0);
  const candidateDuration = Number(candidateDurationMs || 0);
  if (!(trackDurationMs > 0 && candidateDuration > 0)) {
    return true;
  }
  const toleranceMs = Math.max(
    8_000,
    Math.min(20_000, Math.floor(trackDurationMs * 0.08)),
  );
  return Math.abs(candidateDuration - trackDurationMs) <= toleranceMs;
}

function pickBestSpotifyPartnerCatalogMatch(track, matches) {
  const ranked = (Array.isArray(matches) ? matches : [])
    .filter((candidate) => candidate?.id)
    .sort((left, right) => right.score - left.score);
  if (!ranked.length) {
    return null;
  }

  const eligible = ranked.filter((candidate) => {
    if (!titleCoreMatchesQuery(track, candidate.title)) {
      return false;
    }
    if (hasMissingFeaturedArtistHints(track?.title || "", candidate?.title || "")) {
      if (
        !featuredArtistHintsPresentInCandidate(
          track?.title || "",
          candidate?.title || "",
          candidate?.artist || "",
        )
      ) {
        return false;
      }
    }
    if (hasExtraneousTitleWords(track?.title || "", candidate?.title || "")) {
      return false;
    }
    if (!isSpotifyPartnerDurationAcceptable(track, candidate.durationMs)) {
      return false;
    }
    if (Number(candidate.score || 0) < MATCH_ACCEPTANCE_THRESHOLD) {
      return false;
    }
    return true;
  });
  if (!eligible.length) {
    return null;
  }
  if (isAmbiguousTopMatch(eligible)) {
    return null;
  }
  return eligible[0];
}

const SPOTIFY_PARTNER_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const spotifyPartnerCatalogCache = new Map();
const spotifyPartnerCatalogInFlight = new Map();

function buildSpotifyPartnerCatalogCacheKey(track) {
  const durationBucket =
    Number(track?.durationMs || 0) > 0
      ? Math.round(Number(track.durationMs) / 1000)
      : 0;
  return [
    normalizeCoreTitle(track?.title || ""),
    normalizeText(track?.artist || ""),
    normalizeCoreTitle(track?.album || ""),
    durationBucket,
  ].join("|");
}
async function resolveSpotifyCatalogTrackViaPartnerSearch(track, accessToken) {
  const safeToken = String(accessToken || "").trim();
  if (!safeToken) {
    return null;
  }
  const safeTrack = {
    title: String(track?.title || "").trim(),
    artist: String(track?.artist || "").trim(),
    album: String(track?.album || "").trim(),
    durationMs: Number(track?.durationMs || 0),
  };
  if (!safeTrack.title) {
    return null;
  }

  const cacheKey = buildSpotifyPartnerCatalogCacheKey(safeTrack);
  const cached = spotifyPartnerCatalogCache.get(cacheKey);
  if (
    cached &&
    Date.now() - Number(cached.cachedAt || 0) < SPOTIFY_PARTNER_CATALOG_CACHE_TTL_MS
  ) {
    return cached.data ? { ...cached.data } : null;
  }
  const inFlight = spotifyPartnerCatalogInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const lookupPromise = (async () => {
    const queryVariants = buildQueryVariants(safeTrack).slice(0, MAX_QUERY_VARIANTS);
    const seenIds = new Set();
    const matches = [];
    let lastError = null;
    const searchResults = await Promise.all(
      queryVariants.map(async (query) => {
        try {
          const payload = await fetchSpotifyPartnerSearch(query, safeToken);
          return { payload, error: null };
        } catch (error) {
          return { payload: null, error };
        }
      }),
    );
    for (const result of searchResults) {
      if (result.error) {
        lastError = result.error;
        continue;
      }
      collectSpotifyPartnerSearchMatches(
        safeTrack,
        result.payload,
        seenIds,
        matches,
      );
    }
    if (!matches.length && lastError) {
      throw lastError;
    }

    const best = pickBestSpotifyPartnerCatalogMatch(safeTrack, matches);
    if (!best?.id) {
      spotifyPartnerCatalogCache.set(cacheKey, {
        cachedAt: Date.now(),
        data: null,
      });
      return null;
    }

    let title = best.title;
    let artist = best.artist;
    let album = best.album || "";
    let durationMs = best.durationMs;
    const webTrack = await fetchSpotifyWebApiTrackById(best.id, safeToken);
    if (webTrack) {
      const webArtists = formatSpotifyWebApiTrackArtists(webTrack);
      if (webArtists) {
        artist = webArtists;
      }
      title = String(webTrack?.name || title).trim();
      album = String(webTrack?.album?.name || album).trim();
      durationMs = Number(webTrack?.duration_ms || durationMs || 0);
    }

    const data = {
      id: best.id,
      title,
      artist,
      album,
      durationMs,
      score: best.score,
    };
    spotifyPartnerCatalogCache.set(cacheKey, {
      cachedAt: Date.now(),
      data,
    });
    return { ...data };
  })();

  spotifyPartnerCatalogInFlight.set(cacheKey, lookupPromise);
  try {
    return await lookupPromise;
  } finally {
    spotifyPartnerCatalogInFlight.delete(cacheKey);
  }
}
async function searchSpotifyTrackCandidatesStrictForSpicy(track, accessToken) {
  const queryVariants = buildQueryVariants(track).slice(0, MAX_QUERY_VARIANTS);
  const seenIds = new Set();
  const matches = [];
  let lastError = null;
  const searchResults = await Promise.all(
    queryVariants.map(async (query) => {
      try {
        const payload = await fetchSpotifyPartnerSearch(query, accessToken);
        return { payload, error: null };
      } catch (error) {
        return { payload: null, error };
      }
    }),
  );
  for (const result of searchResults) {
    if (result.error) {
      lastError = result.error;
      continue;
    }
    collectSpotifyPartnerSearchMatches(
      track,
      result.payload,
      seenIds,
      matches,
    );
  }
  if (!matches.length && lastError) {
    throw lastError;
  }
  const ranked = matches.sort((a, b) => b.score - a.score);
  if (!ranked.length) {
    return [];
  }

  const strict = ranked.filter((candidate) =>
    strictSpicySpotifyTitleArtistMatch(track, candidate),
  );
  if (strict.length) {
    return strict
      .slice(0, MAX_SPICY_STRICT_SPOTIFY_CANDIDATES)
      .map((candidate) => candidate.id)
      .filter(Boolean);
  }

  // No strict hit: return empty so Spicy can fail fast instead of mismatching.
  return [];
}

function scoreLyricsCoverage(lyrics, durationMs = 0) {
  if (!Array.isArray(lyrics) || !lyrics.length) {
    return -1;
  }
  const { lastTimedPointMs, coverageRatio } = getLyricsCoverageStats(
    lyrics,
    durationMs,
  );
  const safeDuration = Number(durationMs) > 0 ? Number(durationMs) : 0;
  const hasLateLyrics =
    safeDuration > 0 ? lastTimedPointMs >= safeDuration * 0.68 : true;
  const lateBonus = hasLateLyrics ? 20 : -30;
  return lyrics.length * 2 + coverageRatio * 100 + lateBonus;
}

// ---- DesktopBridge/src/lyrics/parts/03-qq-sources.js ----
// QQ Music legacy, direct musicu, jsososo mirror, open API fallback, and Meting source adapters.
// This file is evaluated by ../index.js in a shared compatibility context.
// Keep behavior changes deliberate; most code here was moved verbatim from src/lyricsService.js.

function decodeUriComponentSafe(value) {
  try {
    const decoded = decodeURIComponent(String(value || ""));
    return decoded;
  } catch {
    return String(value || "");
  }
}

function decodeQQBase64Text(value) {
  const compact = String(value || "").replace(/\s+/g, "");
  if (
    !compact ||
    compact.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)
  ) {
    return "";
  }
  try {
    const decoded = Buffer.from(compact, "base64").toString("utf8");
    if (!decoded || decoded.includes("\u0000")) {
      return "";
    }
    return decoded;
  } catch {
    return "";
  }
}


function decodeQQBase64EncryptedText(value) {
  const compact = String(value || "").replace(/\s+/g, "");
  if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    return "";
  }
  try {
    const encrypted = Buffer.from(compact, "base64");
    if (!encrypted.length || encrypted.length % 8 !== 0) {
      return "";
    }
    return qqKaraokeDecryptHex(encrypted.toString("hex"));
  } catch {
    return "";
  }
}
function looksLikeQQKaraokeLyrics(value) {
  const text = String(value || "");
  return (
    /<Lyric_\d+\b/i.test(text) ||
    /LyricContent\s*=/i.test(text) ||
    /^\s*\[(?:\d{2}:\d{2}|\d+,\d+)\]/m.test(text) ||
    /\(\d+,\d+(?:,[^)]*)?\)/.test(text)
  );
}

function decodeQQKaraokePayload(rawPayload) {
  const raw = String(rawPayload || "").trim();
  if (!raw) {
    return "";
  }
  const candidates = [];
  const seen = new Set();
  const addCandidate = (value) => {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) {
      return;
    }
    seen.add(text);
    candidates.push(text);
  };

  addCandidate(raw);
  addCandidate(decodeQQBase64Text(raw));
  addCandidate(decodeQQBase64EncryptedText(raw));

  // QQ legacy lyric_download still returns encrypted hex, while musicu with
  // crypt: 0 can return plaintext/base64 QRC. Try encrypted hex after the
  // direct candidates so plaintext QRC is not mangled before parsing.
  if (/^(?:[0-9a-f]{2})+$/i.test(raw)) {
    const decrypted = qqKaraokeDecryptHex(raw);
    addCandidate(decrypted);
    addCandidate(decodeQQBase64Text(decrypted));
  }

  let fallbackBody = "";
  for (const candidate of candidates) {
    const body = extractKaraokeBody(candidate);
    if (!body) {
      continue;
    }
    if (!fallbackBody) {
      fallbackBody = body;
    }
    if (looksLikeQQKaraokeLyrics(candidate) || looksLikeQQKaraokeLyrics(body)) {
      return body;
    }
  }
  return fallbackBody;
}
function getQqCandidateDurationMs(getSongInterval, song) {
  const interval = Number(getSongInterval(song) || 0);
  if (interval <= 0) {
    return 0;
  }
  return interval < 1_000 ? interval * 1000 : interval;
}

function filterLikelyQqRankedCandidates(
  track,
  ranked,
  getSongTitle,
  getSongArtist,
  getSongInterval,
) {
  return filterLikelySameTrackCandidates(track, ranked, {
    getTitle: (candidate) => getSongTitle(candidate.song),
    getArtist: (candidate) => getSongArtist(candidate.song),
    getDurationMs: (candidate) =>
      getQqCandidateDurationMs(getSongInterval, candidate.song),
    getScore: (candidate) => candidate.score,
  });
}

function normalizeLegacyXmlText(value) {
  const decoded = decodeUriComponentSafe(value);
  return String(decoded || "")
    .replace(/^<!\[CDATA\[/i, "")
    .replace(/\]\]>$/i, "")
    .replace(/\+/g, " ")
    .trim();
}

function extractLegacySearchSongs(xmlText) {
  const songs = [];
  const regex = /<songinfo\b[^>]*id="(\d+)"[^>]*>([\s\S]*?)<\/songinfo>/g;
  let match;
  while ((match = regex.exec(String(xmlText || ""))) !== null) {
    const songId = Number(match[1] || 0);
    const content = match[2] || "";
    const nameRaw = content.match(/<name>([\s\S]*?)<\/name>/)?.[1] || "";
    const singerRaw =
      content.match(/<singername>([\s\S]*?)<\/singername>/)?.[1] || "";
    const albumRaw =
      content.match(/<albumname>([\s\S]*?)<\/albumname>/)?.[1] || "";
    songs.push({
      songid: songId,
      songname: normalizeLegacyXmlText(nameRaw),
      singername: normalizeLegacyXmlText(singerRaw),
      albumname: normalizeLegacyXmlText(albumRaw),
    });
  }
  return songs;
}

function extractLegacyLyricFields(xmlText) {
  const cleaned = String(xmlText || "")
    .replace(/<!--/g, "")
    .replace(/-->/g, "");
  const readTag = (tag) =>
    (
      cleaned.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`))
        ?.[1] || ""
    ).trim();
  return [
    readTag("content"),
    readTag("contentts"),
    readTag("contentroma"),
  ].filter(Boolean);
}

async function fetchFromQQLegacyDownload(track) {
  const rankedSongs = [];
  for (const query of buildQueryVariants(track).slice(0, MAX_QUERY_VARIANTS)) {
    try {
      const searchXml = await fetchTextFromAnyEndpoint(
        QQ_LEGACY_SEARCH_ENDPOINTS,
        {
          params: {
            SONGNAME: query,
            SINGERNAME: track.artist,
            TYPE: "2",
            RANGE_MIN: "1",
            RANGE_MAX: "40",
          },
          timeoutMs: 12_000,
          headers: {
            Referer: "https://y.qq.com/",
            Origin: "https://y.qq.com",
          },
        },
      );
      rankedSongs.push(...extractLegacySearchSongs(searchXml));
    } catch {
      // Try next query variant.
    }
  }

  const seenSongIds = new Set();
  const ranked = rankedSongs
    .filter((song) => {
      const id = Number(song.songid || 0);
      if (!id || seenSongIds.has(id)) {
        return false;
      }
      seenSongIds.add(id);
      return true;
    })
    .map((song) => ({
      song,
      score: scoreCandidate(track, song.songname || "", song.singername || ""),
    }))
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    return null;
  }

  let best = null;
  let bestScore = -1;

  const likelyLegacyCandidates = filterLikelySameTrackCandidates(
    track,
    ranked,
    {
      getTitle: (candidate) => candidate.song.songname || "",
      getArtist: (candidate) => candidate.song.singername || "",
      getDurationMs: () => 0,
      getScore: (candidate) => candidate.score,
    },
  )
    .map((candidate) => ({
      ...candidate,
      candidateTitle: candidate.song.songname || "",
      candidateArtist: candidate.song.singername || "",
    }))
    .sort((left, right) => compareCandidateMatchQuality(track, left, right))
    .slice(0, MAX_QQ_LEGACY_CANDIDATES);

  let bestLegacySelection = null;

  for (const candidate of likelyLegacyCandidates) {
    if (!candidate.song.songid) {
      continue;
    }
    try {
      const xml = await fetchTextFromAnyEndpoint(QQ_LEGACY_DOWNLOAD_ENDPOINTS, {
        params: {
          version: "15",
          miniversion: "82",
          lrctype: "4",
          musicid: String(candidate.song.songid),
        },
        timeoutMs: 12_000,
        headers: {
          Referer: "https://y.qq.com/",
          Origin: "https://y.qq.com",
        },
      });
      const fields = extractLegacyLyricFields(xml);
      for (const encryptedHex of fields) {
        const karaokeBody = decodeQQKaraokePayload(encryptedHex);
        if (!karaokeBody) {
          continue;
        }
        const lyrics = parseLrc(karaokeBody);
        if (!lyrics.length) {
          continue;
        }
        const coverage = scoreLyricsCoverage(lyrics, track.durationMs);
        const selection = {
          title: candidate.song.songname || "",
          artist: candidate.song.singername || "",
          durationMs: 0,
          searchScore: candidate.score,
        };
        if (
          !bestLegacySelection ||
          shouldPreferLyricsCandidate(
            track,
            bestLegacySelection,
            selection,
            bestScore,
            coverage,
          )
        ) {
          bestLegacySelection = selection;
          bestScore = coverage;
          best = { lyrics, source: "qq-legacy-lyric_download-qrc" };
        }
      }
    } catch {
      // Try next legacy candidate.
    }
  }

  return best;
}

async function fetchQQDesktopSearchSongs(query) {
  const body = {
    comm: {
      cv: 4747474,
      ct: 24,
      format: "json",
      inCharset: "utf-8",
      outCharset: "utf-8",
      platform: "yqq.json",
      needNewCode: 1,
    },
    "music.search.SearchCgiService": {
      method: "DoSearchForQQMusicDesktop",
      module: "music.search.SearchCgiService",
      param: {
        query,
        page_num: 1,
        num_per_page: 30,
        search_type: 0,
      },
    },
  };

  const payload = await fetchJsonPostFromAnyEndpoint(
    QQ_MUSICU_ENDPOINTS,
    body,
    {
      timeoutMs: 10_000,
      headers: {
        Referer: "https://y.qq.com/",
        Origin: "https://y.qq.com",
      },
    },
  );
  const list =
    payload?.["music.search.SearchCgiService"]?.data?.body?.song?.list ||
    payload?.["music.search.SearchCgiService"]?.data?.song?.list ||
    [];
  return Array.isArray(list) ? list : [];
}

function createQQDirectSongAccessors() {
  const getSongMid = (song) =>
    song?.songmid || song?.mid || song?.track_mid || "";
  const getSongId = (song) =>
    Number(song?.songid || song?.id || song?.track_id || 0);
  const getSongTitle = (song) =>
    song?.songname || song?.name || song?.title || "";
  const getSongArtist = (song) => {
    if (Array.isArray(song?.singer)) {
      return song.singer.map((s) => s?.name || "").join(" ");
    }
    return song?.singer_name || song?.singer || song?.artist || "";
  };
  const getSongInterval = (song) => Number(song?.interval || song?.duration || 0);
  return { getSongMid, getSongId, getSongTitle, getSongArtist, getSongInterval };
}

async function collectQQSongsFromDesktopSearch(queryVariants) {
  const desktopSongs = [];
  await Promise.all(
    queryVariants.map(async (query) => {
      try {
        desktopSongs.push(...(await fetchQQDesktopSearchSongs(query)));
      } catch {
        // Try next query variant.
      }
    }),
  );
  return desktopSongs;
}

async function collectQQSongsFromLegacyClientSearch(queryVariants) {
  const legacySongs = [];
  await Promise.all(
    queryVariants.map(async (query) => {
      try {
        const searchData = await fetchJsonFromAnyEndpoint(QQ_SEARCH_ENDPOINTS, {
          params: { p: 1, n: 60, w: query, format: "json" },
          timeoutMs: 8_000,
          headers: {
            Referer: "https://y.qq.com/",
            Origin: "https://y.qq.com",
          },
        });
        const searchSongs =
          searchData?.data?.song?.list || searchData?.data?.list || [];
        legacySongs.push(...(Array.isArray(searchSongs) ? searchSongs : []));
      } catch {
        // Try next query variant.
      }
    }),
  );
  return legacySongs;
}

function rankQQDirectSearchSongs(track, songs, accessors) {
  const { getSongMid, getSongTitle, getSongArtist, getSongInterval } = accessors;
  const seen = new Set();
  const deduped = songs.filter((song) => {
    const mid = getSongMid(song);
    if (!mid || seen.has(mid)) {
      return false;
    }
    seen.add(mid);
    return true;
  });

  return deduped
    .map((song) => {
      const title = getSongTitle(song);
      const artist = getSongArtist(song);
      let score = scoreCandidate(track, title, artist);
      const interval = getSongInterval(song);
      const candidateDurationMs =
        interval > 0 ? (interval < 1_000 ? interval * 1000 : interval) : 0;
      score += scoreDurationBonus(track, title, artist, candidateDurationMs);
      return { song, score };
    })
    .sort((a, b) => b.score - a.score);
}

function qqDirectSearchNeedsLegacySupplement(track, ranked, accessors) {
  const { getSongTitle, getSongArtist, getSongInterval } = accessors;
  if (!ranked.length) {
    return true;
  }
  if (isAmbiguousTopMatch(ranked)) {
    return true;
  }
  const likelyCandidates = filterLikelyQqRankedCandidates(
    track,
    ranked,
    getSongTitle,
    getSongArtist,
    getSongInterval,
  );
  if (!likelyCandidates.length) {
    return true;
  }
  const topScore = Number(ranked[0]?.score || 0);
  if (topScore < MATCH_ACCEPTANCE_THRESHOLD) {
    return true;
  }
  if (
    trackNeedsFeaturedVariantVerification(track) &&
    topScore < MATCH_CONFIDENCE_SCORE
  ) {
    return true;
  }
  return false;
}

async function mapWithConcurrency(items, limit, mapper) {
  if (!Array.isArray(items) || !items.length) {
    return [];
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;
  const runWorker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: workerCount }, () => runWorker()),
  );
  return results;
}

async function searchQQDirectSongPool(track) {
  const accessors = createQQDirectSongAccessors();
  const allQueryVariants = buildQueryVariants(track).slice(0, MAX_QUERY_VARIANTS);
  let songs = [];

  if (trackNeedsFeaturedVariantVerification(track)) {
    const [desktopSongs, legacySongs] = await Promise.all([
      collectQQSongsFromDesktopSearch(allQueryVariants),
      collectQQSongsFromLegacyClientSearch(allQueryVariants),
    ]);
    songs = [...desktopSongs, ...legacySongs];
  } else {
    songs = await collectQQSongsFromDesktopSearch(allQueryVariants.slice(0, 1));
    let ranked = rankQQDirectSearchSongs(track, songs, accessors);
    if (qqDirectSearchNeedsLegacySupplement(track, ranked, accessors)) {
      const [desktopSongs, legacySongs] = await Promise.all([
        collectQQSongsFromDesktopSearch(allQueryVariants),
        collectQQSongsFromLegacyClientSearch(allQueryVariants),
      ]);
      songs = [...desktopSongs, ...legacySongs];
    }
  }

  const ranked = rankQQDirectSearchSongs(track, songs, accessors);
  return { ranked, accessors };
}

async function resolveQQLegacyDownloadFallback(track) {
  try {
    return await fetchFromQQLegacyDownload(track);
  } catch {
    return null;
  }
}

function createQQDirectAggregateState(track, seededKaraokeResult = null) {
  const seededKaraokeCoverageScore = seededKaraokeResult?.lyrics?.length
    ? scoreLyricsCoverage(seededKaraokeResult.lyrics, track.durationMs)
    : -1;
  const seededSelection = seededKaraokeResult?.lyrics?.length
    ? {
        title: track.title,
        artist: track.artist,
        durationMs: track.durationMs,
        searchScore: MATCH_CONFIDENCE_SCORE,
      }
    : null;
  return {
    bestResult: seededKaraokeResult,
    bestCoverageScore: seededKaraokeCoverageScore,
    bestSelection: seededSelection,
    bestKaraokeResult: seededKaraokeResult,
    bestKaraokeCoverageScore: seededKaraokeCoverageScore,
    bestKaraokeSelection: seededSelection,
  };
}

function applyQQDirectCandidateProbe(track, state, candidate, probe) {
  if (!probe) {
    return;
  }
  const { selection, karaokeResult, directResult } = probe;
  if (karaokeResult?.lyrics?.length) {
    if (
      !state.bestSelection ||
      shouldPreferLyricsCandidate(
        track,
        state.bestSelection,
        selection,
        state.bestCoverageScore,
        karaokeResult.coverage,
      )
    ) {
      state.bestSelection = selection;
      state.bestCoverageScore = karaokeResult.coverage;
      state.bestResult = {
        lyrics: karaokeResult.lyrics,
        source: "qq-musicu-qrc",
      };
    }
    if (
      !state.bestKaraokeSelection ||
      shouldPreferLyricsCandidate(
        track,
        state.bestKaraokeSelection,
        selection,
        state.bestKaraokeCoverageScore,
        karaokeResult.coverage,
      )
    ) {
      state.bestKaraokeSelection = selection;
      state.bestKaraokeCoverageScore = karaokeResult.coverage;
      state.bestKaraokeResult = {
        lyrics: karaokeResult.lyrics,
        source: "qq-musicu-qrc",
      };
    }
  }
  if (directResult?.lyrics?.length) {
    if (
      !state.bestSelection ||
      shouldPreferLyricsCandidate(
        track,
        state.bestSelection,
        selection,
        state.bestCoverageScore,
        directResult.coverage,
      )
    ) {
      state.bestSelection = selection;
      state.bestCoverageScore = directResult.coverage;
      state.bestResult = {
        lyrics: directResult.lyrics,
        source: "qq-music-direct",
      };
    }
  }
}

function shouldEarlyExitQQDirectCandidate(
  track,
  candidate,
  selection,
  coverageRatio,
  bestSelection,
) {
  if (candidate.score < MATCH_CONFIDENCE_SCORE) {
    return false;
  }
  if (coverageRatio < EARLY_RETURN_COVERAGE_RATIO) {
    return false;
  }
  return (
    computeCandidateMatchRank(
      track,
      selection.title,
      selection.artist,
      selection.durationMs,
      candidate.score,
    ) >=
    computeCandidateMatchRank(
      track,
      bestSelection?.title || "",
      bestSelection?.artist || "",
      bestSelection?.durationMs || 0,
      bestSelection?.searchScore || 0,
    ) -
      1
  );
}

async function probeQQDirectCandidate(track, candidate, accessors) {
  const { getSongMid, getSongId, getSongTitle, getSongArtist, getSongInterval } =
    accessors;
  const songMid = getSongMid(candidate.song);
  const songId = getSongId(candidate.song);
  if (!songMid) {
    return null;
  }
  const candidateTitle = getSongTitle(candidate.song);
  const candidateArtist = getSongArtist(candidate.song);
  const interval = getSongInterval(candidate.song);
  const candidateDurationMs =
    interval > 0 && interval < 1_000 ? interval * 1000 : interval;
  const selection = {
    title: candidateTitle,
    artist: candidateArtist,
    durationMs: candidateDurationMs,
    searchScore: candidate.score,
  };
  const probe = {
    selection,
    karaokeResult: null,
    directResult: null,
    earlyExit: null,
  };

  try {
    const musicuData = await fetchJsonPostFromAnyEndpoint(
      QQ_MUSICU_ENDPOINTS,
      {
        comm: {
          cv: 4747474,
          ct: 24,
          format: "json",
          inCharset: "utf-8",
          outCharset: "utf-8",
          platform: "yqq.json",
          needNewCode: 1,
        },
        req_1: {
          module: "music.musichallSong.PlayLyricInfo",
          method: "GetPlayLyricInfo",
          param: {
            songMID: songMid,
            songID: songId,
            qrc: 1,
            trans: 1,
            roma: 1,
            crypt: 0,
          },
        },
      },
      {
        timeoutMs: QQ_DIRECT_LYRIC_FETCH_TIMEOUT_MS,
        headers: {
          Referer: "https://y.qq.com/",
          Origin: "https://y.qq.com",
        },
      },
    );
    const karaokeBody = decodeQQKaraokePayload(
      musicuData?.req_1?.data?.lyric || "",
    );
    const karaokeLyrics = stripLeadingMetadataLines(
      trimLeadingMetaLines(
        parseLrc(karaokeBody),
        Number(musicuData?.req_1?.data?.startTs || 0),
      ),
      track,
    );
    if (karaokeLyrics.length) {
      const coverage = scoreLyricsCoverage(karaokeLyrics, track.durationMs);
      const coverageRatio = getLyricsCoverageRatio(
        karaokeLyrics,
        track.durationMs,
      );
      probe.karaokeResult = { lyrics: karaokeLyrics, coverage, coverageRatio };
    }
  } catch {
    // Try standard lyric endpoint below for confident matches.
  }

  if (!probe.karaokeResult && candidate.score >= MATCH_CONFIDENCE_SCORE) {
    try {
      const lyricData = await fetchJsonFromAnyEndpoint(QQ_LYRIC_ENDPOINTS, {
        params: {
          format: "json",
          nobase64: 1,
          songmid: songMid,
        },
        timeoutMs: QQ_DIRECT_LYRIC_FETCH_TIMEOUT_MS,
        headers: {
          Referer: "https://y.qq.com/",
          Origin: "https://y.qq.com",
        },
      });
      const rawTimedLyrics = lyricData?.qrc || lyricData?.lyric || "";
      const lyrics = parseLrc(
        decodeQQKaraokePayload(rawTimedLyrics) || String(rawTimedLyrics),
      );
      if (lyrics.length) {
        const coverage = scoreLyricsCoverage(lyrics, track.durationMs);
        const coverageRatio = getLyricsCoverageRatio(lyrics, track.durationMs);
        probe.directResult = { lyrics, coverage, coverageRatio };
      }
    } catch {
      // No lyrics for this candidate.
    }
  }

  return probe;
}

async function fetchQQDirectCandidateLyricsParallel(
  track,
  likelyDirectCandidates,
  accessors,
  seededKaraokeResult = null,
) {
  const state = createQQDirectAggregateState(track, seededKaraokeResult);
  const candidatesToProbe = likelyDirectCandidates.slice(
    0,
    QQ_DIRECT_CANDIDATE_PROBE_CAP,
  );
  const shared = { earlyExit: null };

  const considerProbe = (candidate, probe) => {
    if (!probe || shared.earlyExit) {
      return;
    }
    applyQQDirectCandidateProbe(track, state, candidate, probe);
    if (
      probe.karaokeResult &&
      shouldEarlyExitQQDirectCandidate(
        track,
        candidate,
        probe.selection,
        probe.karaokeResult.coverageRatio,
        state.bestSelection,
      )
    ) {
      shared.earlyExit = {
        lyrics: probe.karaokeResult.lyrics,
        source: "qq-musicu-qrc",
      };
      return;
    }
    // Do not early-exit on the plain direct LRC result. Later candidates may
    // still have QQ QRC karaoke lyrics, and QRC is the preferred QQ payload.
  };

  const topCandidate = candidatesToProbe[0];
  const runnerUpCandidate = candidatesToProbe[1];
  const topCandidateIsClearWinner =
    topCandidate &&
    topCandidate.score >= MATCH_CONFIDENCE_SCORE &&
    (!runnerUpCandidate ||
      topCandidate.score - runnerUpCandidate.score >= 1.5);
  if (topCandidateIsClearWinner) {
    considerProbe(
      topCandidate,
      await probeQQDirectCandidate(track, topCandidate, accessors),
    );
  }

  if (shared.earlyExit) {
    return { earlyExit: shared.earlyExit, state };
  }

  const remainingCandidates = topCandidateIsClearWinner
    ? candidatesToProbe.slice(1)
    : candidatesToProbe;

  await mapWithConcurrency(
    remainingCandidates,
    QQ_DIRECT_CANDIDATE_PARALLELISM,
    async (candidate) => {
      if (shared.earlyExit) {
        return;
      }
      const probe = await probeQQDirectCandidate(track, candidate, accessors);
      considerProbe(candidate, probe);
    },
  );

  if (shared.earlyExit) {
    return { earlyExit: shared.earlyExit, state };
  }
  return { earlyExit: null, state };
}

function resolveQQDirectAggregatedResults(track, state) {
  const { bestResult, bestKaraokeResult } = state;

  if (bestKaraokeResult?.lyrics?.length) {
    return bestKaraokeResult;
  }
  return bestResult || null;
}

async function fetchFromQQDirect(track) {
  const { ranked, accessors } = await searchQQDirectSongPool(track);
  const { getSongTitle, getSongArtist, getSongInterval } = accessors;

  if (!ranked.length) {
    const seededKaraokeResult = await resolveQQLegacyDownloadFallback(track);
    return seededKaraokeResult?.lyrics?.length ? seededKaraokeResult : null;
  }

  const likelyDirectCandidates = filterLikelyQqRankedCandidates(
    track,
    ranked,
    getSongTitle,
    getSongArtist,
    getSongInterval,
  )
    .map((candidate) => ({
      ...candidate,
      candidateTitle: getSongTitle(candidate.song),
      candidateArtist: getSongArtist(candidate.song),
    }))
    .sort((left, right) => compareCandidateMatchQuality(track, left, right))
    .slice(0, MAX_QQ_DIRECT_CANDIDATES);

  const desktopSearchReady = likelyDirectCandidates.length > 0;
  let seededKaraokeResult = null;
  let seededKaraokeCoverageScore = -1;

  if (!desktopSearchReady) {
    seededKaraokeResult = await resolveQQLegacyDownloadFallback(track);
    if (seededKaraokeResult?.lyrics?.length) {
      seededKaraokeCoverageScore = scoreLyricsCoverage(
        seededKaraokeResult.lyrics,
        track.durationMs,
      );
      if (
        getLyricsCoverageRatio(seededKaraokeResult.lyrics, track.durationMs) >=
        EARLY_RETURN_COVERAGE_RATIO
      ) {
        return seededKaraokeResult;
      }
    } else {
      seededKaraokeResult = null;
    }
  }

  const parallelFetch = await fetchQQDirectCandidateLyricsParallel(
    track,
    likelyDirectCandidates,
    accessors,
    seededKaraokeResult,
  );
  if (parallelFetch.earlyExit) {
    return parallelFetch.earlyExit;
  }
  const bestResult = resolveQQDirectAggregatedResults(track, parallelFetch.state);

  if (!bestResult?.lyrics?.length) {
    const legacyFallback = await resolveQQLegacyDownloadFallback(track);
    if (legacyFallback?.lyrics?.length) {
      return legacyFallback;
    }
  }

  return bestResult || null;
}

async function fetchFromQQOpenApiMirrorFallback(track) {
  const songs = [];
  for (const query of buildQueryVariants(track).slice(0, MAX_QUERY_VARIANTS)) {
    try {
      const searchData = await fetchJsonFromAnyEndpoint(QQ_SEARCH_ENDPOINTS, {
        params: { p: 1, n: 60, w: query, format: "json" },
        timeoutMs: 10_000,
        headers: {
          Referer: "https://y.qq.com/",
          Origin: "https://y.qq.com",
        },
      });
      const searchSongs =
        searchData?.data?.song?.list || searchData?.data?.list || [];
      songs.push(...(Array.isArray(searchSongs) ? searchSongs : []));
    } catch {
      // Try next query variant.
    }
  }

  if (!songs.length) {
    return null;
  }

  const getSongMid = (song) =>
    song?.songmid || song?.mid || song?.track_mid || "";
  const getSongTitle = (song) =>
    song?.songname || song?.name || song?.title || "";
  const getSongArtist = (song) => {
    if (Array.isArray(song?.singer)) {
      return song.singer.map((s) => s?.name || "").join(" ");
    }
    return song?.singer_name || song?.singer || song?.artist || "";
  };
  const getSongInterval = (song) =>
    Number(song?.interval || song?.duration || 0);

  const seen = new Set();
  const ranked = songs
    .filter((song) => {
      const mid = getSongMid(song);
      if (!mid || seen.has(mid)) {
        return false;
      }
      seen.add(mid);
      return true;
    })
    .map((song) => {
      const title = getSongTitle(song);
      const artist = getSongArtist(song);
      let score = scoreCandidate(track, title, artist);
      const rawDuration = getSongInterval(song);
      const candidateDurationMs =
        rawDuration > 0
          ? rawDuration < 1_000
            ? rawDuration * 1000
            : rawDuration
          : 0;
      score += scoreDurationBonus(track, title, artist, candidateDurationMs);
      return { song, score };
    })
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    return null;
  }

  const likelyFallbackCandidates = filterLikelyQqRankedCandidates(
    track,
    ranked,
    getSongTitle,
    getSongArtist,
    getSongInterval,
  ).slice(0, 8);

  for (const candidate of likelyFallbackCandidates) {
    const songMid = getSongMid(candidate.song);
    const title = getSongTitle(candidate.song);
    const artist = getSongArtist(candidate.song);
    const interval = getSongInterval(candidate.song);
    const candidateDurationMs =
      interval > 0 && interval < 1_000 ? interval * 1000 : interval;
    if (!songMid || candidate.score < MATCH_ACCEPTANCE_THRESHOLD) {
      continue;
    }

    try {
      const lyricData = await fetchJsonFromAnyEndpoint(QQ_LYRIC_ENDPOINTS, {
        params: {
          format: "json",
          nobase64: 1,
          songmid: songMid,
        },
        timeoutMs: 10_000,
        headers: {
          Referer: "https://y.qq.com/",
          Origin: "https://y.qq.com",
        },
      });
      const rawTimedLyrics = lyricData?.qrc || lyricData?.lyric || "";
      const lyrics = parseLrc(
        decodeQQKaraokePayload(rawTimedLyrics) || String(rawTimedLyrics),
      );
      if (lyrics.length) {
        return { lyrics, source: "qq-music-openapi-fallback" };
      }
    } catch {
      // Try next candidate.
    }
  }

  return null;
}

async function fetchFromQQMirror(track) {
  const query = `${normalizeText(track.title)} ${normalizeText(track.artist)}`;
  let searchData = null;
  let lastSearchError = null;
  for (const searchPath of ["/search/quick", "/search"]) {
    try {
      searchData = await fetchJsososoWithFallback(
        searchPath,
        {
          params: { key: query },
          timeoutMs: 12_000,
        },
        { attempts: 3, backoffMs: 500 },
      );
      break;
    } catch (error) {
      lastSearchError = error;
    }
  }
  if (!searchData) {
    // JSOSOSO public mirrors are often unstable; fall back to direct QQ open APIs.
    const openApiFallback = await fetchFromQQOpenApiMirrorFallback(track);
    if (openApiFallback) {
      return openApiFallback;
    }
    throw lastSearchError || new Error("jsososo search failed");
  }

  const songs = normalizeJsososoSongs(searchData);
  const ranked = songs
    .map((song) => {
      const title = song?.name || song?.songname || song?.title || "";
      const artist =
        song?.singer || song?.singer_name || song?.artist || song?.author || "";
      let score = scoreCandidate(track, title, artist);
      const rawDuration = Number(song?.interval || song?.duration || 0);
      const candidateDurationMs =
        rawDuration > 0
          ? rawDuration < 1_000
            ? rawDuration * 1000
            : rawDuration
          : 0;
      score += scoreDurationBonus(track, title, artist, candidateDurationMs);
      return { song, score };
    })
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    return null;
  }

  const likelyMirrorCandidates = filterLikelySameTrackCandidates(track, ranked, {
    getTitle: (candidate) =>
      candidate.song?.name ||
      candidate.song?.songname ||
      candidate.song?.title ||
      "",
    getArtist: (candidate) =>
      candidate.song?.singer ||
      candidate.song?.singer_name ||
      candidate.song?.artist ||
      candidate.song?.author ||
      "",
    getDurationMs: (candidate) => {
      const rawDuration = Number(
        candidate.song?.interval || candidate.song?.duration || 0,
      );
      return rawDuration > 0 && rawDuration < 1_000
        ? rawDuration * 1000
        : rawDuration;
    },
    getScore: (candidate) => candidate.score,
  }).slice(0, 6);

  for (const candidate of likelyMirrorCandidates) {
    const candidateId =
      candidate.song?.id ||
      candidate.song?.songid ||
      candidate.song?.songId ||
      "";
    const songmid =
      candidate.song?.mid ||
      candidate.song?.songmid ||
      candidate.song?.songMid ||
      "";
    const candidateTitle =
      candidate.song?.name ||
      candidate.song?.songname ||
      candidate.song?.title ||
      "";
    const candidateArtist =
      candidate.song?.singer ||
      candidate.song?.singer_name ||
      candidate.song?.artist ||
      candidate.song?.author ||
      "";
    const rawDuration = Number(
      candidate.song?.interval || candidate.song?.duration || 0,
    );
    const candidateDurationMs =
      rawDuration > 0 && rawDuration < 1_000 ? rawDuration * 1000 : rawDuration;
    if (!songmid || candidate.score < MATCH_ACCEPTANCE_THRESHOLD) {
      continue;
    }
    try {
      const lyricData = await fetchJsososoWithFallback(
        "/lyric",
        {
          params: {
            songmid,
            id: candidateId || undefined,
            ownCookie: 0,
          },
          timeoutMs: 12_000,
        },
        { attempts: 2, backoffMs: 450 },
      );
      const lyricText = extractJsososoLyricText(lyricData);
      const lyrics = parseLrc(lyricText);
      if (lyrics.length) {
        return { lyrics, source: "qq-music-jsososo" };
      }
    } catch {
      // Try next candidate.
    }
  }

  const openApiFallback = await fetchFromQQOpenApiMirrorFallback(track);
  if (openApiFallback) {
    return openApiFallback;
  }

  return null;
}

async function fetchFromQQMeting(track) {
  const query = `${track.title} ${track.artist}`.trim();
  const searchParamVariants = [{ id: query }, { s: query }];
  let candidates = [];
  let lastError = null;

  for (const endpoint of METING_SEARCH_ENDPOINTS) {
    for (const variant of searchParamVariants) {
      try {
        const data = await fetchJson(endpoint, {
          params: {
            server: "tencent",
            type: "search",
            ...variant,
          },
          timeoutMs: 8_000,
        });
        const nextCandidates = Array.isArray(data) ? data : [];
        if (!nextCandidates.length) {
          continue;
        }
        if (nextCandidates.length >= 5) {
          const maxSimilarity = nextCandidates.reduce(
            (max, item) =>
              Math.max(
                max,
                scoreCandidate(track, item?.title || "", item?.author || ""),
              ),
            -Infinity,
          );
          const topTitle = String(nextCandidates[0]?.title || "")
            .toLowerCase()
            .trim();
          const topAuthor = String(nextCandidates[0]?.author || "")
            .toLowerCase()
            .trim();
          const appearsStaticDefault =
            topTitle === "hello" && topAuthor === "adele";
          if (
            appearsStaticDefault &&
            maxSimilarity < MATCH_ACCEPTANCE_THRESHOLD - 1
          ) {
            lastError = new Error(
              "Meting endpoint returned unrelated static results (stale catalog)",
            );
            continue;
          }
        }
        candidates = nextCandidates;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (candidates.length) {
      break;
    }
  }

  if (!candidates.length) {
    if (lastError) {
      throw lastError;
    }
    return null;
  }

  const sorted = candidates
    .map((item) => ({
      item,
      score: scoreCandidate(track, item.title || "", item.author || ""),
    }))
    .sort((a, b) => b.score - a.score);



  const likelyMetingCandidates = filterLikelySameTrackCandidates(track, sorted, {
    getTitle: (candidate) => candidate.item?.title || "",
    getArtist: (candidate) => candidate.item?.author || "",
    getDurationMs: () => Number(track.durationMs || 0),
    getScore: (candidate) => candidate.score,
  }).slice(0, 6);

  for (const candidate of likelyMetingCandidates) {
    if (candidate.score < MATCH_ACCEPTANCE_THRESHOLD || !candidate.item?.lrc) {
      continue;
    }
    try {
      const lyricText = await fetchText(candidate.item.lrc, {
        timeoutMs: 8_000,
      });
      if (
        shouldRejectLyricVariant(
          track.title,
          candidate.item?.title || "",
          lyricText,
        )
      ) {
        continue;
      }
      const lyrics = parseLrc(lyricText);
      if (lyrics.length) {
        return { lyrics, source: "qq-music-meting" };
      }
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

// QQ's Musicu endpoint, public search endpoint, and public mirrors each have
// intermittent catalog gaps. Keep the desktop-compatible direct flow first,
// then try the existing compatible fallbacks before reporting no match.
async function fetchFromQQ(track) {
  const fetchers = [fetchFromQQDirect, fetchFromQQMirror, fetchFromQQMeting];
  for (const fetcher of fetchers) {
    try {
      const result = await fetcher(track);
      if (result?.lyrics?.length) {
        return result;
      }
    } catch {
      // A provider failure should not prevent the other QQ-compatible paths.
    }
  }
  return null;
}

async function previewQQDirectSearchCandidates(track) {
  const { ranked, accessors } = await searchQQDirectSongPool(track);
  const { getSongMid, getSongTitle, getSongArtist, getSongInterval } = accessors;

  return ranked.map((candidate) => {
    const title = String(getSongTitle(candidate.song) || "").trim();
    const artist = String(getSongArtist(candidate.song) || "").trim();
    const interval = getSongInterval(candidate.song);
    let durationMs = 0;
    if (interval > 0) {
      durationMs = interval < 1_000 ? interval * 1000 : interval;
    }
    return {
      title,
      artist,
      score: candidate.score,
      durationMs,
      songMid: getSongMid(candidate.song),
    };
  });
}

// ---- DesktopBridge/src/lyrics/parts/04-netease-spicy-lrclib-sources.js ----
// Netease, Spicy Lyrics, and LRCLib source adapters.
// This file is evaluated by ../index.js in a shared compatibility context.
// Keep behavior changes deliberate; most code here was moved verbatim from src/lyricsService.js.

async function fetchFromNetease(track) {
  const queryVariants = buildQueryVariants(track).slice(0, MAX_QUERY_VARIANTS);
  const rawSongs = [];

  await Promise.all(
    queryVariants.map(async (query) => {
      try {
        const payload = await fetchNeteaseSearchJson(query, {
          timeoutMs: 10_000,
        });
        const songs = Array.isArray(payload?.result?.songs)
          ? payload.result.songs
          : [];
        rawSongs.push(...songs);
      } catch {
        // Try next query variant.
      }
    }),
  );

  if (!rawSongs.length) {
    return null;
  }

  const deduped = [];
  const seen = new Set();
  for (const song of rawSongs) {
    const id = Number(song?.id || 0);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    deduped.push(song);
  }

  const ranked = deduped
    .map((song) => {
      const title = String(song?.name || song?.title || "").trim();
      const artist = Array.isArray(song?.artists)
        ? song.artists.map((entry) => entry?.name || "").join(" ")
        : String(song?.artist || "").trim();
      let score = scoreCandidate(track, title, artist);
      const durationMs = Number(song?.duration || song?.dt || 0);
      score += scoreDurationBonus(track, title, artist, durationMs);
      return { song, score, title, artist, durationMs };
    })
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    return null;
  }

  let bestResult = null;
  let bestScore = -1;
  const likelyNeteaseCandidates = ranked
    .filter((candidate) =>
      isLikelySameTrack(
        track,
        candidate.title,
        candidate.artist,
        candidate.durationMs,
      ),
    )
    .sort((left, right) => compareCandidateMatchQuality(track, left, right))
    .slice(0, 8);

  for (const candidate of likelyNeteaseCandidates) {
    try {
      const lyricPayload = await fetchNeteaseLyricsJson(candidate.song.id, {
        timeoutMs: 10_000,
      });
      const karaokeText =
        lyricPayload?.yrc?.lyric ||
        lyricPayload?.klyric?.lyric ||
        lyricPayload?.data?.yrc?.lyric ||
        lyricPayload?.data?.klyric?.lyric ||
        "";
      const karaokeLyrics = stripLeadingMetadataLines(
        parseNeteaseYrc(cleanNeteaseSpacing(karaokeText)),
        track,
      );
      if (karaokeLyrics.length) {
        const coverage = scoreLyricsCoverage(karaokeLyrics, track.durationMs);
        const coverageRatio = getLyricsCoverageRatio(
          karaokeLyrics,
          track.durationMs,
        );
        if (coverage > bestScore) {
          bestScore = coverage;
          bestResult = { lyrics: karaokeLyrics, source: "netease-yrc" };
        }
        if (
          candidate.score >= MATCH_CONFIDENCE_SCORE &&
          coverageRatio >= EARLY_RETURN_COVERAGE_RATIO
        ) {
          return { lyrics: karaokeLyrics, source: "netease-yrc" };
        }
        continue;
      }

      const rawTimedLyrics =
        lyricPayload?.lrc?.lyric ||
        lyricPayload?.data?.lrc?.lyric ||
        lyricPayload?.lyric ||
        "";
      const lyrics = stripLeadingMetadataLines(
        parseLrc(cleanNeteaseSpacing(rawTimedLyrics)),
        track,
      );
      if (lyrics.length) {
        const coverage = scoreLyricsCoverage(lyrics, track.durationMs);
        if (coverage > bestScore) {
          bestScore = coverage;
          bestResult = { lyrics, source: "netease-lrc" };
        }
      }
    } catch {
      // Try next candidate.
    }
  }

  return bestResult;
}

async function resolveQqReferenceFingerprint(track) {
  if (!shouldUseQqFingerprintForSpicyVariantCheck(track)) {
    return "";
  }
  let timeoutHandle = null;
  const fetchFingerprint = async () => {
    try {
      const qqResult = await fetchFromQQDirect(track);
      if (!qqResult?.lyrics?.length) {
        return "";
      }
      return buildLyricsContentFingerprint(qqResult.lyrics, track);
    } catch {
      return "";
    }
  };
  try {
    return await Promise.race([
      fetchFingerprint(),
      new Promise((resolve) => {
        timeoutHandle = setTimeout(
          () => resolve(""),
          SPICY_QQ_FINGERPRINT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function createSpicyFetchProfiler() {
  const enabled = ["1", "true", "yes", "on"].includes(
    String(process.env.SPICY_PROFILE || "").trim().toLowerCase(),
  );
  if (!enabled) {
    return {
      mark() {},
      finish() {
        return null;
      },
    };
  }
  const startedAt = Date.now();
  let lastAt = startedAt;
  const steps = [];
  return {
    mark(step, meta = {}) {
      const now = Date.now();
      steps.push({
        step,
        elapsedMs: now - lastAt,
        totalMs: now - startedAt,
        ...meta,
      });
      lastAt = now;
    },
    finish(meta = {}) {
      const summary = {
        steps,
        totalMs: Date.now() - startedAt,
        ...meta,
      };
      console.log("[spicy-profile]", JSON.stringify(summary));
      return summary;
    },
  };
}

async function fetchFromSpicyLyrics(
  track,
  { spotifyWebToken = "", spotifyAccessToken = "" } = {},
) {
  const profile = createSpicyFetchProfiler();
  let accessToken = "";
  const oauthToken = String(spotifyAccessToken || "").trim();
  if (oauthToken) {
    accessToken = oauthToken;
    profile.mark("1-token-resolve", { path: "oauth" });
  } else {
    try {
      accessToken = await getSpotifyWebAccessToken(spotifyWebToken);
      profile.mark("1-token-resolve", { path: "web-token-exchange" });
    } catch (error) {
      profile.finish({
        ok: false,
        failedStep: "1-token-resolve",
        error: error instanceof Error ? error.message : String(error),
      });
      throw createSourceStageError("spicy", "spotify-token", error);
    }
  }

  spicyDebugLog("Spicy source token resolved", {
    hasOAuthToken: Boolean(oauthToken),
    hasLegacySpotifyWebToken: Boolean(String(spotifyWebToken || "").trim()),
    accessTokenPreview: maskTokenPreview(accessToken),
    track: {
      trackId: String(track?.trackId || ""),
      spotifyTrackId: String(track?.spotifyTrackId || ""),
      title: String(track?.title || ""),
      artist: String(track?.artist || ""),
      durationMs: Number(track?.durationMs || 0),
    },
  });

  const directSpotifyId = String(track?.spotifyTrackId || "").trim();
  let spotifyTrackIds = [];
  let idResolvePath = directSpotifyId ? "direct-spotify-track-id" : "unknown";
  if (directSpotifyId) {
    spotifyTrackIds = [directSpotifyId];
    profile.mark("2-spotify-id-resolve", {
      path: idResolvePath,
      candidateCount: spotifyTrackIds.length,
    });
  } else {
    profile.mark("2-spotify-id-resolve", {
      path: "missing-spotify-track-id",
      candidateCount: 0,
    });
    profile.finish({ ok: false, failedStep: "2-spotify-id-resolve" });
    throw createSourceStageNoMatchError("spicy", "spotify-track-lookup");
  }

  spicyDebugLog("Spicy source candidate Spotify IDs", {
    directSpotifyId,
    spotifyTrackIds,
  });

  let bestResult = null;
  let lastHardError = null;
  let lastNoMatchError = null;
  let qqReferenceFingerprintPromise = null;
  const getQqReferenceFingerprintLazy = () => {
    if (!shouldUseQqFingerprintForSpicyVariantCheck(track)) {
      return Promise.resolve("");
    }
    if (!qqReferenceFingerprintPromise) {
      qqReferenceFingerprintPromise = resolveQqReferenceFingerprint(track);
    }
    return qqReferenceFingerprintPromise;
  };

  for (const [candidateIndex, spotifyTrackId] of spotifyTrackIds.entries()) {
    let queryResults = null;
    const queryStartedAt = Date.now();
    try {
      queryResults = await fetchSpicyLyricsQueryWithQueueRetry(
        [
          {
            operation: "lyrics",
            variables: buildSpicyLyricsQueryVariables(spotifyTrackId),
          },
        ],
        {
          "SpicyLyrics-WebAuth": `Bearer ${accessToken}`,
        },
        {
          expectedOperation: "lyrics",
          expectedOperationId: "0",
          expectedTrackId: spotifyTrackId,
        },
      );
    } catch (error) {
      profile.mark(`3-spicy-api-query#${candidateIndex + 1}`, {
        spotifyTrackId,
        ok: false,
        elapsedMs: Date.now() - queryStartedAt,
      });
      lastHardError = createSourceStageError("spicy", "backend", error);
      continue;
    }
    profile.mark(`3-spicy-api-query#${candidateIndex + 1}`, {
      spotifyTrackId,
      ok: true,
      elapsedMs: Date.now() - queryStartedAt,
    });

    const parseStartedAt = Date.now();
    const lyricQueryResult = selectSpicyQueryResult(queryResults, {
      expectedOperation: "lyrics",
      expectedOperationId: "0",
      expectedTrackId: spotifyTrackId,
    });
    const firstResult = lyricQueryResult?.result || null;
    if (!firstResult || Number(firstResult.httpStatus || 0) === 404) {
      lastNoMatchError = createSourceStageNoMatchError("spicy", "backend");
      continue;
    }
    if (Number(firstResult.httpStatus || 0) !== 200) {
      const httpStatus = Number(firstResult.httpStatus || 0);
      const errorMessage =
        httpStatus === 503
          ? "Spicy Lyrics query is still queued (HTTP 503)."
          : `Spicy Lyrics query failed with status ${
              httpStatus || "unknown"
            }.`;
      lastHardError = createSourceStageError(
        "spicy",
        "backend",
        new Error(errorMessage),
      );
      continue;
    }
    if (!hasSpicyLyricsQueryPayload(firstResult)) {
      lastHardError = createSourceStageError(
        "spicy",
        "backend",
        new Error(
          `Spicy Lyrics returned empty or unsupported payload (format=${String(
            firstResult.format || "unknown",
          )}).`,
        ),
      );
      continue;
    }

    const rawSpicyData = firstResult.data;
    const wasPacked = isSpicyObjPackPayload(rawSpicyData);
    let spicyLyricsData = null;
    try {
      spicyLyricsData = normalizeSpicyLyricsQueryData(rawSpicyData);
    } catch (error) {
      profile.mark(`4-unpack-lyrics#${candidateIndex + 1}`, {
        spotifyTrackId,
        packed: wasPacked,
        ok: false,
        elapsedMs: Date.now() - parseStartedAt,
      });
      lastHardError = createSourceStageError("spicy", "backend", error);
      continue;
    }
    spicyDebugLog("Spicy source first query result", {
      spotifyTrackId,
      operationId: String(lyricQueryResult?.operationId || ""),
      operation: String(lyricQueryResult?.operation || ""),
      httpStatus: Number(firstResult.httpStatus || 0),
      format: String(firstResult.format || ""),
      packed: wasPacked,
      payload: summarizeSpicyPayload(spicyLyricsData || rawSpicyData),
    });

    const sourceLabel = getSpicySourceLabel(
      spicyLyricsData,
      track?.durationMs || 0,
    );

    const lyrics = parseSpicyLyrics(spicyLyricsData, track?.durationMs || 0);
    profile.mark(`4-parse-lyrics#${candidateIndex + 1}`, {
      spotifyTrackId,
      lineCount: lyrics.length,
      elapsedMs: Date.now() - parseStartedAt,
    });
    if (!lyrics.length) {
      lastNoMatchError = createSourceStageNoMatchError(
        "spicy",
        "payload-parse",
      );
      continue;
    }
    const songwriters = extractSpicySongwriters(spicyLyricsData);
    const spicyMetadata = extractSpicyPayloadMetadata(spicyLyricsData);
    const declaredTitleMatch = spicyDeclaredTitlesMatchPlayback(
      track,
      spicyMetadata.titles,
    );
    const variantStartedAt = Date.now();
    if (
      featuredVariantLyricsMismatch(track, lyrics, {
        source: "spicy",
        spicyDeclaredTitles: spicyMetadata.titles,
      })
    ) {
      profile.mark(`5-variant-heuristics#${candidateIndex + 1}`, {
        spotifyTrackId,
        declaredTitleMatch,
        mismatch: true,
        elapsedMs: Date.now() - variantStartedAt,
      });
      spicyDebugLog("Spicy source rejected feat/variant lyrics mismatch", {
        spotifyTrackId,
        title: String(track?.title || ""),
        spicyVariantTitles: spicyMetadata.titles,
        spicyFingerprintPreview: buildLyricsContentFingerprint(lyrics, track).slice(
          0,
          160,
        ),
      });
      lastNoMatchError = createSourceStageNoMatchError(
        "spicy",
        "featured-variant-mismatch",
      );
      continue;
    }
    profile.mark(`5-variant-heuristics#${candidateIndex + 1}`, {
      spotifyTrackId,
      declaredTitleMatch,
      mismatch: false,
      elapsedMs: Date.now() - variantStartedAt,
    });
    let qqReferenceFingerprint = "";
    if (
      shouldUseQqFingerprintForSpicyVariantCheck(track) &&
      declaredTitleMatch !== true
    ) {
      const qqStartedAt = Date.now();
      qqReferenceFingerprint = await getQqReferenceFingerprintLazy();
      profile.mark(`6-qq-fingerprint#${candidateIndex + 1}`, {
        spotifyTrackId,
        ran: true,
        hasFingerprint: Boolean(qqReferenceFingerprint),
        elapsedMs: Date.now() - qqStartedAt,
      });
      if (
        qqReferenceFingerprint &&
        !lyricsContentFingerprintsMatch(
          qqReferenceFingerprint,
          buildLyricsContentFingerprint(lyrics, track),
        )
      ) {
        spicyDebugLog("Spicy source rejected QQ fingerprint mismatch", {
          spotifyTrackId,
          title: String(track?.title || ""),
          qqReferenceFingerprintPreview: String(qqReferenceFingerprint || "").slice(
            0,
            160,
          ),
          spicyFingerprintPreview: buildLyricsContentFingerprint(
            lyrics,
            track,
          ).slice(0, 160),
        });
        lastNoMatchError = createSourceStageNoMatchError(
          "spicy",
          "featured-variant-mismatch",
        );
        continue;
      }
    } else {
      profile.mark(`6-qq-fingerprint#${candidateIndex + 1}`, {
        spotifyTrackId,
        ran: false,
        skippedReason:
          declaredTitleMatch === true
            ? "declared-titles-matched"
            : "not-required",
      });
    }

    const candidate = {
      lyrics,
      source: sourceLabel,
      metadata: {
        ...(songwriters.length ? { credits: { songwriters } } : {}),
        ...(spicyMetadata.titles.length
          ? { spicyVariantTitles: spicyMetadata.titles }
          : {}),
        ...(qqReferenceFingerprint
          ? { qqReferenceFingerprint }
          : {}),
      },
    };
    if (!Object.keys(candidate.metadata).length) {
      candidate.metadata = undefined;
    }
    spicyDebugLog("Spicy source parsed candidate", {
      spotifyTrackId,
      source: candidate.source,
      lineCount: Array.isArray(candidate.lyrics) ? candidate.lyrics.length : 0,
      coverageRatio: getLyricsCoverageRatio(
        candidate.lyrics,
        track?.durationMs || 0,
      ),
      firstLinePreview:
        Array.isArray(candidate.lyrics) && candidate.lyrics[0]
          ? String(
              (candidate.lyrics[0].syllables || [])
                .map((part) => part.text || "")
                .join(""),
            ).slice(0, 120)
          : "",
    });

    if (
      !bestResult ||
      shouldUpgradeLyricsCandidate(track, bestResult, candidate)
    ) {
      bestResult = candidate;
    }
    if (getLyricsTimingTier(candidate.source) >= 3) {
      break;
    }
  }

  if (bestResult?.lyrics?.length) {
    profile.finish({
      ok: true,
      source: bestResult.source,
      lineCount: bestResult.lyrics.length,
      idResolvePath,
      candidateCount: spotifyTrackIds.length,
    });
    return bestResult;
  }
  profile.finish({
    ok: false,
    idResolvePath,
    candidateCount: spotifyTrackIds.length,
    lastHardError: lastHardError?.message || null,
    lastNoMatchError: lastNoMatchError?.message || null,
  });
  if (lastHardError) {
    throw lastHardError;
  }
  if (lastNoMatchError) {
    throw lastNoMatchError;
  }
  throw createSourceStageNoMatchError("spicy", "backend");
}

async function fetchFromLrcLib(track) {
  const endpoints = [
    { url: "https://lrclib.net/api/search", mode: "search" },
    { url: "https://www.lrclib.net/api/search", mode: "search" },
    { url: "https://lrclib.net/api/get", mode: "get" },
    { url: "https://www.lrclib.net/api/get", mode: "get" },
  ];
  const rawTitle = String(track?.title || "").trim();
  const rawArtist = String(track?.artist || "").trim();
  const titleWithoutCommonSuffix = rawTitle
    .replace(/\s*[-:|]\s*(single|ep|album|ost|soundtrack)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const titleWithoutBrackets = rawTitle
    .replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const primaryArtist = getPrimaryArtistName(rawArtist);
  const artistWithoutBrackets = rawArtist
    .replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const titleVariants = [];
  const seenTitle = new Set();
  for (const value of [
    rawTitle,
    titleWithoutBrackets,
    titleWithoutCommonSuffix,
  ]) {
    const safe = String(value || "").trim();
    const key = safe.toLowerCase();
    if (!safe || seenTitle.has(key)) {
      continue;
    }
    seenTitle.add(key);
    titleVariants.push(safe);
  }

  const parenthesizedArtistTokens = Array.from(
    rawArtist.matchAll(/\(([^)]+)\)|\[([^\]]+)\]|\{([^}]+)\}/g),
  )
    .map((match) => (match[1] || match[2] || match[3] || "").trim())
    .filter(Boolean)
    .flatMap((value) =>
      value
        .split(/[,&/|]+/)
        .map((token) => token.trim())
        .filter(Boolean),
    );

  const artistVariants = [];
  const seenArtist = new Set();
  for (const value of [
    rawArtist,
    primaryArtist,
    artistWithoutBrackets,
    ...buildMusixmatchArtistVariants(rawArtist),
    ...parenthesizedArtistTokens,
  ]) {
    const safe = String(value || "").trim();
    const key = safe.toLowerCase();
    if (!safe || seenArtist.has(key)) {
      continue;
    }
    seenArtist.add(key);
    artistVariants.push(safe);
  }

  const queryVariants = [];
  const seenQuery = new Set();
  for (const title of titleVariants) {
    for (const artist of artistVariants) {
      const key = `${title.toLowerCase()}|${artist.toLowerCase()}`;
      if (seenQuery.has(key)) {
        continue;
      }
      seenQuery.add(key);
      queryVariants.push({ track_name: title, artist_name: artist });
    }
    const titleOnlyKey = `${title.toLowerCase()}|`;
    if (!seenQuery.has(titleOnlyKey)) {
      seenQuery.add(titleOnlyKey);
      queryVariants.push({ track_name: title });
    }
  }

  const candidates = [];
  const seenCandidates = new Set();
  let lastError = null;
  let sawSuccessfulResponse = false;
  let sawNotFoundResponse = false;

  for (const endpoint of endpoints) {
    for (const params of queryVariants) {
      try {
        const payload = await fetchJsonWithRetry(
          endpoint.url,
          {
            params,
            timeoutMs: 12_000,
            headers: {
              Accept: "application/json",
              "User-Agent":
                "KineSyncDesktopBridge/1.0 (+https://github.com)",
            },
          },
          { attempts: 3, backoffMs: 500 },
        );
        sawSuccessfulResponse = true;
        const batch =
          endpoint.mode === "get" ? (payload ? [payload] : []) : payload;
        for (const item of Array.isArray(batch) ? batch : []) {
          const key = `${String(item?.id || "")}|${normalizeText(
            item?.trackName || item?.name || "",
          )}|${normalizeText(item?.artistName || "")}|${String(
            item?.durationMs || item?.duration || "",
          )}`;
          if (!key || seenCandidates.has(key)) {
            continue;
          }
          seenCandidates.add(key);
          candidates.push(item);
        }
      } catch (error) {
        const message = String(error?.message || "").toLowerCase();
        if (message.includes("http 404")) {
          sawNotFoundResponse = true;
          continue;
        }
        lastError = error;
      }
    }
  }

  if (
    !candidates.length &&
    !sawSuccessfulResponse &&
    !sawNotFoundResponse &&
    lastError
  ) {
    throw lastError || new Error("Failed to reach LrcLib API");
  }

  const ranked = candidates
    .map((item) => ({
      item,
      score: scoreCandidate(
        track,
        item?.trackName || item?.name || "",
        item?.artistName || "",
      ),
    }))
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    return null;
  }

  const lrclibMinScore = Math.max(3.5, MATCH_ACCEPTANCE_THRESHOLD - 1);
  const likelyLrcLibCandidates = ranked
    .filter(
      (candidate) =>
        candidate.score >= lrclibMinScore &&
        isLikelySameTrack(
          track,
          candidate.item?.trackName || candidate.item?.name || "",
          candidate.item?.artistName || "",
          (() => {
            const raw = Number(
              candidate.item?.durationMs || candidate.item?.duration || 0,
            );
            if (!Number.isFinite(raw) || raw <= 0) {
              return 0;
            }
            return raw < 10_000 ? raw * 1000 : raw;
          })(),
        ),
    )
    .slice(0, 8);

  for (const candidate of likelyLrcLibCandidates) {
    if (
      candidate.item?.instrumental === true ||
      String(candidate.item?.instrumental || "").toLowerCase() === "true"
    ) {
      return {
        lyrics: [],
        source: "lrclib-instrumental",
        metadata: { instrumental: true },
      };
    }
    if (!candidate.item?.syncedLyrics) {
      continue;
    }
    const lyrics = parseLrc(candidate.item.syncedLyrics);
    if (lyrics.length) {
      return { lyrics, source: "lrclib-fallback" };
    }
  }
  return null;
}

async function previewNeteaseSearchCandidates(track) {
  const queryVariants = buildQueryVariants(track).slice(0, MAX_QUERY_VARIANTS);
  const rawSongs = [];

  await Promise.all(
    queryVariants.map(async (query) => {
      try {
        const payload = await fetchNeteaseSearchJson(query, {
          timeoutMs: 10_000,
        });
        const songs = Array.isArray(payload?.result?.songs)
          ? payload.result.songs
          : [];
        rawSongs.push(...songs);
      } catch {
        // Try next query variant.
      }
    }),
  );

  const deduped = [];
  const seen = new Set();
  for (const song of rawSongs) {
    const id = Number(song?.id || 0);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    deduped.push(song);
  }

  return deduped
    .map((song) => {
      const title = String(song?.name || song?.title || "").trim();
      const artist = Array.isArray(song?.artists)
        ? song.artists.map((entry) => entry?.name || "").join(" ")
        : String(song?.artist || "").trim();
      let score = scoreCandidate(track, title, artist);
      const durationMs = Number(song?.duration || song?.dt || 0);
      score += scoreDurationBonus(track, title, artist, durationMs);
      return { title, artist, score, durationMs, songId: Number(song?.id || 0) };
    })
    .sort((a, b) => b.score - a.score);
}

// ---- DesktopBridge/src/lyrics/parts/04-kugou-source.js ----
// Kugou Music karaoke (KRC) source adapter.
// This file is evaluated by ../index.js in a shared compatibility context.

const KUGOU_SEARCH_ENDPOINTS = [
  "https://mobilecdn.kugou.com/api/v3/search/song",
  "https://mobileservice.kugou.com/api/v3/search/song",
  "http://mobileservice.kugou.com/api/v3/search/song",
];
const KUGOU_LYRIC_SEARCH_ENDPOINTS = [
  "https://lyrics.kugou.com/search",
  "https://krcs.kugou.com/search",
  "http://krcs.kugou.com/search",
];
const KUGOU_LYRIC_DOWNLOAD_ENDPOINTS = [
  "https://lyrics.kugou.com/download",
  "http://lyrics.kugou.com/download",
];
const MAX_KUGOU_CANDIDATES = 8;
const KUGOU_MAX_QUERY_VARIANTS = 6;
const KUGOU_ARTIST_LISTING_SPLIT = /[、，/;&|]+/u;
const KUGOU_HANGUL_TEXT_RE = /[\uac00-\ud7a3\u3130-\u318f]/u;

function normalizeKugouCatalogText(input) {
  return String(input || "").normalize("NFC");
}

function containsHangulText(input) {
  const value = normalizeKugouCatalogText(input);
  if (!value) {
    return false;
  }
  try {
    return /\p{Script=Hangul}/u.test(value);
  } catch {
    return KUGOU_HANGUL_TEXT_RE.test(value);
  }
}

function splitKugouArtistNames(artist) {
  return String(artist || "")
    .split(KUGOU_ARTIST_LISTING_SPLIT)
    .map((part) => part.trim())
    .filter(Boolean);
}

function kugouListingIncludesPrimaryArtist(trackArtist, candidateArtist) {
  const trackPrimary = normalizeArtistText(
    getSpotifyPrimaryArtist(trackArtist),
  );
  if (!trackPrimary) {
    return false;
  }
  let listingNames = splitKugouArtistNames(candidateArtist);
  if (!listingNames.length) {
    listingNames = [String(candidateArtist || "").trim()];
  }
  return listingNames.some((name) => {
    const normalized = normalizeArtistText(name);
    if (!normalized) {
      return false;
    }
    return (
      normalized === trackPrimary ||
      tokens(normalizeArtistText(candidateArtist)).includes(trackPrimary)
    );
  });
}

function kugouTitleMatchesTrack(track, candidateTitle) {
  if (titleCoreMatchesQuery(track, candidateTitle)) {
    return true;
  }
  const trackCore = normalizeCoreTitle(track?.title || "");
  if (!trackCore) {
    return false;
  }
  for (const segment of extractBracketedTitleSegments(candidateTitle)) {
    if (normalizeCoreTitle(segment) === trackCore) {
      return true;
    }
  }
  return false;
}

function isLikelySameKugouTrack(
  track,
  title,
  artist,
  durationMs = 0,
  { titleLinked = false } = {},
) {
  if (isLikelySameTrack(track, title, artist, durationMs)) {
    return true;
  }
  if (!titleLinked && !kugouTitleMatchesTrack(track, title)) {
    return false;
  }
  if (!kugouListingIncludesPrimaryArtist(track.artist, artist)) {
    const overlap = getBestArtistOverlap(track.artist, artist);
    if (overlap < 0.75) {
      return false;
    }
  }

  const trackCore = normalizeCoreTitle(track?.title || "");
  const candidateCore = normalizeCoreTitle(normalizeKugouCatalogText(title));
  const durationDelta =
    track.durationMs > 0 && durationMs > 0
      ? Math.abs(durationMs - track.durationMs)
      : 0;
  const coArtistListing =
    kugouListingIncludesPrimaryArtist(track.artist, artist) &&
    splitKugouArtistNames(artist).length > 1;
  const exactTitleMatch =
    Boolean(trackCore) &&
    (trackCore === candidateCore ||
      extractBracketedTitleSegments(title).some(
        (segment) => normalizeCoreTitle(segment) === trackCore,
      ));
  const hangulTitleLinked =
    titleLinked &&
    Boolean(trackCore) &&
    needsExactShortTextMatch(trackCore) &&
    Boolean(candidateCore) &&
    !/[a-z0-9]/i.test(candidateCore) &&
    containsHangulText(candidateCore);
  const hasDurationComparison = track.durationMs > 0 && durationMs > 0;

  if (coArtistListing && exactTitleMatch) {
    const tolerance = needsExactShortTextMatch(trackCore) ? 6_000 : 12_000;
    return !hasDurationComparison || durationDelta <= tolerance;
  }
  if (hangulTitleLinked || exactTitleMatch) {
    const tolerance = needsExactShortTextMatch(trackCore) ? 45_000 : 25_000;
    return !hasDurationComparison || durationDelta <= tolerance;
  }
  return false;
}

async function collectKugouTitleLinkedKeys(track) {
  const rawTitle = String(track?.title || "").trim();
  const artistPrimary = getSpotifyPrimaryArtist(track?.artist || "");
  const titleCore = normalizeCoreTitle(rawTitle);
  if (!rawTitle || !artistPrimary || !needsExactShortTextMatch(titleCore)) {
    return new Set();
  }
  try {
    const payload = await searchKugouSongs(`${rawTitle} ${artistPrimary}`);
    const songs = Array.isArray(payload?.data?.info) ? payload.data.info : [];
    const keys = new Set();
    for (const song of flattenKugouSearchResults(songs)) {
      const normalized = normalizeKugouSong(song);
      if (!normalized.hash) {
        continue;
      }
      if (!containsHangulText(normalized.title)) {
        continue;
      }
      if (!kugouListingIncludesPrimaryArtist(track.artist, normalized.artist)) {
        continue;
      }
      keys.add(`${normalized.hash}:${normalized.albumAudioId}`);
    }
    return keys;
  } catch {
    return new Set();
  }
}

function buildKugouQueryVariants(track) {
  const rawTitle = String(track?.title || "").trim();
  const artistPrimary = getSpotifyPrimaryArtist(track?.artist || "");
  const rawArtist = String(track?.artist || "").trim();
  const titleCore = normalizeCoreTitle(rawTitle);
  const prioritized = [];
  if (artistPrimary && rawTitle) {
    prioritized.push(`${rawTitle} ${artistPrimary}`.trim());
  }
  if (artistPrimary) {
    prioritized.push(artistPrimary);
  }
  if (rawArtist && rawArtist !== artistPrimary) {
    prioritized.push(rawArtist);
  }
  if (needsExactShortTextMatch(titleCore) && artistPrimary) {
    prioritized.push(`(${rawTitle}) ${artistPrimary}`.trim());
    if (titleCore.length <= 3) {
      prioritized.push(`ㅠ`);
      prioritized.push(`${artistPrimary} ㅠ`.trim());
    }
  }
  const merged = [...prioritized, ...buildQueryVariants(track)];
  const deduped = [];
  const seen = new Set();
  for (const value of merged) {
    const normalized = String(value || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(String(value).trim());
  }
  return deduped;
}

function scoreKugouCatalogTitleBonus(track, title) {
  if (titleCoreMatchesQuery(track, title)) {
    return 0;
  }
  return kugouTitleMatchesTrack(track, title) ? 5 : 0;
}

function flattenKugouSearchResults(songs) {
  const flattened = [];
  for (const song of songs) {
    if (!song || typeof song !== "object") {
      continue;
    }
    flattened.push(song);
    if (Array.isArray(song.group)) {
      flattened.push(...song.group);
    }
  }
  return flattened;
}

function normalizeKugouSong(song) {
  const hash = String(song?.hash || song?.FileHash || "").trim();
  const albumAudioId = String(
    song?.album_audio_id || song?.album_id || "",
  ).trim();
  const title = String(
    song?.songname ||
      song?.songname_original ||
      song?.filename ||
      "",
  ).trim();
  const artist = String(song?.singername || "").trim();
  const durationSec = Number(song?.duration || 0);
  const durationMs =
    Number.isFinite(durationSec) && durationSec > 0
      ? Math.round(durationSec * 1000)
      : 0;
  return { hash, albumAudioId, title, artist, durationMs, raw: song };
}

async function searchKugouSongs(query, { timeoutMs = 10_000 } = {}) {
  return fetchJsonFromAnyEndpoint(KUGOU_SEARCH_ENDPOINTS, {
    params: {
      format: "json",
      keyword: query,
      page: 1,
      pagesize: 30,
      showtype: 1,
    },
    timeoutMs,
  });
}

async function searchKugouLyricCandidates(song, { timeoutMs = 8_000 } = {}) {
  return fetchJsonFromAnyEndpoint(KUGOU_LYRIC_SEARCH_ENDPOINTS, {
    params: {
      ver: 1,
      man: "yes",
      client: "pc",
      keyword: "",
      duration: song.durationMs || 0,
      hash: song.hash,
      album_audio_id: song.albumAudioId,
    },
    timeoutMs,
  });
}

async function downloadKugouLyric(candidate, { timeoutMs = 8_000 } = {}) {
  return fetchJsonFromAnyEndpoint(KUGOU_LYRIC_DOWNLOAD_ENDPOINTS, {
    params: {
      ver: 1,
      client: "pc",
      id: candidate.id,
      accesskey: candidate.accesskey,
      fmt: "krc",
      charset: "utf8",
    },
    timeoutMs,
  });
}

function rankKugouLyricCandidate(track, candidate) {
  let score = Number(candidate?.score || 0);
  const candidateDuration = Number(candidate?.duration || 0);
  const trackDuration = Number(track?.durationMs || 0);
  if (trackDuration > 0 && candidateDuration > 0) {
    const delta = Math.abs(candidateDuration - trackDuration);
    const tolerance = Math.max(5_000, trackDuration * 0.06);
    if (delta <= tolerance) {
      score += 12;
    } else if (delta <= tolerance * 2) {
      score += 4;
    } else {
      score -= Math.min(20, Math.floor(delta / 1000));
    }
  }
  if (Number(candidate?.krctype || 0) === 1) {
    score += 8;
  }
  return score;
}

async function fetchKugouKaraokeLyricsForSong(track, song, matchScore) {
  const lyricSearchPayload = await searchKugouLyricCandidates(song);
  const lyricCandidates = Array.isArray(lyricSearchPayload?.candidates)
    ? lyricSearchPayload.candidates
    : [];
  if (!lyricCandidates.length) {
    return null;
  }

  const rankedLyrics = lyricCandidates
    .map((entry) => ({
      entry,
      score: rankKugouLyricCandidate(track, entry),
    }))
    .sort((left, right) => right.score - left.score);

  for (const { entry } of rankedLyrics.slice(0, 3)) {
    if (!entry?.id || !entry?.accesskey) {
      continue;
    }
    try {
      const downloadPayload = await downloadKugouLyric(entry);
      const encodedContent = String(downloadPayload?.content || "").trim();
      if (!encodedContent) {
        continue;
      }
      const decodedKrc = decodeKugouKrc(encodedContent);
      const karaokeLyrics = stripLeadingMetadataLines(
        parseKugouKrc(decodedKrc),
        track,
      );
      if (!karaokeLyrics.length) {
        continue;
      }
      const coverage = scoreLyricsCoverage(karaokeLyrics, track.durationMs);
      const coverageRatio = getLyricsCoverageRatio(
        karaokeLyrics,
        track.durationMs,
      );
      return {
        lyrics: karaokeLyrics,
        source: "kugou-krc",
        coverage,
        coverageRatio,
        matchScore,
      };
    } catch {
      // Try the next lyric candidate.
    }
  }

  return null;
}

async function collectRankedKugouSearchCandidates(track) {
  const queryVariants = buildKugouQueryVariants(track).slice(
    0,
    KUGOU_MAX_QUERY_VARIANTS,
  );
  const titleLinkedKeys = await collectKugouTitleLinkedKeys(track);
  const rawSongs = [];

  await Promise.all(
    queryVariants.map(async (query) => {
      try {
        const payload = await searchKugouSongs(query);
        const songs = Array.isArray(payload?.data?.info) ? payload.data.info : [];
        rawSongs.push(...flattenKugouSearchResults(songs));
      } catch {
        // Try next query variant.
      }
    }),
  );

  const deduped = [];
  const seen = new Set();
  for (const song of rawSongs) {
    const normalized = normalizeKugouSong(song);
    if (!normalized.hash) {
      continue;
    }
    const dedupeKey = `${normalized.hash}:${normalized.albumAudioId}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    deduped.push({
      ...normalized,
      titleLinked: titleLinkedKeys.has(dedupeKey),
    });
  }

  return deduped
    .map((song) => {
      let score = scoreCandidate(track, song.title, song.artist);
      score += scoreDurationBonus(
        track,
        song.title,
        song.artist,
        song.durationMs,
      );
      score += scoreKugouCatalogTitleBonus(track, song.title);
      if (
        isLikelySameKugouTrack(track, song.title, song.artist, song.durationMs, {
          titleLinked: song.titleLinked,
        })
      ) {
        score += 6;
      }
      if (song.titleLinked) {
        score += 8;
      }
      return {
        song,
        score,
        title: song.title,
        artist: song.artist,
        durationMs: song.durationMs,
        hash: song.hash,
        albumAudioId: song.albumAudioId,
        titleLinked: song.titleLinked,
      };
    })
    .sort((left, right) => right.score - left.score);
}

async function previewKugouSearchCandidates(track) {
  return collectRankedKugouSearchCandidates(track);
}

async function fetchFromKugou(track) {
  const ranked = await collectRankedKugouSearchCandidates(track);
  if (!ranked.length) {
    return null;
  }

  const likelyCandidates = ranked
    .filter((candidate) =>
      isLikelySameKugouTrack(
        track,
        candidate.title,
        candidate.artist,
        candidate.durationMs,
        { titleLinked: candidate.titleLinked },
      ),
    )
    .sort((left, right) => compareCandidateMatchQuality(track, left, right))
    .slice(0, MAX_KUGOU_CANDIDATES);

  let bestResult = null;
  let bestScore = -1;

  for (const candidate of likelyCandidates) {
    try {
      const probe = await fetchKugouKaraokeLyricsForSong(
        track,
        candidate.song,
        candidate.score,
      );
      if (!probe?.lyrics?.length) {
        continue;
      }
      if (probe.coverage > bestScore) {
        bestScore = probe.coverage;
        bestResult = { lyrics: probe.lyrics, source: probe.source };
      }
      if (
        candidate.score >= MATCH_CONFIDENCE_SCORE &&
        probe.coverageRatio >= EARLY_RETURN_COVERAGE_RATIO
      ) {
        return { lyrics: probe.lyrics, source: probe.source };
      }
    } catch {
      // Try next candidate.
    }
  }

  return bestResult;
}

// ---- DesktopBridge/src/lyrics/parts/05a-musixmatch-client.js ----
// Musixmatch client profiles, token resolution, richsync/subtitle fetching, translation mapping, and source adapter.
// This file is evaluated by ../index.js in a shared compatibility context.
// Keep behavior changes deliberate; most code here was moved verbatim from src/lyricsService.js.

function normalizeMusixmatchBody(payload) {
  const header = payload?.message?.header || payload?.header || {};
  const body = payload?.message?.body || payload?.body || {};
  const hint = String(header?.hint || "").trim();
  const statusCode = Number(header?.status_code || 0);
  return { statusCode, hint, body };
}

function assertMusixmatchSuccess(payload, endpointLabel) {
  const { statusCode, hint, body } = normalizeMusixmatchBody(payload);
  const hintSuffix = hint ? ` (${hint})` : "";
  if (hint.toLowerCase().includes("captcha")) {
    throw new Error(`Musixmatch blocked request with captcha${hintSuffix}.`);
  }
  if (statusCode === 401 || statusCode === 403) {
    throw new Error(`Musixmatch user token was rejected${hintSuffix}.`);
  }
  if (statusCode > 0 && statusCode !== 200 && statusCode !== 404) {
    throw new Error(
      `Musixmatch ${endpointLabel} failed with status ${statusCode}${hintSuffix}.`,
    );
  }
  return { statusCode, hint, body };
}

function extractMusixmatchTracks(payload) {
  const { body } = assertMusixmatchSuccess(payload, "track.search");
  const list = Array.isArray(body?.track_list) ? body.track_list : [];
  return list
    .map((entry) => entry?.track || entry)
    .filter((trackEntry) => trackEntry && typeof trackEntry === "object");
}

function extractMusixmatchMatchedTrack(payload) {
  const { body } = assertMusixmatchSuccess(payload, "matcher.track.get");
  const direct = body?.track || body?.matcher?.track;
  if (direct && typeof direct === "object") {
    return direct;
  }
  const macroTrack =
    body?.macro_calls?.["matcher.track.get"]?.message?.body?.track;
  if (macroTrack && typeof macroTrack === "object") {
    return macroTrack;
  }
  return null;
}

function toMusixmatchDurationMs(track) {
  const directMs = Number(track?.duration_ms || track?.track_length_ms || 0);
  if (Number.isFinite(directMs) && directMs > 0) {
    return directMs;
  }
  const seconds = Number(track?.track_length || track?.duration || 0);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds < 10_000 ? seconds * 1000 : seconds;
  }
  return 0;
}

function findFirstNestedStringByKey(value, keyName, depth = 0) {
  if (depth > 10 || value === null || value === undefined) {
    return "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstNestedStringByKey(item, keyName, depth + 1);
      if (found) {
        return found;
      }
    }
    return "";
  }
  if (typeof value !== "object") {
    return "";
  }
  const direct = value[keyName];
  if (typeof direct === "string" && direct.trim()) {
    return direct;
  }
  for (const nestedValue of Object.values(value)) {
    const found = findFirstNestedStringByKey(nestedValue, keyName, depth + 1);
    if (found) {
      return found;
    }
  }
  return "";
}

function extractMusixmatchSubtitleBody(
  payload,
  endpointLabel = "track.subtitle.get",
) {
  const { body } = assertMusixmatchSuccess(payload, endpointLabel);
  const directSubtitle = body?.subtitle?.subtitle_body;
  if (typeof directSubtitle === "string" && directSubtitle.trim()) {
    return directSubtitle;
  }

  const subtitleList = Array.isArray(body?.subtitle_list)
    ? body.subtitle_list
    : [];
  for (const entry of subtitleList) {
    const text = entry?.subtitle?.subtitle_body;
    if (typeof text === "string" && text.trim()) {
      return text;
    }
  }

  const macroCalls = body?.macro_calls || {};
  const macroSubtitle =
    macroCalls?.["track.subtitle.get"]?.message?.body?.subtitle?.subtitle_body;
  if (typeof macroSubtitle === "string" && macroSubtitle.trim()) {
    return macroSubtitle;
  }

  const nestedSubtitle = findFirstNestedStringByKey(body, "subtitle_body");
  if (nestedSubtitle) {
    return nestedSubtitle;
  }
  return "";
}

function tryParseMusixmatchTokenObject(rawToken) {
  const raw = String(rawToken || "").trim();
  if (!raw) {
    return null;
  }
  const variants = [raw];
  const decoded = decodeUriComponentSafe(raw);
  if (decoded && decoded !== raw) {
    variants.push(decoded);
  }

  for (const candidate of variants) {
    let normalized = String(candidate || "").trim();
    if (
      (normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'"))
    ) {
      normalized = normalized.slice(1, -1).trim();
    }
    if (!normalized.startsWith("{") || !normalized.endsWith("}")) {
      continue;
    }
    const parsed = tryParseJson(normalized);
    if (
      parsed.ok &&
      parsed.value &&
      typeof parsed.value === "object" &&
      !Array.isArray(parsed.value)
    ) {
      return parsed.value;
    }
  }
  return null;
}

function buildMusixmatchProfileForAppId(appId) {
  const normalizedAppId = String(appId || "").trim();
  if (!normalizedAppId) {
    return null;
  }
  const existing = MUSIXMATCH_CLIENT_PROFILES.find(
    (profile) => profile.appId === normalizedAppId,
  );
  if (existing) {
    const existingLower = existing.appId.toLowerCase();
    const existingIsIosLike =
      existingLower.includes("ios") ||
      existingLower.includes("iphone") ||
      existingLower.includes("ipad");
    return {
      appId: existing.appId,
      tokenKey: existing.tokenKey,
      userAgent: existing.userAgent,
      userLanguage: existing.userLanguage,
      cookieHeader: existing.cookieHeader,
      baseUrls: Array.isArray(existing.baseUrls)
        ? [...existing.baseUrls]
        : [...MUSIXMATCH_DEFAULT_BASE_URLS],
      defaultParams:
        existing.defaultParams ||
        (existingIsIosLike
          ? {
              app_version: MUSIXMATCH_IOS_DEBUG_CONTEXT.appVersion,
              build_number: MUSIXMATCH_IOS_DEBUG_CONTEXT.appBuild,
              os_version: MUSIXMATCH_IOS_DEBUG_CONTEXT.osVersion,
              user_id: MUSIXMATCH_IOS_DEBUG_CONTEXT.userId,
              country: MUSIXMATCH_IOS_DEBUG_CONTEXT.country,
              guid: MUSIXMATCH_IOS_DEBUG_CONTEXT.deviceId,
              device_id: MUSIXMATCH_IOS_DEBUG_CONTEXT.deviceId,
            }
          : {}),
    };
  }

  const lower = normalizedAppId.toLowerCase();
  const iosTemplate =
    MUSIXMATCH_CLIENT_PROFILES.find((profile) =>
      profile.appId.toLowerCase().includes("ios"),
    ) || MUSIXMATCH_CLIENT_PROFILES[0];
  const androidTemplate =
    MUSIXMATCH_CLIENT_PROFILES.find((profile) =>
      profile.appId.toLowerCase().includes("android"),
    ) || MUSIXMATCH_CLIENT_PROFILES[0];
  const webTemplate =
    MUSIXMATCH_CLIENT_PROFILES.find((profile) =>
      profile.appId.toLowerCase().includes("web-desktop"),
    ) || MUSIXMATCH_CLIENT_PROFILES[0];

  const template =
    lower.includes("ios") || lower.includes("iphone") || lower.includes("ipad")
      ? iosTemplate
      : lower.includes("android")
        ? androidTemplate
        : webTemplate;

  const isIosLike =
    lower.includes("ios") || lower.includes("iphone") || lower.includes("ipad");

  return {
    appId: normalizedAppId,
    tokenKey: normalizedAppId,
    userAgent: template.userAgent,
    userLanguage: template.userLanguage,
    cookieHeader: template.cookieHeader,
    baseUrls: Array.isArray(template.baseUrls)
      ? [...template.baseUrls]
      : [...MUSIXMATCH_DEFAULT_BASE_URLS],
    defaultParams: isIosLike
      ? {
          app_version: MUSIXMATCH_IOS_DEBUG_CONTEXT.appVersion,
          build_number: MUSIXMATCH_IOS_DEBUG_CONTEXT.appBuild,
          os_version: MUSIXMATCH_IOS_DEBUG_CONTEXT.osVersion,
          user_id: MUSIXMATCH_IOS_DEBUG_CONTEXT.userId,
          country: MUSIXMATCH_IOS_DEBUG_CONTEXT.country,
          guid: MUSIXMATCH_IOS_DEBUG_CONTEXT.deviceId,
          device_id: MUSIXMATCH_IOS_DEBUG_CONTEXT.deviceId,
        }
      : {},
  };
}

function extractMusixmatchTokenStringCandidates(rawToken) {
  const candidates = [];
  const pushCandidate = (value) => {
    const safe = String(value || "").trim();
    if (!safe) {
      return;
    }
    if (!candidates.includes(safe)) {
      candidates.push(safe);
    }
  };

  const safeRaw = String(rawToken || "").trim();
  pushCandidate(safeRaw);
  const decoded = decodeUriComponentSafe(safeRaw);
  pushCandidate(decoded);

  // "Bearer xxx" appears in some mobile-debug dumps.
  if (/^bearer\s+/i.test(safeRaw)) {
    pushCandidate(safeRaw.replace(/^bearer\s+/i, ""));
  }
  return candidates;
}

function collectNestedStringEntries(value, depth = 0, entries = []) {
  if (depth > 12 || value === null || value === undefined) {
    return entries;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectNestedStringEntries(item, depth + 1, entries);
    }
    return entries;
  }
  if (typeof value !== "object") {
    return entries;
  }
  for (const [key, nestedValue] of Object.entries(value)) {
    if (typeof nestedValue === "string") {
      entries.push({ key: String(key), value: nestedValue });
      continue;
    }
    collectNestedStringEntries(nestedValue, depth + 1, entries);
  }
  return entries;
}

function looksLikeMusixmatchAppIdKey(key) {
  const normalized = String(key || "")
    .trim()
    .toLowerCase();
  if (!normalized || !/^[a-z0-9._-]+$/.test(normalized)) {
    return false;
  }
  if (!/-v\d+\.\d+$/.test(normalized)) {
    return false;
  }
  return (
    normalized.includes("app") ||
    normalized.includes("ios") ||
    normalized.includes("iphone") ||
    normalized.includes("android") ||
    normalized.includes("desktop") ||
    normalized.includes("web")
  );
}

function looksLikeMusixmatchTokenValue(value) {
  const safe = String(value || "").trim();
  if (!safe || safe.length < 12 || /\s/.test(safe)) {
    return false;
  }
  return !safe.startsWith("{") && !safe.startsWith("[");
}

function shouldAbortMusixmatchTokenAttempt(error) {
  const reason = describeSourceError(error);
  return reason === "unauthorized" || reason === "rate-limited";
}

async function getMusixmatchSignatureSecret({ timeoutMs = 6_000 } = {}) {
  const now = Date.now();
  if (
    musixmatchSignatureSecretCache.value &&
    musixmatchSignatureSecretCache.expiresAt > now
  ) {
    return musixmatchSignatureSecretCache.value;
  }

  let signatureSecret = MUSIXMATCH_SIGNATURE_FALLBACK_SECRET;
  try {
    const communityHtml = await fetchText(
      "https://www.musixmatch.com/community",
      {
        timeoutMs,
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        },
      },
    );
    const scriptPathMatch =
      communityHtml.match(/"(https?:\/\/[^"]*common-[^"]+\.js)"/i) ||
      communityHtml.match(/"(\/\/[^"]*common-[^"]+\.js)"/i) ||
      communityHtml.match(/"(\/[^"]*common-[^"]+\.js)"/i);
    if (scriptPathMatch?.[1]) {
      const rawScriptUrl = String(scriptPathMatch[1]);
      const scriptUrl = rawScriptUrl.startsWith("//")
        ? `https:${rawScriptUrl}`
        : rawScriptUrl.startsWith("/")
          ? `https://www.musixmatch.com${rawScriptUrl}`
          : rawScriptUrl;
      const scriptBody = await fetchText(scriptUrl, {
        timeoutMs,
        headers: {
          Accept: "*/*",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        },
      });
      const secretMatch =
        scriptBody.match(/signatureSecret\s*:\s*"([a-fA-F0-9]{40})"/) ||
        scriptBody.match(/signatureSecret\\?":\\?"([a-fA-F0-9]{40})"/);
      if (secretMatch?.[1]) {
        signatureSecret = secretMatch[1];
      }
    }
  } catch {
    // Fall back to known static key when scraping fails.
  }

  musixmatchSignatureSecretCache.value = signatureSecret;
  musixmatchSignatureSecretCache.expiresAt =
    Date.now() + MUSIXMATCH_SIGNATURE_CACHE_TTL_MS;
  return signatureSecret;
}

function appendMusixmatchSignature(unsignedUrl, signatureSecret) {
  const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const hmacPayload = `${unsignedUrl}${dateStamp}`;
  const signature = crypto
    .createHmac(
      "sha1",
      String(signatureSecret || MUSIXMATCH_SIGNATURE_FALLBACK_SECRET),
    )
    .update(hmacPayload, "utf8")
    .digest("base64");
  const separator = unsignedUrl.includes("?") ? "&" : "?";
  return `${unsignedUrl}${separator}signature=${encodeURIComponent(signature)}&signature_protocol=sha1`;
}

function resolveMusixmatchClientCandidates(rawToken) {
  const safeRaw = String(rawToken || "").trim();
  if (!safeRaw) {
    return [];
  }

  const resolved = [];
  const seen = new Set();
  const pushCandidate = (profile, token, tokenSource) => {
    const safeToken = String(token || "").trim();
    if (!safeToken) {
      return;
    }
    const signature = `${profile.appId}|${safeToken}`;
    if (seen.has(signature)) {
      return;
    }
    seen.add(signature);
    resolved.push({
      ...profile,
      userToken: safeToken,
      tokenSource: tokenSource || "raw",
    });
  };

  const parsedTokenObject =
    tryParseMusixmatchTokenObject(safeRaw) ||
    (() => {
      for (const candidate of extractMusixmatchTokenStringCandidates(safeRaw)) {
        const parsed = tryParseMusixmatchTokenObject(candidate);
        if (parsed) {
          return parsed;
        }
      }
      return null;
    })();

  const collectPrioritizedTokenEntries = (parsedObject) => {
    const entries = [];
    const seen = new Set();
    const addEntry = (key, token) => {
      const safeKey = String(key || "").trim();
      const safeToken = String(token || "").trim();
      if (!safeKey || !safeToken) {
        return;
      }
      const signature = `${safeKey}|${safeToken}`;
      if (seen.has(signature)) {
        return;
      }
      seen.add(signature);
      entries.push({ key: safeKey, token: safeToken });
    };

    for (const key of MUSIXMATCH_TOKEN_PRIORITY_KEYS) {
      addEntry(key, findFirstNestedStringByKey(parsedObject, key));
    }
    const desktopToken = entries.find(
      (entry) => entry.key === "web-desktop-app-v1.0",
    );
    const ordered = desktopToken
      ? [
          desktopToken,
          ...entries.filter((entry) => entry.key !== "web-desktop-app-v1.0"),
        ]
      : entries;
    const hasPriorityToken = entries.length > 0;
    if (hasPriorityToken) {
      return ordered.slice(0, 4);
    }
    for (const entry of collectNestedStringEntries(parsedObject)) {
      if (!looksLikeMusixmatchAppIdKey(entry.key)) {
        continue;
      }
      if (!looksLikeMusixmatchTokenValue(entry.value)) {
        continue;
      }
      addEntry(entry.key, entry.value);
    }
    return entries;
  };

  const profileByAppId = new Map();
  for (const profile of MUSIXMATCH_CLIENT_PROFILES) {
    profileByAppId.set(profile.appId, profile);
  }
  for (const appId of [
    ...MUSIXMATCH_KNOWN_TOKEN_KEYS,
    ...MUSIXMATCH_IOS_APP_ID_CANDIDATES,
  ]) {
    const profile = buildMusixmatchProfileForAppId(appId);
    if (profile && !profileByAppId.has(profile.appId)) {
      profileByAppId.set(profile.appId, profile);
    }
  }
  const nestedStringEntries = collectNestedStringEntries(parsedTokenObject);
  for (const entry of nestedStringEntries) {
    if (!looksLikeMusixmatchAppIdKey(entry.key)) {
      continue;
    }
    const dynamicProfile = buildMusixmatchProfileForAppId(entry.key);
    if (dynamicProfile && !profileByAppId.has(dynamicProfile.appId)) {
      profileByAppId.set(dynamicProfile.appId, dynamicProfile);
    }
  }
  const allProfiles = [...profileByAppId.values()];

  if (!parsedTokenObject) {
    for (const tokenCandidate of extractMusixmatchTokenStringCandidates(
      safeRaw,
    )) {
      const prioritizedProfiles = MUSIXMATCH_RAW_TOKEN_PROFILE_PRIORITY.map(
        (appId) => allProfiles.find((profile) => profile.appId === appId),
      ).filter(Boolean);
      const profilesToTry = prioritizedProfiles.length
        ? prioritizedProfiles
        : allProfiles.slice(0, 3);
      for (const profile of profilesToTry) {
        pushCandidate(profile, tokenCandidate, "raw");
      }
    }
    return resolved;
  }

  const prioritizedEntries = collectPrioritizedTokenEntries(parsedTokenObject);
  for (const prioritizedEntry of prioritizedEntries) {
    const prioritizedProfile = buildMusixmatchProfileForAppId(
      prioritizedEntry.key,
    );
    if (prioritizedProfile) {
      pushCandidate(
        prioritizedProfile,
        prioritizedEntry.token,
        prioritizedEntry.key,
      );
    }
  }
  if (prioritizedEntries.length) {
    return resolved;
  }

  for (const profile of allProfiles) {
    pushCandidate(
      profile,
      findFirstNestedStringByKey(parsedTokenObject, profile.tokenKey),
      profile.tokenKey,
    );
  }
  for (const appId of MUSIXMATCH_KNOWN_TOKEN_KEYS) {
    const tokenForKnownKey = findFirstNestedStringByKey(
      parsedTokenObject,
      appId,
    );
    if (!tokenForKnownKey) {
      continue;
    }
    const profile = buildMusixmatchProfileForAppId(appId);
    if (profile) {
      pushCandidate(profile, tokenForKnownKey, appId);
    }
  }
  for (const fallbackKey of MUSIXMATCH_TOKEN_FALLBACK_KEYS) {
    const fallbackToken = findFirstNestedStringByKey(
      parsedTokenObject,
      fallbackKey,
    );
    if (!fallbackToken) {
      continue;
    }
    for (const profile of allProfiles) {
      pushCandidate(profile, fallbackToken, fallbackKey);
    }
  }
  for (const entry of nestedStringEntries) {
    if (!looksLikeMusixmatchAppIdKey(entry.key)) {
      continue;
    }
    if (!looksLikeMusixmatchTokenValue(entry.value)) {
      continue;
    }
    const dynamicProfile = buildMusixmatchProfileForAppId(entry.key);
    if (dynamicProfile) {
      pushCandidate(dynamicProfile, entry.value, entry.key);
    }
  }
  return resolved;
}

async function fetchMusixmatchJson(
  path,
  params,
  {
    timeoutMs = 12_000,
    appId = "web-desktop-app-v1.0",
    userToken = "",
    userAgent = "KineSyncDesktopBridge/1.0",
    userLanguage = "en",
    cookieHeader = "",
    baseUrls = MUSIXMATCH_DEFAULT_BASE_URLS,
    defaultParams = {},
    requireSignature = true,
  } = {},
) {
  const endpoints = (
    Array.isArray(baseUrls) && baseUrls.length
      ? baseUrls
      : MUSIXMATCH_DEFAULT_BASE_URLS
  ).map((baseUrl) => `${baseUrl}${path}`);
  let lastError = null;
  const signatureSecret = requireSignature
    ? await getMusixmatchSignatureSecret()
    : "";

  for (const endpoint of endpoints) {
    const requestParams = {
      ...defaultParams,
      app_id: appId,
      format: "json",
      user_language: userLanguage,
      usertoken: userToken || undefined,
      guid:
        params?.guid ||
        defaultParams?.guid ||
        defaultParams?.device_id ||
        crypto.randomUUID(),
      ...params,
    };
    try {
      const unsignedUrl = buildMusixmatchUrlWithParams(endpoint, requestParams);
      const requestUrls = requireSignature
        ? [appendMusixmatchSignature(unsignedUrl, signatureSecret), unsignedUrl]
        : [unsignedUrl];
      for (const requestUrl of requestUrls) {
        const responseText = await fetchText(requestUrl, {
          timeoutMs,
          headers: {
            Accept: "application/json,text/plain,*/*",
            "User-Agent": userAgent,
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          },
        });
        const payload = parseJsonLenient(responseText);
        const statusCode = Number(
          payload?.message?.header?.status_code ||
            payload?.header?.status_code ||
            0,
        );
        // If one mode returns auth rejection, try the alternate mode first.
        if (
          requireSignature &&
          statusCode === 401 &&
          requestUrl !== requestUrls[requestUrls.length - 1]
        ) {
          continue;
        }
        return payload;
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("All Musixmatch endpoint attempts failed");
}

// ---- DesktopBridge/src/lyrics/parts/05b-musixmatch-parsing.js ----
function buildMusixmatchMatcherQueries(track) {
  const durationSec =
    Number(track?.durationMs || 0) > 0
      ? Math.max(1, Math.round(Number(track.durationMs) / 1000))
      : 0;
  const durationFilters = durationSec
    ? {
        f_subtitle_length: durationSec,
        f_subtitle_length_max_deviation: 8,
      }
    : {};
  const artistVariants = buildMusixmatchArtistVariants(track.artist);
  const primaryArtistVariants =
    artistVariants.length > 0
      ? artistVariants
      : [String(track.artist || "").trim()];
  const queries = [];

  for (const artist of primaryArtistVariants) {
    queries.push({
      q_track: track.title,
      q_artist: artist,
      q_album: track.album || undefined,
      ...durationFilters,
    });
  }

  for (const query of buildQueryVariants(track).slice(0, MAX_QUERY_VARIANTS)) {
    for (const artist of primaryArtistVariants.slice(0, 2)) {
      queries.push({
        q_track: query,
        q_artist: artist,
        ...durationFilters,
      });
    }
  }

  if (queries.length) {
    const relaxed = { ...queries[0] };
    delete relaxed.q_artist;
    queries.push(relaxed);
  }

  const deduped = [];
  const seen = new Set();
  for (const query of queries) {
    const key = JSON.stringify(query);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(query);
  }
  return deduped;
}

async function fetchMusixmatchTrackCandidates(track, requestOptions) {
  const matches = [];
  let lastError = null;

  for (const query of buildMusixmatchMatcherQueries(track)) {
    try {
      const payload = await fetchMusixmatchJson(
        "/matcher.track.get",
        query,
        requestOptions,
      );
      const matchedTrack = extractMusixmatchMatchedTrack(payload);
      if (matchedTrack) {
        matches.push(matchedTrack);
      }
    } catch (error) {
      lastError = error;
      if (shouldAbortMusixmatchTokenAttempt(error)) {
        return { matches, lastError };
      }
    }
  }

  const searchQueryVariants = buildQueryVariants(track).slice(
    0,
    MAX_QUERY_VARIANTS,
  );
  const artistVariants = buildMusixmatchArtistVariants(track.artist);
  for (const query of searchQueryVariants) {
    if (matches.length >= 16) {
      break;
    }
    const artistQueryVariants =
      artistVariants.length > 0
        ? artistVariants
        : [String(track.artist || "").trim()];
    for (const artist of artistQueryVariants.slice(0, 2)) {
      try {
        const payload = await fetchMusixmatchJson(
          "/track.search",
          {
            q_track: query,
            q_artist: artist,
            page_size: 12,
            page: 1,
            s_track_rating: "desc",
            f_has_subtitles: 1,
          },
          requestOptions,
        );
        const candidates = extractMusixmatchTracks(payload);
        matches.push(...candidates);
      } catch (error) {
        lastError = error;
        if (shouldAbortMusixmatchTokenAttempt(error)) {
          return { matches, lastError };
        }
      }
    }
  }

  // Final relaxed fallback for stubborn metadata mismatches: try title-only search.
  if (!matches.length) {
    for (const query of searchQueryVariants.slice(0, 2)) {
      try {
        const payload = await fetchMusixmatchJson(
          "/track.search",
          {
            q_track: query,
            page_size: 12,
            page: 1,
            s_track_rating: "desc",
            f_has_subtitles: 1,
          },
          requestOptions,
        );
        const candidates = extractMusixmatchTracks(payload);
        matches.push(...candidates);
      } catch (error) {
        lastError = error;
        if (shouldAbortMusixmatchTokenAttempt(error)) {
          return { matches, lastError };
        }
      }
    }
  }

  return { matches, lastError };
}

function extractMusixmatchCandidateIdentity(candidate) {
  const trackId = Number(candidate?.track_id || candidate?.id || 0);
  if (trackId > 0) {
    return `track:${trackId}`;
  }
  const commonTrackId = Number(
    candidate?.commontrack_id || candidate?.commontrackid || 0,
  );
  if (commonTrackId > 0) {
    return `common:${commonTrackId}`;
  }
  const title = normalizeText(candidate?.track_name || candidate?.name || "");
  const artist = normalizeText(
    candidate?.artist_name || candidate?.artist || "",
  );
  return `${title}|${artist}`;
}

function normalizeMusixmatchSongwriterNames(value, output = []) {
  if (value === null || value === undefined) {
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      normalizeMusixmatchSongwriterNames(item, output);
    }
    return output;
  }
  if (typeof value === "object") {
    const direct =
      value.name ||
      value.writer_name ||
      value.songwriter_name ||
      value.artist_name ||
      value.description;
    if (direct) {
      normalizeMusixmatchSongwriterNames(direct, output);
      return output;
    }
    for (const nested of Object.values(value)) {
      normalizeMusixmatchSongwriterNames(nested, output);
    }
    return output;
  }
  const text = String(value || "").trim();
  if (!text) {
    return output;
  }
  for (const part of text.split(/\s*(?:,|;|\/|\||&|\band\b)\s*/i)) {
    const safe = String(part || "").trim();
    if (safe && !output.some((entry) => entry.toLowerCase() === safe.toLowerCase())) {
      output.push(safe);
    }
  }
  return output;
}

function extractMusixmatchSongwriters(candidate) {
  const names = [];
  for (const value of [
    candidate?.writer_list,
    candidate?.writers,
    candidate?.songwriters,
    candidate?.songwriter_list,
    candidate?.track_writer_list,
    candidate?.lyrics_writer_list,
    candidate?.writer,
    candidate?.lyrics_writer,
  ]) {
    normalizeMusixmatchSongwriterNames(value, names);
  }
  return names.slice(0, 12);
}

function extractMusixmatchIdentifierRequests(candidate) {
  const requests = [];
  const seen = new Set();
  const pushRequest = (key, rawValue) => {
    const value = Math.floor(Number(rawValue || 0));
    if (!Number.isFinite(value) || value <= 0) {
      return;
    }
    const signature = `${key}:${value}`;
    if (seen.has(signature)) {
      return;
    }
    seen.add(signature);
    requests.push({ [key]: value });
  };

  pushRequest("commontrack_id", candidate?.commontrack_id);
  pushRequest("commontrack_id", candidate?.commontrackid);
  pushRequest("track_id", candidate?.track_id);
  pushRequest("track_id", candidate?.id);
  return requests;
}

function extractMusixmatchTranslationEntries(payload, endpointLabel) {
  const { body } = assertMusixmatchSuccess(payload, endpointLabel);
  const lists = [
    ...(Array.isArray(body?.translation_list) ? [body.translation_list] : []),
    ...(Array.isArray(body?.translations_list) ? [body.translations_list] : []),
    ...(Array.isArray(body?.track_translation_list)
      ? [body.track_translation_list]
      : []),
    ...(Array.isArray(body?.lyrics_translation_list)
      ? [body.lyrics_translation_list]
      : []),
  ];

  const entries = [];
  for (const list of lists) {
    for (const item of list) {
      const node =
        item?.translation ||
        item?.track_translation ||
        item?.lyrics_translation ||
        item;
      if (!node || typeof node !== "object") {
        continue;
      }
      const language = String(
        node?.translation_language ||
          node?.selected_language ||
          node?.language ||
          node?.language_code ||
          node?.locale ||
          "",
      )
        .trim()
        .toLowerCase();
      if (
        language &&
        !language.startsWith("en") &&
        language !== "us" &&
        language !== "gb"
      ) {
        continue;
      }
      const original = String(
        node?.matched_line ||
          node?.matchedLine ||
          node?.matched_line_text ||
          node?.source_text ||
          node?.lyric ||
          node?.line ||
          "",
      ).trim();
      const translated = String(
        node?.description ||
          node?.translation_description ||
          node?.translated_line ||
          node?.translated_text ||
          node?.text ||
          "",
      ).trim();
      if (!translated) {
        continue;
      }
      entries.push({ original, translated });
    }
  }

  // Preserve repeated lines (e.g., choruses) so translation indices stay aligned.
  // Global dedupe here can collapse legitimate duplicates and shift all later lines.
  return entries;
}

async function fetchMusixmatchTranslationsForCandidate(
  candidate,
  requestOptions,
  language = MUSIXMATCH_TRANSLATION_LANGUAGE,
) {
  let lastError = null;
  const endpoints = [
    {
      path: "/crowd.track.translations.get",
      label: "crowd.track.translations.get",
    },
    { path: "/track.translations.get", label: "track.translations.get" },
  ];

  for (const identifierParams of extractMusixmatchIdentifierRequests(
    candidate,
  )) {
    for (const endpoint of endpoints) {
      for (const lang of MUSIXMATCH_TRANSLATION_LANGUAGE_FALLBACKS) {
        try {
          const payload = await fetchMusixmatchJson(
            endpoint.path,
            {
              ...identifierParams,
              selected_language: lang,
            },
            requestOptions,
          );
          const translations = extractMusixmatchTranslationEntries(
            payload,
            endpoint.label,
          );
          if (translations.length) {
            return { translations, lastError: null };
          }
        } catch (error) {
          lastError = error;
        }
      }
    }
  }
  return { translations: [], lastError };
}

function scoreTranslationLineMatch(baseText, originalText) {
  const baseNorm = normalizeText(baseText);
  const originalNorm = normalizeText(originalText);
  if (!baseNorm || !originalNorm) {
    return 0;
  }
  if (baseNorm === originalNorm) {
    return 1;
  }
  const overlap = overlapRatio(tokens(baseNorm), tokens(originalNorm));
  const containBonus =
    baseNorm.includes(originalNorm) || originalNorm.includes(baseNorm)
      ? 0.18
      : 0;
  return Math.max(0, Math.min(1, overlap + containBonus));
}

function getLineTextNormalized(line) {
  return normalizeText(getLineText(line));
}

function normalizeTranslationVisibilityText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .trim();
}

function shouldHideTranslatedText(originalText, translatedText) {
  const originalNorm = normalizeTranslationVisibilityText(originalText);
  const translatedNorm = normalizeTranslationVisibilityText(translatedText);
  return (
    Boolean(originalNorm) &&
    Boolean(translatedNorm) &&
    originalNorm === translatedNorm
  );
}

function appendTranslatedSegment(existingText, nextSegment) {
  const existing = String(existingText || "").trim();
  const next = String(nextSegment || "").trim();
  if (!next) {
    return existing;
  }
  if (!existing) {
    return next;
  }
  const existingNorm = normalizeText(existing);
  const nextNorm = normalizeText(next);
  if (!nextNorm || existingNorm.includes(nextNorm)) {
    return existing;
  }
  return `${existing} / ${next}`;
}

const TRANSLATION_MAP_MAX_SPAN = 3;
const TRANSLATION_MAP_SEARCH_WINDOW = 20;
const TRANSLATION_MAP_MIN_TEXT_SCORE = 0.5;
const TRANSLATION_MAP_MIN_COMBINED_SCORE = 0.56;
const TRANSLATION_MAP_MIN_MARGIN = 0.08;
const TRANSLATION_MAP_MAX_START_DELTA_MS = 5_200;

function parseLineTimeMs(rawValue) {
  const numeric = Number(rawValue);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : Number.NaN;
}

function getLineTimingWindow(line) {
  const start = parseLineTimeMs(line?.lineStartTime);
  const end = parseLineTimeMs(line?.lineEndTime);
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    return { hasTiming: true, start, end };
  }
  if (Number.isFinite(start)) {
    return { hasTiming: true, start, end: start };
  }
  if (Number.isFinite(end)) {
    return { hasTiming: true, start: end, end };
  }
  return { hasTiming: false, start: Number.NaN, end: Number.NaN };
}

function scoreTranslationTimingMatch(
  referenceLine,
  targetStartLine,
  targetEndLine,
) {
  const refWindow = getLineTimingWindow(referenceLine);
  const targetStartWindow = getLineTimingWindow(targetStartLine);
  const targetEndWindow = getLineTimingWindow(targetEndLine);
  if (
    !refWindow.hasTiming ||
    !targetStartWindow.hasTiming ||
    !targetEndWindow.hasTiming
  ) {
    return {
      hasTiming: false,
      score: 0,
      startDeltaMs: Number.POSITIVE_INFINITY,
    };
  }

  const startDeltaMs = Math.abs(targetStartWindow.start - refWindow.start);
  const overlapMs = Math.max(
    0,
    Math.min(targetEndWindow.end, refWindow.end) -
      Math.max(targetStartWindow.start, refWindow.start),
  );
  const overlapRatio =
    Math.max(targetEndWindow.end, refWindow.end) >
    Math.min(targetStartWindow.start, refWindow.start)
      ? overlapMs /
        Math.max(
          1,
          Math.max(targetEndWindow.end, refWindow.end) -
            Math.min(targetStartWindow.start, refWindow.start),
        )
      : 0;
  const startScore = Math.max(0, 1 - startDeltaMs / 3_600);
  const score = Math.max(
    0,
    Math.min(1, startScore * 0.72 + overlapRatio * 0.28),
  );
  return { hasTiming: true, score, startDeltaMs };
}

function mapMusixmatchReferenceTranslationsOntoLyrics(
  targetLyrics,
  referenceLyrics,
) {
  if (
    !Array.isArray(targetLyrics) ||
    !targetLyrics.length ||
    !Array.isArray(referenceLyrics) ||
    !referenceLyrics.length
  ) {
    return targetLyrics || [];
  }

  const translatedReference = referenceLyrics
    .map((line) => ({
      line,
      originalText: getLineText(line),
      translatedText: String(line?.translatedText || "").trim(),
    }))
    .filter((entry) => entry.translatedText && entry.originalText.trim());

  if (!translatedReference.length) {
    return targetLyrics;
  }

  const next = targetLyrics.map((line) => ({ ...line }));
  let cursor = 0;

  for (const entry of translatedReference) {
    const sourceNorm = normalizeText(entry.originalText);
    if (!sourceNorm) {
      continue;
    }

    let bestStart = -1;
    let bestEnd = -1;
    let bestTextScore = 0;
    let bestCombinedScore = 0;
    let secondBestCombinedScore = 0;
    let bestTiming = {
      hasTiming: false,
      score: 0,
      startDeltaMs: Number.POSITIVE_INFINITY,
    };
    const startMin = Math.max(0, cursor - 2);
    const startMax = Math.min(
      next.length - 1,
      cursor + TRANSLATION_MAP_SEARCH_WINDOW,
    );

    for (let start = startMin; start <= startMax; start += 1) {
      let combined = "";
      for (let span = 1; span <= TRANSLATION_MAP_MAX_SPAN; span += 1) {
        const end = start + span - 1;
        if (end >= next.length) {
          break;
        }
        const part = getLineText(next[end]);
        combined = combined ? `${combined} ${part}` : part;
        const textScore = scoreTranslationLineMatch(combined, sourceNorm);
        if (textScore < 0.2) {
          continue;
        }

        const timing = scoreTranslationTimingMatch(
          entry.line,
          next[start],
          next[end],
        );
        let combinedScore = textScore;
        if (timing.hasTiming) {
          combinedScore += timing.score * 0.34;
          if (
            timing.startDeltaMs > TRANSLATION_MAP_MAX_START_DELTA_MS &&
            textScore < 0.78
          ) {
            combinedScore -= 0.32;
          }
        }

        if (combinedScore > bestCombinedScore) {
          secondBestCombinedScore = bestCombinedScore;
          bestCombinedScore = combinedScore;
          bestTextScore = textScore;
          bestStart = start;
          bestEnd = end;
          bestTiming = timing;
        } else if (combinedScore > secondBestCombinedScore) {
          secondBestCombinedScore = combinedScore;
        }
      }
    }

    const hasConfidentText = bestTextScore >= TRANSLATION_MAP_MIN_TEXT_SCORE;
    const hasConfidentCombined =
      bestCombinedScore >= TRANSLATION_MAP_MIN_COMBINED_SCORE;
    const hasUniqueBest =
      bestCombinedScore - secondBestCombinedScore >=
        TRANSLATION_MAP_MIN_MARGIN || bestTextScore >= 0.78;
    const timingAcceptable =
      !bestTiming.hasTiming ||
      bestTiming.startDeltaMs <= TRANSLATION_MAP_MAX_START_DELTA_MS ||
      bestTextScore >= 0.82;

    if (
      bestStart >= 0 &&
      bestEnd >= bestStart &&
      hasConfidentText &&
      hasConfidentCombined &&
      hasUniqueBest &&
      timingAcceptable
    ) {
      for (let index = bestStart; index <= bestEnd; index += 1) {
        if (
          shouldHideTranslatedText(
            getLineText(next[index]),
            entry.translatedText,
          )
        ) {
          continue;
        }
        next[index].translatedText = appendTranslatedSegment(
          next[index].translatedText,
          entry.translatedText,
        );
      }
      cursor = Math.max(cursor, bestEnd + 1);
    }
  }

  return next;
}

function attachTranslationsToLyrics(lyrics, translations) {
  if (
    !Array.isArray(lyrics) ||
    !lyrics.length ||
    !Array.isArray(translations)
  ) {
    return lyrics || [];
  }
  const usable = translations
    .map((entry) => ({
      original: String(entry?.original || "").trim(),
      translated: String(entry?.translated || "").trim(),
    }))
    .filter((entry) => entry.translated);

  if (!usable.length) {
    return lyrics;
  }

  const hasOriginalSignals = usable.some((entry) =>
    normalizeText(entry.original),
  );
  if (!hasOriginalSignals) {
    const limit = Math.min(lyrics.length, usable.length);
    return lyrics.map((line, index) => {
      if (index >= limit) {
        return line;
      }
      const translatedText = usable[index].translated;
      if (
        !translatedText ||
        shouldHideTranslatedText(getLineText(line), translatedText)
      ) {
        return line;
      }
      return {
        ...line,
        translatedText,
      };
    });
  }

  const next = lyrics.map((line) => ({ ...line }));
  let cursor = 0;
  const windowSize = 28;
  const usedTranslationIndexes = new Set();

  for (let lineIndex = 0; lineIndex < next.length; lineIndex += 1) {
    const line = next[lineIndex];
    const baseText = getLineText(line);
    if (!baseText) {
      continue;
    }

    let bestIndex = -1;
    let bestScore = 0;
    const start = Math.max(cursor, 0);
    const end = Math.min(usable.length - 1, start + windowSize);
    for (let index = start; index <= end; index += 1) {
      const candidate = usable[index];
      const score = scoreTranslationLineMatch(baseText, candidate.original);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    if (bestIndex < 0 || bestScore < 0.22) {
      continue;
    }

    const translatedText = usable[bestIndex].translated;
    if (
      !translatedText ||
      shouldHideTranslatedText(getLineText(line), translatedText)
    ) {
      continue;
    }
    line.translatedText = translatedText;
    usedTranslationIndexes.add(bestIndex);
    cursor = bestIndex + 1;
  }

  const matchedCount = next.reduce(
    (count, line) =>
      count + (String(line?.translatedText || "").trim() ? 1 : 0),
    0,
  );
  void matchedCount;
  void usedTranslationIndexes;

  return next;
}

function attachTranslationsToMusixmatchSourceLyrics(lyrics, translations) {
  if (
    !Array.isArray(lyrics) ||
    !lyrics.length ||
    !Array.isArray(translations) ||
    !translations.length
  ) {
    return lyrics || [];
  }

  const usable = translations
    .map((entry) => ({
      original: String(entry?.original || "").trim(),
      translated: String(entry?.translated || "").trim(),
    }))
    .filter((entry) => entry.translated);
  if (!usable.length) {
    return lyrics;
  }

  const next = lyrics.map((line) => ({ ...line }));
  const buckets = new Map();
  for (let index = 0; index < next.length; index += 1) {
    const key = normalizeText(getLineText(next[index]));
    if (!key) {
      continue;
    }
    if (!buckets.has(key)) {
      buckets.set(key, []);
    }
    buckets.get(key).push(index);
  }

  let cursor = 0;
  for (const entry of usable) {
    const originalKey = normalizeText(entry.original);
    if (!originalKey) {
      continue;
    }
    const queue = buckets.get(originalKey);
    if (!Array.isArray(queue) || !queue.length) {
      continue;
    }

    let targetIndex = -1;
    for (let pos = 0; pos < queue.length; pos += 1) {
      if (queue[pos] >= cursor) {
        targetIndex = queue.splice(pos, 1)[0];
        break;
      }
    }
    if (targetIndex < 0 && queue.length) {
      targetIndex = queue.shift();
    }
    if (!(targetIndex >= 0 && targetIndex < next.length)) {
      continue;
    }

    if (
      shouldHideTranslatedText(getLineText(next[targetIndex]), entry.translated)
    ) {
      continue;
    }

    next[targetIndex].translatedText = appendTranslatedSegment(
      next[targetIndex].translatedText,
      entry.translated,
    );
    cursor = Math.max(cursor, targetIndex + 1);
  }

  return next;
}

function isMusixmatchSourceLabel(source) {
  const normalized = normalizeText(source);
  return normalized.includes("musixmatch");
}

function parseMusixmatchTimeMs(raw, { assumeSeconds = true } = {}) {
  if (raw === null || raw === undefined || raw === "") {
    return Number.NaN;
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      return Number.NaN;
    }
    return assumeSeconds ? Math.max(0, raw * 1000) : Math.max(0, raw);
  }
  const text = String(raw).trim();
  if (!text) {
    return Number.NaN;
  }
  const timestampMs = parseTimestampMs(text);
  if (Number.isFinite(timestampMs)) {
    return timestampMs;
  }
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) {
    return Number.NaN;
  }
  return assumeSeconds ? Math.max(0, numeric * 1000) : Math.max(0, numeric);
}

function shouldInsertSpaceBetweenRichsyncSegments(currentText, nextText) {
  const current = String(currentText || "");
  const next = String(nextText || "");
  if (!current || !next) {
    return false;
  }
  if (/\s$/.test(current) || /^\s/.test(next)) {
    return false;
  }
  // Keep punctuation tight without adding synthetic spacing.
  if (/^[,.;:!?)\]\}%]/.test(next)) {
    return false;
  }
  if (/[(\[{]$/.test(current)) {
    return false;
  }
  return true;
}

function extractMusixmatchRichsyncBody(
  payload,
  endpointLabel = "track.richsync.get",
) {
  const { body } = assertMusixmatchSuccess(payload, endpointLabel);
  const direct = body?.richsync?.richsync_body;
  if (typeof direct === "string" && direct.trim()) {
    return direct;
  }
  const list = Array.isArray(body?.richsync_list) ? body.richsync_list : [];
  for (const entry of list) {
    const nextBody = entry?.richsync?.richsync_body;
    if (typeof nextBody === "string" && nextBody.trim()) {
      return nextBody;
    }
  }
  const nested = findFirstNestedStringByKey(body, "richsync_body");
  return nested || "";
}

function getRichsyncSegmentText(segment) {
  return String(
    segment?.c ?? segment?.text ?? segment?.t ?? segment?.token ?? "",
  );
}

function isRichsyncWhitespaceSegment(text) {
  return /^\s+$/.test(String(text || ""));
}

function findNextNonWhitespaceRichsyncSegment(segments, startIndex) {
  if (!Array.isArray(segments)) {
    return null;
  }
  for (let index = startIndex; index < segments.length; index += 1) {
    const rawText = getRichsyncSegmentText(segments[index]);
    if (rawText && !isRichsyncWhitespaceSegment(rawText)) {
      return { segment: segments[index], rawText, index };
    }
  }
  return null;
}

function unwrapMusixmatchRichsyncLines(parsed) {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  for (const key of ["lines", "richsync", "richsyncs", "body", "data"]) {
    if (Array.isArray(parsed[key])) {
      return parsed[key];
    }
  }
  return [];
}

function parseMusixmatchRichsyncLyrics(richsyncBody) {
  const parsed =
    typeof richsyncBody === "string"
      ? parseJsonLenient(richsyncBody)
      : richsyncBody;
  const lines = unwrapMusixmatchRichsyncLines(parsed);
  const output = [];

  for (const line of lines) {
    const lineStart = parseMusixmatchTimeMs(
      line?.ts ?? line?.start ?? line?.time ?? line?.line_start,
      { assumeSeconds: true },
    );
    const lineEndCandidate = parseMusixmatchTimeMs(
      line?.te ?? line?.end ?? line?.line_end,
      { assumeSeconds: true },
    );
    if (!Number.isFinite(lineStart)) {
      continue;
    }
    const segments = Array.isArray(line?.l)
      ? line.l
      : Array.isArray(line?.words)
        ? line.words
        : Array.isArray(line?.tokens)
          ? line.tokens
          : [];

    if (!segments.length) {
      const text =
        String(line?.x ?? line?.text ?? line?.tx ?? line?.line ?? "").trim() ||
        "";
      if (!text) {
        continue;
      }
      const fallbackEnd = Number.isFinite(lineEndCandidate)
        ? lineEndCandidate
        : lineStart + 1800;
      output.push({
        lineStartTime: lineStart,
        lineEndTime: Math.max(lineStart + 250, fallbackEnd),
        syllables: normalizeSyllables(
          [{ text, startTime: lineStart, endTime: fallbackEnd }],
          lineStart,
          Math.max(lineStart + 250, fallbackEnd),
        ),
      });
      continue;
    }

    const syllables = [];
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const rawText = getRichsyncSegmentText(segment);
      if (!rawText || isRichsyncWhitespaceSegment(rawText)) {
        continue;
      }
      const nextSegment = segments[index + 1];
      const nextNonWhitespace = findNextNonWhitespaceRichsyncSegment(
        segments,
        index + 1,
      );
      const hasExplicitSpaceToken = isRichsyncWhitespaceSegment(
        getRichsyncSegmentText(nextSegment),
      );
      let text = rawText;
      if (
        (hasExplicitSpaceToken ||
          (nextNonWhitespace &&
            shouldInsertSpaceBetweenRichsyncSegments(
              rawText,
              nextNonWhitespace.rawText,
            ))) &&
        !/\s$/.test(text)
      ) {
        text += " ";
      }
      const startOffset = parseMusixmatchTimeMs(
        segment?.o ?? segment?.offset ?? segment?.ts ?? segment?.start,
        { assumeSeconds: true },
      );
      const nextOffset = parseMusixmatchTimeMs(
        nextSegment?.o ??
          nextSegment?.offset ??
          nextSegment?.ts ??
          nextSegment?.start ??
          nextNonWhitespace?.segment?.o ??
          nextNonWhitespace?.segment?.offset ??
          nextNonWhitespace?.segment?.ts ??
          nextNonWhitespace?.segment?.start,
        { assumeSeconds: true },
      );
      const durationOffset = parseMusixmatchTimeMs(
        segment?.d ?? segment?.duration,
        { assumeSeconds: true },
      );
      const startTime = Number.isFinite(startOffset)
        ? lineStart + startOffset
        : lineStart;
      const endTime = Number.isFinite(nextOffset)
        ? lineStart + nextOffset
        : Number.isFinite(durationOffset)
          ? startTime + durationOffset
          : Number.isFinite(lineEndCandidate)
            ? lineEndCandidate
            : startTime + 220;

      syllables.push({ text, startTime, endTime });
    }

    if (!syllables.length) {
      continue;
    }
    const normalized = ensureSyllableDisplaySpacing(
      normalizeSyllables(
        syllables,
        lineStart,
        Number.isFinite(lineEndCandidate)
          ? lineEndCandidate
          : syllables[syllables.length - 1].endTime,
      ),
    );
    if (!normalized.length) {
      continue;
    }
    output.push({
      lineStartTime: normalized[0].startTime,
      lineEndTime: normalized[normalized.length - 1].endTime,
      syllables: normalized,
    });
  }

  return output.filter((line) => line?.syllables?.length);
}

async function fetchMusixmatchRichsyncForCandidate(
  candidate,
  track,
  requestOptions,
) {
  let lastError = null;
  for (const identifierParams of extractMusixmatchIdentifierRequests(
    candidate,
  )) {
    try {
      const richsyncPayload = await fetchMusixmatchJson(
        "/track.richsync.get",
        {
          ...identifierParams,
          richsync_format: "json",
        },
        requestOptions,
      );
      const richsyncBody = extractMusixmatchRichsyncBody(
        richsyncPayload,
        "track.richsync.get",
      );
      if (!richsyncBody) {
        continue;
      }
      const lyrics = parseMusixmatchRichsyncLyrics(richsyncBody);
      if (lyrics.length) {
        return { lyrics, lastError: null };
      }
    } catch (error) {
      lastError = error;
    }
  }

  const matcherDurationSec =
    toMusixmatchDurationMs(candidate) > 0
      ? Math.max(1, Math.round(toMusixmatchDurationMs(candidate) / 1000))
      : Number(track?.durationMs || 0) > 0
        ? Math.max(1, Math.round(Number(track.durationMs) / 1000))
        : 0;
  const matcherDurationFilters = matcherDurationSec
    ? {
        f_subtitle_length: matcherDurationSec,
        f_subtitle_length_max_deviation: 8,
      }
    : {};

  try {
    const matcherPayload = await fetchMusixmatchJson(
      "/matcher.richsync.get",
      {
        q_track: String(candidate?.track_name || track?.title || "").trim(),
        q_artist: String(candidate?.artist_name || track?.artist || "").trim(),
        ...matcherDurationFilters,
      },
      requestOptions,
    );
    const richsyncBody = extractMusixmatchRichsyncBody(
      matcherPayload,
      "matcher.richsync.get",
    );
    if (!richsyncBody) {
      return { lyrics: [], lastError: null };
    }
    const lyrics = parseMusixmatchRichsyncLyrics(richsyncBody);
    if (lyrics.length) {
      return { lyrics, lastError: null };
    }
  } catch (error) {
    lastError = error;
  }
  return { lyrics: [], lastError };
}

async function fetchMusixmatchSubtitleForCandidate(
  candidate,
  track,
  requestOptions,
) {
  let lastError = null;
  for (const identifierParams of extractMusixmatchIdentifierRequests(
    candidate,
  )) {
    try {
      const subtitlePayload = await fetchMusixmatchJson(
        "/track.subtitle.get",
        {
          ...identifierParams,
          subtitle_format: "lrc",
        },
        requestOptions,
      );
      const subtitleBody = extractMusixmatchSubtitleBody(
        subtitlePayload,
        "track.subtitle.get",
      );
      if (subtitleBody) {
        return { subtitleBody, lastError: null };
      }
    } catch (error) {
      lastError = error;
    }
  }

  const matcherDurationSec =
    toMusixmatchDurationMs(candidate) > 0
      ? Math.max(1, Math.round(toMusixmatchDurationMs(candidate) / 1000))
      : Number(track?.durationMs || 0) > 0
        ? Math.max(1, Math.round(Number(track.durationMs) / 1000))
        : 0;
  const matcherDurationFilters = matcherDurationSec
    ? {
        f_subtitle_length: matcherDurationSec,
        f_subtitle_length_max_deviation: 8,
      }
    : {};

  try {
    const matcherPayload = await fetchMusixmatchJson(
      "/matcher.subtitle.get",
      {
        q_track: String(candidate?.track_name || track?.title || "").trim(),
        q_artist: String(candidate?.artist_name || track?.artist || "").trim(),
        ...matcherDurationFilters,
        subtitle_format: "lrc",
      },
      requestOptions,
    );
    const subtitleBody = extractMusixmatchSubtitleBody(
      matcherPayload,
      "matcher.subtitle.get",
    );
    if (subtitleBody) {
      return { subtitleBody, lastError: null };
    }
  } catch (error) {
    lastError = error;
  }

  for (const identifierParams of extractMusixmatchIdentifierRequests(
    candidate,
  )) {
    try {
      const macroPayload = await fetchMusixmatchJson(
        "/macro.subtitles.get",
        {
          ...identifierParams,
          subtitle_format: "lrc",
        },
        requestOptions,
      );
      const subtitleBody = extractMusixmatchSubtitleBody(
        macroPayload,
        "macro.subtitles.get",
      );
      if (subtitleBody) {
        return { subtitleBody, lastError: null };
      }
    } catch (error) {
      lastError = error;
    }
  }

  try {
    const macroMatcherPayload = await fetchMusixmatchJson(
      "/macro.subtitles.get",
      {
        q_track: String(candidate?.track_name || track?.title || "").trim(),
        q_artist: String(candidate?.artist_name || track?.artist || "").trim(),
        ...matcherDurationFilters,
        subtitle_format: "lrc",
      },
      requestOptions,
    );
    const subtitleBody = extractMusixmatchSubtitleBody(
      macroMatcherPayload,
      "macro.subtitles.get",
    );
    if (subtitleBody) {
      return { subtitleBody, lastError: null };
    }
  } catch (error) {
    lastError = error;
  }

  return { subtitleBody: "", lastError };
}

async function fetchFromMusixmatch(track, { musixmatchUserToken = "" } = {}) {
  const rawToken = String(musixmatchUserToken || "").trim();
  if (!rawToken) {
    throw new Error("No Musixmatch user token is currently available.");
  }
  const clientCandidates = prioritizeMusixmatchClientCandidates(
    resolveMusixmatchClientCandidates(rawToken),
    rawToken,
  );
  if (!clientCandidates.length) {
    throw new Error(
      "Musixmatch user token format is invalid. Paste the user token itself or the musixmatchUserToken cookie JSON payload.",
    );
  }

  const cached = getMusixmatchCachedResult(track, rawToken);
  if (cached) {
    return cached;
  }

  const cooldownInfo = getMusixmatchCooldownInfo();
  if (cooldownInfo.active) {
    const remainingSec = Math.ceil(cooldownInfo.remainingMs / 1000);
    const reason = cooldownInfo.reason || "captcha";
    throw new Error(
      `Musixmatch cooldown active (${reason}). Retry in ${remainingSec}s.`,
    );
  }

  let lastError = null;
  let sawNoMatchPath = false;

  for (const client of clientCandidates) {
    const requestOptions = {
      appId: client.appId,
      userToken: client.userToken,
      userAgent: client.userAgent,
      userLanguage: client.userLanguage,
      cookieHeader: client.cookieHeader,
      baseUrls: client.baseUrls,
      defaultParams: client.defaultParams || {},
    };

    const { matches, lastError: trackCandidateError } =
      await fetchMusixmatchTrackCandidates(track, requestOptions);
    if (trackCandidateError) {
      lastError = trackCandidateError;
      if (describeSourceError(trackCandidateError) === "unauthorized") {
        rememberMusixmatchRejectedClient(rawToken, client.appId);
      }
      if (describeSourceError(trackCandidateError) === "rate-limited") {
        activateMusixmatchCooldown("captcha");
        throw trackCandidateError;
      }
      if (describeSourceError(trackCandidateError) !== "unauthorized") {
        sawNoMatchPath = true;
      }
    }
    if (!matches.length) {
      if (describeSourceError(trackCandidateError) !== "unauthorized") {
        sawNoMatchPath = true;
      }
      continue;
    }

    const seenCandidates = new Set();
    const ranked = matches
      .filter((candidate) => {
        const identity = extractMusixmatchCandidateIdentity(candidate);
        if (!identity || seenCandidates.has(identity)) {
          return false;
        }
        seenCandidates.add(identity);
        return true;
      })
      .map((candidate) => {
        const title = String(
          candidate?.track_name || candidate?.name || "",
        ).trim();
        const artist = String(
          candidate?.artist_name || candidate?.artist || "",
        ).trim();
        let score = scoreCandidate(track, title, artist);
        const candidateDurationMs = toMusixmatchDurationMs(candidate);
        score += scoreDurationBonus(track, title, artist, candidateDurationMs);
        return { candidate, score, title, artist, candidateDurationMs };
      })
      .sort((a, b) => b.score - a.score);

    if (!ranked.length || isAmbiguousTopMatch(ranked)) {
      sawNoMatchPath = true;
      continue;
    }

    const likelyMusixmatchCandidates = ranked
      .filter((entry) =>
        isLikelySameTrack(
          track,
          entry.title,
          entry.artist,
          entry.candidateDurationMs,
        ),
      )
      .sort((left, right) => compareCandidateMatchQuality(track, left, right))
      .slice(0, 8);

    for (const entry of likelyMusixmatchCandidates) {
      const { lyrics: richsyncLyrics, lastError: richsyncError } =
        await fetchMusixmatchRichsyncForCandidate(
          entry.candidate,
          track,
          requestOptions,
        );
      if (richsyncError) {
        lastError = richsyncError;
        if (describeSourceError(richsyncError) === "unauthorized") {
          rememberMusixmatchRejectedClient(rawToken, client.appId);
        }
        if (describeSourceError(richsyncError) === "rate-limited") {
          activateMusixmatchCooldown("captcha");
          throw richsyncError;
        }
        if (describeSourceError(richsyncError) !== "unauthorized") {
          sawNoMatchPath = true;
        }
      }
      if (richsyncLyrics.length) {
        const songwriters = extractMusixmatchSongwriters(entry.candidate);
        const richsyncResult = {
          lyrics: richsyncLyrics,
          source: `musixmatch-richsync-user-token-${client.appId}`,
          metadata: songwriters.length
            ? { credits: { songwriters } }
            : undefined,
        };
        rememberMusixmatchPreferredClient(rawToken, client.appId);
        setMusixmatchCachedResult(track, rawToken, richsyncResult);
        return {
          ...richsyncResult,
        };
      }
      const { subtitleBody, lastError: subtitleError } =
        await fetchMusixmatchSubtitleForCandidate(
          entry.candidate,
          track,
          requestOptions,
        );
      if (subtitleError) {
        lastError = subtitleError;
        if (describeSourceError(subtitleError) === "unauthorized") {
          rememberMusixmatchRejectedClient(rawToken, client.appId);
        }
        if (describeSourceError(subtitleError) === "rate-limited") {
          activateMusixmatchCooldown("captcha");
          throw subtitleError;
        }
        if (describeSourceError(subtitleError) !== "unauthorized") {
          sawNoMatchPath = true;
        }
      }
      if (!subtitleBody) {
        sawNoMatchPath = true;
        continue;
      }
      const lyrics = parseLrc(subtitleBody);
      if (lyrics.length) {
        const songwriters = extractMusixmatchSongwriters(entry.candidate);
        const subtitleResult = {
          lyrics,
          source: `musixmatch-user-token-${client.appId}`,
          metadata: songwriters.length
            ? { credits: { songwriters } }
            : undefined,
        };
        rememberMusixmatchPreferredClient(rawToken, client.appId);
        setMusixmatchCachedResult(track, rawToken, subtitleResult);
        return {
          ...subtitleResult,
        };
      }
      sawNoMatchPath = true;
    }
  }

  if (lastError) {
    if (sawNoMatchPath && describeSourceError(lastError) === "unauthorized") {
      throw createSourceStageNoMatchError("musixmatch", "catalog");
    }
    throw lastError;
  }
  return null;
}

// ---- DesktopBridge/src/lyrics/parts/06-translation.js ----
// Gemini lyric translation enrichment and translation cache handling.
// This file is evaluated by ../index.js in a shared compatibility context.
// Keep behavior changes deliberate; most code here was moved verbatim from src/lyricsService.js.

const GEMINI_TRANSLATION_JSON_SCHEMA = {
  type: "OBJECT",
  properties: {
    lineCount: { type: "INTEGER" },
    translations: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          i: { type: "INTEGER" },
          t: { type: "STRING" },
        },
        required: ["i", "t"],
      },
    },
  },
  required: ["lineCount", "translations"],
};

function stripJsonFences(value) {
  const fenced = String(value || "").match(/```(?:json|text)?\s*([\s\S]*?)```/i);
  return fenced?.[1] ? String(fenced[1]).trim() : String(value || "").trim();
}

function buildIndexedTranslationUserPayload({
  lines,
  startIndex = 0,
  targetLanguage,
  title,
  artist,
}) {
  return {
    lineCount: lines.length,
    startIndex,
    targetLanguage,
    context: {
      title: title || null,
      artist: artist || null,
    },
    lines: lines.map((text, offset) => ({
      i: startIndex + offset,
      text: String(text || ""),
    })),
  };
}

function buildTranslationSystemPrompt(targetLanguage) {
  return [
    `Translate each lyric line to natural ${targetLanguage}.`,
    "Use title/artist only to disambiguate meaning—never output them.",
    "One input line maps to exactly one output entry; keep order, register, slang, and profanity.",
    "Do not merge, split, skip, or reorder lines.",
    "Already-English or non-lexical lines (sounds, names, ad-libs): copy the source text into t unchanged.",
    'Return JSON only: {"lineCount":N,"translations":[{"i":0,"t":"..."},...]}.',
    "lineCount must equal the input lineCount.",
    "translations must contain exactly lineCount objects with i from startIndex through startIndex+lineCount-1, each i once.",
    "Use t:\"\" for blank source lines.",
  ].join(" ");
}

function buildGemmaTranslationPrompt(systemPrompt, userPayload) {
  return `${systemPrompt}\n\nTranslate this payload and return indexed JSON with the same lineCount and i values:\n${JSON.stringify(userPayload)}`;
}

function readIndexedTranslationRow(row) {
  if (!row || typeof row !== "object") {
    return null;
  }
  const index = Number(row.i ?? row.index);
  const text = String(row.t ?? row.text ?? row.translated ?? "");
  if (!Number.isInteger(index)) {
    return null;
  }
  return { index, text };
}

function parseIndexedTranslationPayload(parsed, expectedCount, startIndex = 0) {
  if (!parsed || typeof parsed !== "object" || !expectedCount) {
    return null;
  }

  const declaredCount = Number(parsed.lineCount);
  const rows = Array.isArray(parsed.translations) ? parsed.translations : null;
  if (!rows || rows.length !== expectedCount) {
    return null;
  }
  if (
    Number.isInteger(declaredCount) &&
    declaredCount > 0 &&
    declaredCount !== expectedCount
  ) {
    return null;
  }

  const out = Array.from({ length: expectedCount }, () => "");
  const seen = new Set();
  for (const row of rows) {
    const entry = readIndexedTranslationRow(row);
    if (!entry) {
      return null;
    }
    const localIndex = entry.index - startIndex;
    if (localIndex < 0 || localIndex >= expectedCount || seen.has(localIndex)) {
      return null;
    }
    seen.add(localIndex);
    out[localIndex] = entry.text.trim();
  }

  if (seen.size !== expectedCount) {
    return null;
  }
  for (let index = 0; index < expectedCount; index += 1) {
    if (!seen.has(index)) {
      return null;
    }
  }
  return out;
}

function parseStringArrayTranslationPayload(rows, expectedCount) {
  if (!Array.isArray(rows) || !expectedCount || rows.length !== expectedCount) {
    return null;
  }
  if (!rows.every((row) => typeof row === "string" || row == null)) {
    return null;
  }
  return rows.map((row) => String(row ?? "").trim());
}

function validateTranslationAlignment(translations, sourceLines) {
  if (
    !Array.isArray(translations) ||
    !Array.isArray(sourceLines) ||
    translations.length !== sourceLines.length ||
    !translations.length
  ) {
    return false;
  }

  const translationBySource = new Map();
  let nonEmptySourceCount = 0;
  let emptyTranslationCount = 0;

  for (let index = 0; index < sourceLines.length; index += 1) {
    const source = String(sourceLines[index] || "").trim();
    const translated = String(translations[index] || "").trim();
    if (!source) {
      continue;
    }
    nonEmptySourceCount += 1;
    if (!translated) {
      emptyTranslationCount += 1;
    }
    if (translationBySource.has(source)) {
      if (translationBySource.get(source) !== translated) {
        return false;
      }
    } else {
      translationBySource.set(source, translated);
    }
  }

  if (!nonEmptySourceCount) {
    return true;
  }

  const emptyRatio = emptyTranslationCount / nonEmptySourceCount;
  return emptyRatio <= 0.35;
}

function parseTranslationPayloadObject(parsed, expectedCount, sourceLines, startIndex = 0) {
  if (!parsed) {
    return null;
  }

  const indexed = parseIndexedTranslationPayload(
    parsed,
    expectedCount,
    startIndex,
  );
  if (indexed) {
    return indexed;
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.translations)
      ? parsed.translations
      : null;
  if (!rows) {
    return null;
  }

  if (
    rows.length === expectedCount &&
    rows.every((row) => typeof row === "string" || row == null)
  ) {
    return parseStringArrayTranslationPayload(rows, expectedCount);
  }

  const out = Array.from({ length: expectedCount }, () => "");
  const seen = new Set();
  for (const row of rows) {
    const entry = readIndexedTranslationRow(row);
    if (!entry) {
      return null;
    }
    const localIndex = entry.index - startIndex;
    if (localIndex < 0 || localIndex >= expectedCount || seen.has(localIndex)) {
      return null;
    }
    seen.add(localIndex);
    out[localIndex] = entry.text.trim();
  }
  if (seen.size !== expectedCount) {
    return null;
  }
  return out;
}

function extractTranslationsFromGeminiPayload(
  payload,
  expectedCount,
  sourceLines,
  { startIndex = 0, parseLegacyFallback } = {},
) {
  const parts = Array.isArray(payload?.candidates?.[0]?.content?.parts)
    ? payload.candidates[0].content.parts
    : [];

  const text = parts
    .map((part) => String(part?.text || ""))
    .join("")
    .trim();
  if (!text) {
    return null;
  }

  const fenced = stripJsonFences(text);
  for (const candidate of [text, fenced]) {
    try {
      const parsed = parseJsonLenient(candidate);
      const normalized = parseTranslationPayloadObject(
        parsed,
        expectedCount,
        sourceLines,
        startIndex,
      );
      if (
        normalized &&
        validateTranslationAlignment(normalized, sourceLines)
      ) {
        return normalized;
      }
    } catch {
      // try legacy parser below
    }
  }

  if (typeof parseLegacyFallback !== "function") {
    return null;
  }
  const legacy = parseLegacyFallback(text);
  if (
    !legacy ||
    !validateTranslationAlignment(legacy, sourceLines)
  ) {
    return null;
  }
  return legacy;
}

async function mapTranslationChunksWithConcurrency(items, limit, mapper) {
  if (!Array.isArray(items) || !items.length) {
    return [];
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  };

  await Promise.all(
    Array.from({ length: workerCount }, () => runWorker()),
  );
  return results;
}

async function enrichLyricsWithGeminiTranslations(
  track,
  lyrics,
  { geminiApiKey = "", geminiCache = null } = {},
) {
  if (!Array.isArray(lyrics) || !lyrics.length) {
    return lyrics || [];
  }

  const apiKey = String(geminiApiKey || "").trim();
  if (!apiKey) {
    console.log(
      `[lyrics-translate] skipped: missing Gemini key for ${String(track?.title || "unknown title")} / ${String(track?.artist || "unknown artist")}`,
    );
    lyrics.translationMeta = {
      provider: "Gemini",
      model: "",
      apiRequestMs: 0,
      bridgeProcessingMs: 0,
      translatedLineCount: 0,
      requestedAt: Date.now(),
      completedAt: Date.now(),
      isLoading: false,
    };
    return lyrics;
  }

  const geminiCooldown = getGeminiCooldownInfo();
  if (geminiCooldown.active) {
    console.log(
      `[lyrics-translate] skipped: cooldown active (${geminiCooldown.reason || "unknown"}, ${Math.ceil(geminiCooldown.remainingMs / 1000)}s) for ${String(track?.title || "unknown title")}`,
    );
    lyrics.translationMeta = {
      provider: "Gemini",
      model: "",
      apiRequestMs: 0,
      bridgeProcessingMs: 0,
      translatedLineCount: 0,
      requestedAt: Date.now(),
      completedAt: Date.now(),
      isLoading: false,
    };
    return lyrics;
  }

  const cacheMap = geminiCache instanceof Map ? geminiCache : null;
  const cleanupGeminiCache = (now = Date.now()) => {
    if (!cacheMap) {
      return;
    }
    for (const [key, entry] of cacheMap.entries()) {
      if (!entry || Number(entry.expiresAt || 0) <= now) {
        cacheMap.delete(key);
      }
    }
  };
  const normalizeLineKey = (text) => String(text || "").trim();

  const uniqueLineMap = new Map();
  let candidateLineCount = 0;
  const registerCandidateText = (value) => {
    const text = String(value || "").trim();
    if (!text) {
      return;
    }
    const key = normalizeLineKey(text);
    if (!key) {
      return;
    }
    candidateLineCount += 1;
    if (!uniqueLineMap.has(key)) {
      uniqueLineMap.set(key, text);
    }
  };

  for (const line of lyrics) {
    registerCandidateText(getLineText(line));
    registerCandidateText(getBackgroundLineText(line));
  }

  if (!candidateLineCount || !uniqueLineMap.size) {
    return lyrics;
  }

  const fingerprint = crypto
    .createHash("sha1")
    .update(
      JSON.stringify({
        title: String(track?.title || ""),
        artist: String(track?.artist || ""),
        durationMs: Number(track?.durationMs || 0),
        lines: [...uniqueLineMap.keys()],
      }),
    )
    .digest("hex");
  const cacheKey = `openrouter|${fingerprint}`;

  cleanupGeminiCache();
  const cached = cacheMap?.get(cacheKey);
  if (
    cached &&
    cached.translations &&
    typeof cached.translations === "object"
  ) {
    console.log(
      `[lyrics-translate] cache hit for ${String(track?.title || "unknown title")} (${uniqueLineMap.size} unique lines)`,
    );
    const cachedLyrics = lyrics.map((line) => {
      const translatedText = buildTranslatedTextForLineFromLookup(
        line,
        cached.translations,
      );
      if (!translatedText) {
        return line;
      }
      return {
        ...line,
        translatedText,
      };
    });
    cachedLyrics.translationMeta = {
      provider: "Gemini",
      model: "cache",
      apiRequestMs: 0,
      bridgeProcessingMs: 0,
      translatedLineCount: Object.keys(cached.translations || {}).length,
      requestedAt: Date.now(),
      completedAt: Date.now(),
      isLoading: false,
    };
    return cachedLyrics;
  }

  const uniqueLines = [...uniqueLineMap.values()];
  const translatedByText = {};
  let translationModelUsed = "";
  let translationApiRequestMs = 0;
  let translationBridgeProcessingMs = 0;
  const translationStartedAt = Date.now();
  console.log(
    `[lyrics-translate] start for ${String(track?.title || "unknown title")} / ${String(track?.artist || "unknown artist")}: ${uniqueLines.length} unique lines, source=${String(track?.source || "unknown")}`,
  );

  const parseGeminiCompactLines = (
    content,
    expectedCount,
    sourceLines = [],
    startIndex = 0,
  ) => {
    const raw = String(content || "").trim();
    if (!raw) {
      return null;
    }

    const candidates = [raw, stripJsonFences(raw)];
    for (const candidate of candidates) {
      try {
        const parsed = parseJsonLenient(candidate);
        const normalized = parseTranslationPayloadObject(
          parsed,
          expectedCount,
          sourceLines,
          startIndex,
        );
        if (normalized) {
          return normalized;
        }
      } catch {
        // try regex salvage below
      }
    }

    const salvageIndexedRowsByRegex = (value) => {
      const text = String(value || "");
      if (!text) {
        return null;
      }
      const out = Array.from({ length: expectedCount }, () => "");
      const seen = new Set();
      const patterns = [
        /"i"\s*:\s*(\d+)\s*,\s*"t"\s*:\s*"((?:\\.|[^"\\])*)"/g,
        /"index"\s*:\s*(\d+)\s*,\s*"translated"\s*:\s*"((?:\\.|[^"\\])*)"/g,
      ];
      for (const regex of patterns) {
        let match = regex.exec(text);
        while (match) {
          const index = Number(match[1]);
          const encoded = String(match[2] || "");
          let translated = "";
          try {
            translated = JSON.parse(`"${encoded}"`);
          } catch {
            translated = encoded
              .replace(/\\n/g, "\n")
              .replace(/\\r/g, "")
              .replace(/\\t/g, "\t")
              .replace(/\\"/g, '"')
              .replace(/\\\\/g, "\\");
          }
          const localIndex = index - startIndex;
          if (
            Number.isInteger(localIndex) &&
            localIndex >= 0 &&
            localIndex < out.length &&
            !seen.has(localIndex)
          ) {
            seen.add(localIndex);
            out[localIndex] = String(translated).trim();
          }
          match = regex.exec(text);
        }
      }
      if (seen.size !== expectedCount) {
        return null;
      }
      return out;
    };

    for (const candidate of candidates) {
      const salvaged = salvageIndexedRowsByRegex(candidate);
      if (salvaged) {
        return salvaged;
      }
    }

    return null;
  };

  const requestGeminiFullLyrics = async (allLines, { startIndex = 0 } = {}) => {
    const trackTitle = String(track?.title || "").trim();
    const trackArtist = String(track?.artist || "").trim();
    const normalizeMetadataGuardText = (value) =>
      String(value || "")
        .normalize("NFKC")
        .toLowerCase()
        .replace(/['"`]/g, "")
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
    const normalizedTrackTitle = normalizeMetadataGuardText(trackTitle);
    const normalizedTrackArtist = normalizeMetadataGuardText(trackArtist);
    const isTrackMetadataLeak = (value) => {
      const text = String(value || "").trim();
      if (!text) {
        return false;
      }
      const lower = text.toLowerCase();
      if (/^(?:title|track|song|artist|by)\s*[:=-]/i.test(text)) {
        return true;
      }
      const normalized = normalizeMetadataGuardText(text);
      if (!normalized) {
        return false;
      }
      if (normalizedTrackTitle && normalized === normalizedTrackTitle) {
        return true;
      }
      if (
        normalizedTrackTitle &&
        (normalized === `title ${normalizedTrackTitle}` ||
          normalized === `track ${normalizedTrackTitle}` ||
          normalized === `song ${normalizedTrackTitle}` ||
          normalized.startsWith(`${normalizedTrackTitle} by `) ||
          normalized.startsWith(`title ${normalizedTrackTitle} `) ||
          normalized.startsWith(`track ${normalizedTrackTitle} `) ||
          normalized.startsWith(`song ${normalizedTrackTitle} `))
      ) {
        return true;
      }
      if (
        normalizedTrackArtist &&
        (lower.startsWith("artist:") ||
          normalized === `artist ${normalizedTrackArtist}` ||
          normalized === `by ${normalizedTrackArtist}`)
      ) {
        return true;
      }
      return false;
    };
    const sanitizeTranslatedLines = (lines) =>
      Array.isArray(lines)
        ? lines.map((line) =>
            isTrackMetadataLeak(line) ? "" : String(line || "").trim(),
          )
        : lines;
    const systemPrompt = buildTranslationSystemPrompt(
      GEMINI_TRANSLATION_TARGET_LANGUAGE,
    );
    const userPayload = buildIndexedTranslationUserPayload({
      lines: allLines,
      startIndex,
      targetLanguage: GEMINI_TRANSLATION_TARGET_LANGUAGE,
      title: trackTitle,
      artist: trackArtist,
    });
    const userPrompt = JSON.stringify(userPayload);

    const shouldRetryGeminiError = (error) => {
      if (!error) {
        return false;
      }
      const message = String(error?.message || error || "").toLowerCase();
      return (
        message.includes("openrouter 429") ||
        message.includes("gemini 429") ||
        message.includes("http 429") ||
        message.includes("resource_exhausted") ||
        message.includes("http 5") ||
        message.includes("temporarily rate-limited") ||
        message.includes("provider returned error") ||
        message.includes("aborted") ||
        message.includes("timeout") ||
        message.includes("network")
      );
    };

    const isGeminiUsageLimitError = (error) => {
      if (!error) {
        return false;
      }
      const message = String(error?.message || error || "").toLowerCase();
      return isGeminiTranslationRateLimitedMessage(message);
    };

    const isGemmaModel = (model) =>
      String(model || "")
        .trim()
        .toLowerCase()
        .startsWith("gemma-");

    const getHttpErrorWithBody = async (response) => {
      const retryAfter = response.headers.get("retry-after");
      const retrySuffix = retryAfter ? ` (retry-after=${retryAfter})` : "";
      let bodyText = "";
      try {
        bodyText = String(await response.text()).trim();
      } catch {
        bodyText = "";
      }
      const compactBody = bodyText.replace(/\s+/g, " ").slice(0, 240);
      const bodySuffix = compactBody ? `: ${compactBody}` : "";
      return new Error(`HTTP ${response.status}${retrySuffix}${bodySuffix}`);
    };

    const requestGeminiLines = async ({ model }) => {
      try {
        const requestStartedAt = Date.now();
        const useGemmaCompatMode = isGemmaModel(model);
        const requestUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

        const generationConfig = {
          temperature: 0,
          topP: 0.05,
          maxOutputTokens: Math.min(
            8192,
            Math.max(2048, allLines.length * 48),
          ),
          responseMimeType: "application/json",
          responseSchema: GEMINI_TRANSLATION_JSON_SCHEMA,
        };
        if (
          !useGemmaCompatMode &&
          String(model || "")
            .toLowerCase()
            .includes("gemini")
        ) {
          generationConfig.thinkingConfig = { thinkingBudget: 0 };
        }
        if (useGemmaCompatMode) {
          delete generationConfig.responseMimeType;
          delete generationConfig.responseSchema;
          delete generationConfig.thinkingConfig;
        }

        const requestBody = useGemmaCompatMode
          ? {
              contents: [
                {
                  role: "user",
                  parts: [
                    {
                      text: buildGemmaTranslationPrompt(systemPrompt, userPayload),
                    },
                  ],
                },
              ],
              generationConfig,
            }
          : {
              systemInstruction: {
                parts: [{ text: systemPrompt }],
              },
              contents: [
                {
                  role: "user",
                  parts: [{ text: userPrompt }],
                },
              ],
              generationConfig,
            };

        const response = await fetch(requestUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
        });
        const responseReceivedAt = Date.now();

        if (!response.ok) {
          throw await getHttpErrorWithBody(response);
        }

        const payload = await response.json();
        const parsedLines = extractTranslationsFromGeminiPayload(
          payload,
          allLines.length,
          allLines,
          {
            startIndex,
            parseLegacyFallback: (legacyText) =>
              parseGeminiCompactLines(
                legacyText,
                allLines.length,
                allLines,
                startIndex,
              ),
          },
        );
        if (
          !Array.isArray(parsedLines) ||
          parsedLines.length !== allLines.length ||
          !validateTranslationAlignment(parsedLines, allLines)
        ) {
          throw new Error(
            `Gemini returned invalid line payload (expected ${allLines.length} aligned lines).`,
          );
        }
        const sanitizedLines = sanitizeTranslatedLines(parsedLines);
        translationModelUsed = model;
        translationApiRequestMs += responseReceivedAt - requestStartedAt;
        translationBridgeProcessingMs += Math.max(0, Date.now() - responseReceivedAt);
        return sanitizedLines;
      } catch (error) {
        throw error;
      }
    };

    const isInvalidPayloadError = (error) => {
      const message = String(error?.message || error || "").toLowerCase();
      return (
        message.includes("invalid line payload") ||
        message.includes("invalid payload") ||
        message.includes("aligned lines")
      );
    };

    let lastError = null;
    let consecutiveInvalidPayloadCount = 0;
    for (const model of GEMINI_MODEL_CANDIDATES) {
      for (
        let attempt = 0;
        attempt < GEMINI_TRANSLATION_MAX_RETRIES;
        attempt += 1
      ) {
        try {
          const translatedLines = await requestGeminiLines({
            model,
          });
          consecutiveInvalidPayloadCount = 0;
          console.log(
            `[lyrics-translate] model ${model} success for ${allLines.length} lines`,
          );
          return translatedLines;
        } catch (error) {
          lastError = error;
          if (isInvalidPayloadError(error)) {
            consecutiveInvalidPayloadCount += 1;
            if (consecutiveInvalidPayloadCount >= 2) {
              throw new Error(
                "Gemini returned invalid payload twice consecutively; skipping further retries.",
              );
            }
          } else {
            consecutiveInvalidPayloadCount = 0;
          }
          const canRetry =
            attempt < GEMINI_TRANSLATION_MAX_RETRIES - 1 &&
            shouldRetryGeminiError(error);
          if (canRetry) {
            const delayMs =
              GEMINI_TRANSLATION_RETRY_BASE_MS * Math.pow(2, attempt) +
              Math.floor(Math.random() * 450);
            await wait(delayMs);
            continue;
          }
          break;
        }
      }
      if (!isGeminiUsageLimitError(lastError)) {
        throw lastError || new Error("Gemini translation failed.");
      }
    }
    throw lastError || new Error("Gemini translation failed.");
  };

  const requestGeminiChunkedLyrics = async (allLines) => {
    const chunkSize = GEMINI_TRANSLATION_CHUNK_SIZE;
    const chunks = [];
    for (let start = 0; start < allLines.length; start += chunkSize) {
      chunks.push({
        lines: allLines.slice(start, start + chunkSize),
        startIndex: start,
      });
    }
    const chunkCount = chunks.length;
    const parallelLimit = Math.max(
      1,
      Number(GEMINI_TRANSLATION_MAX_PARALLEL_CHUNKS) || 1,
    );
    const chunkResults = await mapTranslationChunksWithConcurrency(
      chunks,
      parallelLimit,
      async (chunk, chunkIndex) => {
        const chunkTranslated = await requestGeminiFullLyrics(chunk.lines, {
          startIndex: chunk.startIndex,
        });
        if (
          !Array.isArray(chunkTranslated) ||
          chunkTranslated.length !== chunk.lines.length
        ) {
          throw new Error(
            `Gemini chunk translation failed (expected ${chunk.lines.length} lines).`,
          );
        }
        console.log(
          `[lyrics-translate] chunk ${chunkIndex + 1}/${chunkCount} translated (${chunk.lines.length} lines, startIndex=${chunk.startIndex})`,
        );
        return chunkTranslated;
      },
    );
    return chunkResults.flat();
  };

  const isRateLimitedTranslationError = (message = "") => {
    return isGeminiTranslationRateLimitedMessage(message);
  };

  const isInvalidPayloadRetryStopError = (message = "") => {
    const lowerMessage = String(message || "").toLowerCase();
    return lowerMessage.includes(
      "invalid payload twice consecutively; skipping further retries",
    );
  };

  let translatedAll = [];
  let translationError = null;
  const attemptedChunkedFirst =
    uniqueLines.length > GEMINI_TRANSLATION_PROACTIVE_CHUNK_LINES;
  try {
    translatedAll = attemptedChunkedFirst
      ? await requestGeminiChunkedLyrics(uniqueLines)
      : await requestGeminiFullLyrics(uniqueLines);
  } catch (error) {
    translationError = error;
    console.warn(
      `[lyrics-translate] full translation failed for ${String(track?.title || "unknown title")}: ${String(error?.message || error || "unknown")}`,
    );
  }

  if (translationError) {
    const message = String(translationError?.message || translationError || "");
    const shouldTryChunkedFallback =
      !attemptedChunkedFirst &&
      uniqueLines.length > GEMINI_TRANSLATION_CHUNK_SIZE &&
      !isRateLimitedTranslationError(message) &&
      !isInvalidPayloadRetryStopError(message);
    if (shouldTryChunkedFallback) {
      try {
        console.log(
          `[lyrics-translate] retrying chunked translation (${uniqueLines.length} lines)`,
        );
        translatedAll = await requestGeminiChunkedLyrics(uniqueLines);
        translationError = null;
      } catch (chunkError) {
        translationError = chunkError;
        console.warn(
          `[lyrics-translate] chunked translation failed for ${String(track?.title || "unknown title")}: ${String(chunkError?.message || chunkError || "unknown")}`,
        );
      }
    }
  }

  if (translationError) {
    const message = String(translationError?.message || translationError || "");
    if (isRateLimitedTranslationError(message)) {
      const reason = String(message || "")
        .toLowerCase()
        .includes("503")
        ? "http-503"
        : "http-429";
      activateGeminiCooldown(reason, GEMINI_RATE_LIMIT_COOLDOWN_MS);
      console.warn(
        `[lyrics-translate] rate limited, cooldown activated (${Math.ceil(GEMINI_RATE_LIMIT_COOLDOWN_MS / 1000)}s)`,
      );
      lyrics.translationMeta = {
        provider: "Gemini",
        model: translationModelUsed,
        apiRequestMs: translationApiRequestMs,
        bridgeProcessingMs: translationBridgeProcessingMs,
        translatedLineCount: 0,
        requestedAt: translationStartedAt,
        completedAt: Date.now(),
        isLoading: false,
      };
      return lyrics;
    }
    lyrics.translationMeta = {
      provider: "Gemini",
      model: translationModelUsed,
      apiRequestMs: translationApiRequestMs,
      bridgeProcessingMs: translationBridgeProcessingMs,
      translatedLineCount: 0,
      requestedAt: translationStartedAt,
      completedAt: Date.now(),
      isLoading: false,
    };
    return lyrics;
  }

  for (let index = 0; index < uniqueLines.length; index += 1) {
    const text = uniqueLines[index];
    const translated = String(translatedAll[index] || "").trim();
    if (translated && !shouldHideTranslatedText(text, translated)) {
      translatedByText[text] = translated;
    }
  }

  console.log(
    `[lyrics-translate] completed for ${String(track?.title || "unknown title")}: translated ${Object.keys(translatedByText).length}/${uniqueLines.length} unique lines`,
  );

  const translatedLyrics = lyrics.map((line) => {
    const translatedText = buildTranslatedTextForLineFromLookup(
      line,
      translatedByText,
    );
    if (!translatedText) {
      return line;
    }
    return {
      ...line,
      translatedText,
    };
  });

  if (cacheMap) {
    cleanupGeminiCache();
    cacheMap.set(cacheKey, {
      expiresAt: Date.now() + GEMINI_TRANSLATION_CACHE_TTL_MS,
      translations: translatedByText,
    });
  }

  translatedLyrics.translationMeta = {
    provider: "Gemini",
    model: translationModelUsed || GEMINI_MODEL_CANDIDATES[0],
    apiRequestMs: translationApiRequestMs,
    bridgeProcessingMs:
      translationBridgeProcessingMs ||
      Math.max(0, Date.now() - translationStartedAt - translationApiRequestMs),
    translatedLineCount: Object.keys(translatedByText).length,
    requestedAt: translationStartedAt,
    completedAt: Date.now(),
    isLoading: false,
  };

  return translatedLyrics;
}

// ---- DesktopBridge/src/lyrics/parts/08-local-vault-source.js ----
// Mobile local vault adapter placeholder.
async function fetchFromLocalVault(_track) {
  return null;
}

// ---- DesktopBridge/src/lyrics/parts/07a-source-scoring.js ----
// Source registry, preferred-source ordering, lyric finalization/ranking, and createLyricsService facade.
// This file is evaluated by ../index.js in a shared compatibility context.
// Keep behavior changes deliberate; most code here was moved verbatim from src/lyricsService.js.

const SOURCE_FETCHERS = {
  "local-vault": fetchFromLocalVault,
  kugou: fetchFromKugou,
  netease: fetchFromNetease,
  "qq-direct": fetchFromQQ,
  musixmatch: fetchFromMusixmatch,
  lrclib: fetchFromLrcLib,
  "spicy-lyrics": fetchFromSpicyLyrics,
};

function normalizeSourceKey(source) {
  const normalized = String(source || "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return "";
  }
  return SOURCE_ALIASES[normalized] || normalized;
}

function getAvailableLyricsSources() {
  return Object.keys(SOURCE_FETCHERS);
}

function getTemporarilyDisabledLyricsSources() {
  return [...TEMPORARILY_DISABLED_SOURCES];
}

function countTranslatedLyricsLines(lyrics) {
  return Array.isArray(lyrics)
    ? lyrics.reduce(
        (count, line) =>
          count + (String(line?.translatedText || "").trim() ? 1 : 0),
        0,
      )
    : 0;
}

function mergeLyricsMetadata(...metadataList) {
  const merged = {};
  for (const metadata of metadataList) {
    if (!metadata || typeof metadata !== "object") {
      continue;
    }
    if (metadata.instrumental) {
      merged.instrumental = true;
    }
    if (metadata.credits && typeof metadata.credits === "object") {
      merged.credits = {
        ...(merged.credits || {}),
        ...metadata.credits,
      };
    }
    if (metadata.translation && typeof metadata.translation === "object") {
      merged.translation = {
        ...(merged.translation || {}),
        ...metadata.translation,
      };
    }
  }
  return merged;
}

async function probeLyricsSource(
  track,
  source,
  {
    musixmatchUserToken = process.env.MUSIXMATCH_USER_TOKEN || "",
    spotifyWebToken = process.env.SPOTIFY_WEB_TOKEN || "",
    spotifyAccessToken = "",
  } = {},
) {
  const normalizedSource = normalizeSourceKey(source);
  const fetcher = SOURCE_FETCHERS[normalizedSource];
  if (typeof fetcher !== "function") {
    return {
      ok: false,
      requestedSource: String(source || ""),
      source: normalizedSource || String(source || ""),
      errorType: "unknown-source",
      errorMessage: `Unknown source "${source}"`,
      result: null,
    };
  }

  try {
    const safeTrack = {
      trackId: String(track?.trackId || "probe-track"),
      title: String(track?.title || "").trim(),
      artist: String(track?.artist || "").trim(),
      durationMs: Number(track?.durationMs || 0),
      spotifyTrackId: String(track?.spotifyTrackId || "").trim(),
      album: String(track?.album || "").trim(),
    };
    if (!safeTrack.title || !safeTrack.artist) {
      return {
        ok: false,
        requestedSource: String(source || ""),
        source: normalizedSource,
        errorType: "invalid-track",
        errorMessage: "Track must include non-empty title and artist",
        result: null,
      };
    }

    const matchTrack = await buildLyricsMatchTrack(safeTrack, {
      spotifyAccessToken: String(spotifyAccessToken || "").trim(),
    });

    const result = await fetcher(matchTrack, {
      musixmatchUserToken: String(musixmatchUserToken || "").trim(),
      spotifyWebToken: String(spotifyWebToken || "").trim(),
      spotifyAccessToken: String(spotifyAccessToken || "").trim(),
    });
    if (!result?.lyrics?.length) {
      return {
        ok: false,
        requestedSource: String(source || ""),
        source: normalizedSource,
        errorType: "no-match",
        errorMessage: "No synced lyrics returned",
        result: null,
      };
    }
    return {
      ok: true,
      requestedSource: String(source || ""),
      source: normalizedSource,
      errorType: null,
      errorMessage: "",
      result,
    };
  } catch (error) {
    return {
      ok: false,
      requestedSource: String(source || ""),
      source: normalizedSource,
      errorType: describeSourceError(error),
      errorMessage:
        error instanceof Error
          ? error.message
          : String(error || "Unknown error"),
      result: null,
    };
  }
}

function sanitizePreferredSource(preferredSource) {
  const source = normalizeSourceKey(preferredSource || "auto");
  return VALID_SOURCE_KEYS.has(source) ? source : "auto";
}

function getSourceAttemptOrder(
  preferredSource,
  {
    hasMusixmatchUserToken = false,
    hasSpotifyWebToken = false,
    hasSpotifyTrackId = false,
    track = null,
  } = {},
) {
  const hasSpicy = hasSpotifyWebToken || hasSpotifyTrackId;
  const singleFeatVariant =
    track &&
    trackNeedsFeaturedVariantVerification(track) &&
    countRequestedFeaturedArtistGroups(track?.title || "") <= 1;
  const coreSources = [
    "lrclib",
    "netease",
    ...(hasMusixmatchUserToken ? ["musixmatch"] : []),
    "qq-direct",
  ];
  const apiOrder = singleFeatVariant
    ? ["kugou", ...coreSources, ...(hasSpicy ? ["spicy-lyrics"] : [])]
    : ["kugou", ...(hasSpicy ? ["spicy-lyrics"] : []), ...coreSources];
  const preferred = sanitizePreferredSource(preferredSource);
  if (preferred === "auto") {
    return ["local-vault", ...apiOrder];
  }
  if (preferred === "local-vault") {
    return ["local-vault"];
  }
  if (TEMPORARILY_DISABLED_SOURCES.has(preferred)) {
    return [];
  }
  return [preferred];
}

function classifySourceFailure(source, error) {
  if (!error) {
    return `${source}:no-match`;
  }
  if (
    typeof error?.sourceFailureReason === "string" &&
    error.sourceFailureReason
  ) {
    return error.sourceFailureReason;
  }
  const errorText =
    error instanceof Error ? error.message : String(error || "");
  if (errorText === "__NO_MATCH__") {
    return `${source}:no-match`;
  }
  return `${source}:unreachable-${describeSourceError(error)}`;
}

function mergeBackgroundSyllablesIntoLine(leadLine, bgSyllables) {
  if (!bgSyllables || !bgSyllables.length) return;
  const existing = leadLine.backgroundSyllables || [];
  leadLine.backgroundSyllables = [...existing, ...bgSyllables];
}

function markSyllableAsWordBoundary(syllable) {
  if (syllable && typeof syllable === "object") {
    syllable.isPartOfWord = false;
  }
}

function trimTrailingSyllableWhitespace(
  syllables,
  { markBoundary = true } = {},
) {
  while (syllables.length > 0) {
    const last = syllables[syllables.length - 1];
    last.text = String(last.text || "").replace(/\s+$/, "");
    if (String(last.text || "").trim()) {
      if (markBoundary) {
        markSyllableAsWordBoundary(last);
      }
      return;
    }
    syllables.pop();
  }
}

function appendBackgroundGroupSeparator(bgSyllables) {
  if (!bgSyllables.length) return;
  trimTrailingSyllableWhitespace(bgSyllables);
  const last = bgSyllables[bgSyllables.length - 1];
  if (!last) return;

  const text = String(last.text || "").replace(/\s+$/, "");
  if (!text) return;
  last.text = /[,;:!?]$/.test(text) ? text : `${text},`;
  markSyllableAsWordBoundary(last);
}

function isCensorshipBoundary(leftText, rightText) {
  const left = String(leftText || "").trim();
  const right = String(rightText || "").trim();
  if (!left || !right) {
    return false;
  }
  const censorRun = /^[*＊•·]+$/;
  return (
    (censorRun.test(left) && /^[A-Za-z0-9]/.test(right)) ||
    (/[A-Za-z0-9]$/.test(left) && censorRun.test(right))
  );
}

function applyCensorshipWordBoundaries(syllables) {
  if (!Array.isArray(syllables) || syllables.length <= 1) {
    return syllables;
  }
  for (let index = 0; index < syllables.length - 1; index += 1) {
    const current = syllables[index];
    const next = syllables[index + 1];
    if (!current || !next) {
      continue;
    }
    if (isCensorshipBoundary(current.text, next.text)) {
      current.isPartOfWord = false;
    }
  }
  return syllables;
}

function mergeCensorshipSyllables(syllables) {
  if (!Array.isArray(syllables) || syllables.length <= 1) return syllables;
  const censorGlyph = /^[*＊•·]+$/;
  const merged = [];
  let run = null;
  for (const syl of syllables) {
    const trimmed = String(syl.text || "").trim();
    if (censorGlyph.test(trimmed)) {
      if (!run) {
        run = {
          text: syl.text,
          startTime: syl.startTime,
          endTime: syl.endTime,
        };
      } else {
        run.text += syl.text;
        run.endTime = Math.max(run.endTime, syl.endTime);
      }
    } else {
      if (run) {
        merged.push(run);
        run = null;
      }
      merged.push(syl);
    }
  }
  if (run) merged.push(run);
  return applyCensorshipWordBoundaries(merged);
}

function mergeCensorshipSyllablesInLyrics(lyrics) {
  if (!Array.isArray(lyrics)) return lyrics;
  for (const line of lyrics) {
    if (line?.syllables?.length > 1) {
      line.syllables = applyCensorshipWordBoundaries(
        mergeCensorshipSyllables(line.syllables),
      );
    }
    if (line?.backgroundSyllables?.length > 1) {
      line.backgroundSyllables = applyCensorshipWordBoundaries(
        mergeCensorshipSyllables(line.backgroundSyllables),
      );
    }
  }
  return lyrics;
}

function extractParenthesisToBackground(lyrics) {
  if (!Array.isArray(lyrics)) return lyrics;
  const processedLyrics = [];
  let previousLine = null;

  for (let i = 0; i < lyrics.length; i++) {
    const line = lyrics[i];
    const newSyllables = [];
    const bgSyllables = [];
    let inParen = false;
    let currentBackgroundGroupHasContent = false;
    let completedBackgroundGroupCount = 0;

    const closeBackgroundGroup = () => {
      if (!currentBackgroundGroupHasContent) {
        return;
      }
      trimTrailingSyllableWhitespace(bgSyllables);
      completedBackgroundGroupCount += 1;
      currentBackgroundGroupHasContent = false;
    };

    const appendLeadSyllable = (syl, text) => {
      if (!String(text || "").trim()) {
        return;
      }
      newSyllables.push({ ...syl, text });
    };

    const appendBackgroundSyllable = (syl, text) => {
      const normalizedText = currentBackgroundGroupHasContent
        ? text
        : String(text || "").replace(/^\s+/, "");
      if (!String(normalizedText || "").trim()) {
        return;
      }
      if (!currentBackgroundGroupHasContent && completedBackgroundGroupCount) {
        appendBackgroundGroupSeparator(bgSyllables);
      }
      bgSyllables.push({ ...syl, text: normalizedText });
      currentBackgroundGroupHasContent = true;
    };

    for (let j = 0; j < (line.syllables || []).length; j++) {
      const syl = line.syllables[j];
      const rawText = String(syl.text || "");
      let chunkStart = 0;

      for (let charIndex = 0; charIndex < rawText.length; charIndex += 1) {
        const char = rawText[charIndex];
        const isOpenParen = char === "(" || char === "（";
        const isCloseParen = char === ")" || char === "）";
        if (!isOpenParen && !isCloseParen) {
          continue;
        }

        const chunk = rawText.slice(chunkStart, charIndex);
        if (inParen) {
          appendBackgroundSyllable(syl, chunk);
        } else {
          appendLeadSyllable(syl, chunk);
        }

        if (isOpenParen) {
          if (!inParen) {
            trimTrailingSyllableWhitespace(newSyllables, {
              markBoundary: false,
            });
            inParen = true;
          }
        } else if (inParen) {
          closeBackgroundGroup();
          inParen = false;
        } else {
          appendLeadSyllable(syl, char);
        }
        chunkStart = charIndex + 1;
      }

      const trailingChunk = rawText.slice(chunkStart);
      if (inParen) {
        appendBackgroundSyllable(syl, trailingChunk);
      } else {
        appendLeadSyllable(syl, trailingChunk);
      }
    }
    closeBackgroundGroup();

    // Remove any lead syllables that are now empty or whitespace-only after trimming.
    const cleanedLead = newSyllables.filter(
      (syl) => String(syl.text || "").trim().length > 0,
    );

    if (cleanedLead.length === 0 && bgSyllables.length > 0) {
      if (previousLine) {
        mergeBackgroundSyllablesIntoLine(previousLine, bgSyllables);
        previousLine.lineEndTime = Math.max(
          previousLine.lineEndTime || 0,
          line.lineEndTime || 0,
        );
      } else {
        line.syllables = [];
        line.backgroundSyllables = bgSyllables;
        processedLyrics.push(line);
        previousLine = line;
      }
    } else {
      line.syllables = cleanedLead;
      if (bgSyllables.length > 0) {
        mergeBackgroundSyllablesIntoLine(line, bgSyllables);
      }
      processedLyrics.push(line);
      previousLine = line;
    }
  }
  return processedLyrics.filter(
    (line) => line?.syllables?.length || line?.backgroundSyllables?.length,
  );
}

async function finalizeFetchedLyricsResult(result) {
  if (!result) {
    return null;
  }

  if (result.lyrics?.length) {
    mergeCensorshipSyllablesInLyrics(result.lyrics);
    const source = String(result.source || "").toLowerCase();
    if (!isSpicyKaraokeSource(result.source) && !source.includes("local-vault")) {
      result.lyrics = extractParenthesisToBackground(result.lyrics);
    }
  }
  return result;
}

function getLyricsTimingTier(sourceLabel) {
  const source = String(sourceLabel || "").toLowerCase();
  if (source.includes("spicy-lyrics-static")) {
    return 0;
  }
  if (source.includes("netease-lrc")) {
    return 1;
  }
  if (
    source.includes("richsync") ||
    source.includes("musicu-qrc") ||
    source.includes("kugou-krc") ||
    source.includes("karaoke") ||
    source.includes("yrc") ||
    source.includes("spicy-lyrics-syllable")
  ) {
    return 3;
  }
  if (source.includes("spicy-lyrics-line")) {
    return 2;
  }
  if (source.includes("qrc")) {
    return 2;
  }
  return 1;
}

function getLastLyricEndTimeMs(lyrics) {
  if (!Array.isArray(lyrics) || !lyrics.length) {
    return 0;
  }
  return lyrics.reduce((max, line) => {
    const end = Number(line?.lineEndTime || line?.lineStartTime || 0);
    return Number.isFinite(end) ? Math.max(max, end) : max;
  }, 0);
}

function getLyricsCoverageStats(lyrics, durationMs = 0) {
  const lineCount = Array.isArray(lyrics) ? lyrics.length : 0;
  if (!lineCount) {
    return {
      coverageRatio: 0,
      trailingGapMs: 0,
      lastTimedPointMs: 0,
      lineCount: 0,
    };
  }
  const lastTimedPointMs = getLastLyricEndTimeMs(lyrics);
  const safeDuration = Number(durationMs) > 0 ? Number(durationMs) : 0;
  if (safeDuration <= 0) {
    return {
      coverageRatio: 0.5,
      trailingGapMs: 0,
      lastTimedPointMs,
      lineCount,
    };
  }
  const trailingGapMs = Math.max(0, safeDuration - lastTimedPointMs);
  const trailingGapAllowanceMs = Math.min(
    Math.max(7_500, Math.floor(safeDuration * 0.12)),
    35_000,
  );
  const effectiveTimedPointMs = Math.min(
    safeDuration,
    lastTimedPointMs + Math.min(trailingGapMs, trailingGapAllowanceMs),
  );
  return {
    coverageRatio: Math.max(
      0,
      Math.min(1.5, effectiveTimedPointMs / safeDuration),
    ),
    trailingGapMs,
    lastTimedPointMs,
    lineCount,
  };
}

function getLyricsCoverageRatio(lyrics, durationMs = 0) {
  return getLyricsCoverageStats(lyrics, durationMs).coverageRatio;
}

function getSourcePriorityBucket(sourceLabel) {
  const source = String(sourceLabel || "").toLowerCase();
  if (source.includes("local-vault-karaoke")) {
    return 720;
  }
  if (source.includes("local-vault-line")) {
    return 380;
  }
  if (source.includes("spicy-lyrics-syllable")) {
    return 680;
  }
  if (source.includes("kugou-krc")) {
    return 620;
  }
  if (source.includes("qq-musicu-qrc")) {
    return 600;
  }
  if (source.includes("netease-yrc")) {
    return 560;
  }
  if (source.includes("musixmatch-richsync")) {
    return 520;
  }
  if (source.includes("spicy-lyrics-line")) {
    return 360;
  }
  if (source.includes("spicy-lyrics-static")) {
    return 180;
  }
  if (source.includes("lrclib")) {
    return 320;
  }
  if (source.includes("netease-lrc")) {
    return 300;
  }
  if (source.includes("musixmatch") && !source.includes("richsync")) {
    return 280;
  }
  if (source.includes("qq-")) {
    return 240;
  }
  return 200;
}

function isSpicyKaraokeSource(sourceLabel) {
  return String(sourceLabel || "")
    .toLowerCase()
    .includes("spicy-lyrics-syllable");
}

function isSpicyLyricsSource(sourceLabel) {
  return String(sourceLabel || "")
    .toLowerCase()
    .includes("spicy-lyrics");
}

function isSpicyLineSource(sourceLabel) {
  return String(sourceLabel || "")
    .toLowerCase()
    .includes("spicy-lyrics-line");
}

function isSpicyStaticSource(sourceLabel) {
  return String(sourceLabel || "")
    .toLowerCase()
    .includes("spicy-lyrics-static");
}

function isKaraokeLyricsSource(sourceLabel) {
  const source = String(sourceLabel || "").toLowerCase();
  if (source.includes("netease-lrc")) {
    return false;
  }
  return (
    isSpicyKaraokeSource(source) ||
    source.includes("kugou-krc") ||
    source.includes("qq-musicu-qrc") ||
    source.includes("netease-yrc") ||
    source.includes("musixmatch-richsync") ||
    source.includes("richsync") ||
    source.includes("karaoke") ||
    source.includes("yrc")
  );
}

function hasComparableLastLineTiming(referenceLyrics, candidateLyrics) {
  const referenceEnd = getLastLyricEndTimeMs(referenceLyrics);
  const candidateEnd = getLastLyricEndTimeMs(candidateLyrics);
  if (referenceEnd <= 0 || candidateEnd <= 0) {
    return true;
  }
  const toleranceMs = Math.max(8_000, Math.floor(referenceEnd * 0.14));
  return candidateEnd + toleranceMs >= referenceEnd;
}

function spicyLyricsFailFeaturedVariantCheck(track, result) {
  return (
    isSpicyLyricsSource(result?.source) &&
    featuredVariantLyricsMismatch(track, result?.lyrics, {
      source: "spicy",
      spicyDeclaredTitles: result?.metadata?.spicyVariantTitles,
      qqReferenceFingerprint: result?.metadata?.qqReferenceFingerprint,
    })
  );
}

function meetsCoverageDemand(track, currentBest, candidate) {
  if (!candidate?.lyrics?.length) {
    return false;
  }
  const candidateSource = String(candidate?.source || "").toLowerCase();
  if (candidateSource.includes("local-vault")) {
    return true;
  }
  if (isSpicyStaticSource(candidateSource)) {
    if (spicyLyricsFailFeaturedVariantCheck(track, candidate)) {
      return false;
    }
    if (
      currentBest?.lyrics?.length &&
      !isSpicyStaticSource(currentBest.source)
    ) {
      return false;
    }
    return candidate.lyrics.length > 0;
  }
  if (spicyLyricsFailFeaturedVariantCheck(track, candidate)) {
    return false;
  }
  const trackDuration = Number(track?.durationMs || 0);
  const candidateCoverageStats = getLyricsCoverageStats(
    candidate.lyrics,
    trackDuration,
  );
  const candidateCoverage = candidateCoverageStats.coverageRatio;
  const candidateIsKaraoke = isKaraokeLyricsSource(candidate.source);
  const candidateIsSpicyLine =
    isSpicyLineSource(candidate.source) && !candidateIsKaraoke;
  if (candidateIsSpicyLine) {
    if (
      currentBest?.lyrics?.length &&
      isKaraokeLyricsSource(currentBest.source)
    ) {
      return false;
    }
    return true;
  }
  const minimumCoverage = candidateIsKaraoke ? 0.4 : 0.46;
  if (trackDuration > 0 && candidateCoverage < minimumCoverage) {
    const allowedTrailingGapMs = Math.min(
      45_000,
      Math.max(18_000, Math.floor(trackDuration * 0.2)),
    );
    const modestCoverageMiss =
      candidateCoverage >= minimumCoverage - 0.08 &&
      candidateCoverageStats.lineCount >= 10;
    const looksLikeTrailingInstrumentalGap =
      candidateCoverageStats.trailingGapMs <= allowedTrailingGapMs &&
      candidateCoverageStats.lastTimedPointMs >= trackDuration * 0.34;
    if (!modestCoverageMiss || !looksLikeTrailingInstrumentalGap) {
      return false;
    }
  }

  if (currentBest?.lyrics?.length) {
    if (!hasComparableLastLineTiming(currentBest.lyrics, candidate.lyrics)) {
      return false;
    }
    const currentCoverage = getLyricsCoverageRatio(
      currentBest.lyrics,
      trackDuration,
    );
    if (!candidateIsKaraoke && candidateCoverage + 0.05 < currentCoverage) {
      return false;
    }
  }
  return true;
}

function isQqDirectFamilySource(sourceLabel) {
  const source = String(sourceLabel || "").toLowerCase();
  return (
    source.includes("qq-musicu-qrc") ||
    source.includes("qq-music-direct") ||
    source.includes("qq-legacy")
  );
}

function isQqNonDirectSource(sourceLabel) {
  const source = String(sourceLabel || "").toLowerCase();
  return (
    source.includes("qq-music-openapi-fallback") ||
    source.includes("qq-openapi") ||
    source.includes("qq-music-openai") ||
    source.includes("qq-openai")
  );
}

function scoreLyricsCandidate(track, result) {
  const coverageScore = scoreLyricsCoverage(
    result?.lyrics || [],
    track?.durationMs || 0,
  );
  const lineCount = Array.isArray(result?.lyrics) ? result.lyrics.length : 0;
  const timingTier = getLyricsTimingTier(result?.source || "");
  const coverageRatio = getLyricsCoverageRatio(
    result?.lyrics || [],
    track?.durationMs || 0,
  );
  return (
    coverageScore +
    timingTier * 36 +
    getSourcePriorityBucket(result?.source || "") * 0.15 +
    Math.min(18, lineCount * 0.22) +
    coverageRatio * 12
  );
}

function shouldUpgradeLyricsCandidate(track, currentBest, candidate) {
  if (
    !candidate?.lyrics?.length ||
    !meetsCoverageDemand(track, currentBest, candidate)
  ) {
    return false;
  }
  if (!currentBest?.lyrics?.length) {
    return true;
  }
  if (spicyLyricsFailFeaturedVariantCheck(track, candidate)) {
    return false;
  }
  if (spicyLyricsFailFeaturedVariantCheck(track, currentBest)) {
    return true;
  }
  const currentIsSpicyStatic = isSpicyStaticSource(currentBest.source);
  const nextIsSpicyStatic = isSpicyStaticSource(candidate.source);
  if (currentIsSpicyStatic && !nextIsSpicyStatic) {
    return true;
  }
  if (nextIsSpicyStatic && !currentIsSpicyStatic) {
    return false;
  }
  const currentIsSpicyKaraoke = isSpicyKaraokeSource(currentBest.source);
  const nextIsSpicyKaraoke = isSpicyKaraokeSource(candidate.source);
  if (currentIsSpicyKaraoke && !nextIsSpicyKaraoke) {
    return false;
  }
  if (nextIsSpicyKaraoke && !currentIsSpicyKaraoke) {
    return true;
  }

  const currentIsKaraoke = isKaraokeLyricsSource(currentBest.source);
  const nextIsKaraoke = isKaraokeLyricsSource(candidate.source);
  const currentIsSpicyLine = isSpicyLineSource(currentBest.source);
  const nextIsSpicyLine = isSpicyLineSource(candidate.source);
  if (currentIsSpicyLine && !nextIsSpicyLine && !nextIsKaraoke) {
    return false;
  }
  if (nextIsSpicyLine && !currentIsSpicyLine && !currentIsKaraoke) {
    return true;
  }
  const currentPriority = getSourcePriorityBucket(currentBest.source);
  const nextPriority = getSourcePriorityBucket(candidate.source);
  const currentTimingTier = getLyricsTimingTier(currentBest.source);
  const nextTimingTier = getLyricsTimingTier(candidate.source);
  const currentCoverage = getLyricsCoverageRatio(
    currentBest.lyrics,
    track?.durationMs || 0,
  );
  const nextCoverage = getLyricsCoverageRatio(
    candidate.lyrics,
    track?.durationMs || 0,
  );
  const currentScore = scoreLyricsCandidate(track, currentBest);
  const nextScore = scoreLyricsCandidate(track, candidate);

  // Karaoke upgrades should win quickly when they satisfy coverage demands.
  if (nextIsKaraoke && !currentIsKaraoke) {
    return true;
  }
  // Explicit karaoke priority order: spicy-lyrics-syllable > kugou-krc > qq-musicu-qrc > netease-yrc > musixmatch-richsync.
  if (nextIsKaraoke && currentIsKaraoke && nextPriority > currentPriority) {
    return true;
  }
  if (
    !nextIsKaraoke &&
    !currentIsKaraoke &&
    nextPriority > currentPriority &&
    nextCoverage >= currentCoverage - 0.04
  ) {
    return true;
  }
  // If both are karaoke, prefer QQ direct family over non-direct fallbacks.
  if (
    nextTimingTier >= 3 &&
    currentTimingTier >= 3 &&
    isQqDirectFamilySource(candidate.source) &&
    isQqNonDirectSource(currentBest.source)
  ) {
    return true;
  }
  // Prefer qq-direct over non-direct QQ fallbacks when coverage is comparable.
  if (
    isQqDirectFamilySource(candidate.source) &&
    isQqNonDirectSource(currentBest.source) &&
    nextCoverage >= currentCoverage - 0.08
  ) {
    return true;
  }
  // Significant coverage improvement should win.
  if (nextCoverage >= currentCoverage + 0.12) {
    return true;
  }
  if (nextCoverage >= 0.92 && currentCoverage <= 0.78) {
    return true;
  }
  return nextScore >= currentScore + 14;
}

async function fetchBestSyncedLyrics(
  track,
  {
    preferredSource = "auto",
    onProgress = null,
    onSourceCached = null,
    sourceCache = null,
    musixmatchUserToken = "",
    refreshMusixmatchUserToken = null,
    spotifyWebToken = "",
    spotifyAccessToken = "",
    waitForAutoCompletion = false,
  } = {},
) {
  const failures = [];
  let safeMusixmatchUserToken = String(musixmatchUserToken || "").trim();
  const safeSpotifyWebToken = String(spotifyWebToken || "").trim();
  const safeSpotifyAccessToken = String(spotifyAccessToken || "").trim();
  const hasSpotifyTrackId = Boolean(String(track?.spotifyTrackId || "").trim());
  const attemptOrder = getSourceAttemptOrder(preferredSource, {
    hasMusixmatchUserToken: Boolean(safeMusixmatchUserToken),
    hasSpotifyWebToken:
      Boolean(safeSpotifyWebToken) || Boolean(safeSpotifyAccessToken),
    hasSpotifyTrackId,
    track,
  });
  if (!attemptOrder.length) {
    return { lyrics: [], source: "all-selected-sources-disabled" };
  }

  const preferred = sanitizePreferredSource(preferredSource);
  const tryLocalVaultOnly =
    preferred === "local-vault" ||
    (preferred === "auto" && attemptOrder.includes("local-vault"));

  if (tryLocalVaultOnly) {
    const vaultFetcher = SOURCE_FETCHERS["local-vault"];
    if (typeof vaultFetcher === "function") {
      try {
        const vaultResult = await vaultFetcher(track, {
          musixmatchUserToken: safeMusixmatchUserToken,
          spotifyWebToken: safeSpotifyWebToken,
          spotifyAccessToken: safeSpotifyAccessToken,
        });
        if (vaultResult?.lyrics?.length) {
          const finalizedVault = await finalizeFetchedLyricsResult(vaultResult);
          if (meetsCoverageDemand(track, null, finalizedVault)) {
            if (typeof sourceCache?.set === "function") {
              sourceCache.set("local-vault", finalizedVault);
            }
            if (typeof onSourceCached === "function") {
              onSourceCached(finalizedVault, "local-vault");
            }
            return finalizedVault;
          }
        }
      } catch {
        // Vault miss or read error — fall through to API sources when auto.
      }
      if (preferred === "local-vault") {
        return { lyrics: [], source: "local-vault:no-match" };
      }
    }
  }

  const apiAttemptOrder = attemptOrder.filter((source) => source !== "local-vault");
  if (!apiAttemptOrder.length) {
    return { lyrics: [], source: "local-vault:no-match" };
  }

  const cacheSourceResult = (source, candidate) => {
    if (!candidate?.lyrics?.length) {
      return;
    }
    if (typeof sourceCache?.set === "function") {
      sourceCache.set(source, candidate);
    }
    if (typeof onSourceCached === "function") {
      onSourceCached(candidate, source);
    }
  };

  const invokeSourceFetcher = async (source, fetcher) => {
    const fetchWithCurrentToken = () =>
      fetcher(track, {
        musixmatchUserToken: safeMusixmatchUserToken,
        spotifyWebToken: safeSpotifyWebToken,
        spotifyAccessToken: safeSpotifyAccessToken,
      });
    try {
      return await fetchWithCurrentToken();
    } catch (error) {
      if (
        source !== "musixmatch" ||
        describeSourceError(error) !== "unauthorized" ||
        typeof refreshMusixmatchUserToken !== "function"
      ) {
        throw error;
      }
      const refreshedToken = String(
        (await refreshMusixmatchUserToken()) || "",
      ).trim();
      if (!refreshedToken || refreshedToken === safeMusixmatchUserToken) {
        throw error;
      }
      safeMusixmatchUserToken = refreshedToken;
      return fetchWithCurrentToken();
    }
  };

  if (sanitizePreferredSource(preferredSource) === "auto") {
    const failureBySource = new Map();

    const sourceTasks = apiAttemptOrder.map(async (source) => {
      const fetcher = SOURCE_FETCHERS[source];
      if (typeof fetcher !== "function") {
        const reason = `${source}:unknown-source`;
        failureBySource.set(source, reason);
        return {
          source,
          ok: false,
          failureReason: reason,
          result: null,
        };
      }
      const cachedResult =
        typeof sourceCache?.get === "function" ? sourceCache.get(source) : null;
      if (cachedResult?.lyrics?.length) {
        cacheSourceResult(source, cachedResult);
        return {
          source,
          ok: true,
          failureReason: "",
          result: cachedResult,
          fromCache: true,
        };
      }
      try {
        const result = await invokeSourceFetcher(source, fetcher);
        if (!result) {
          const reason = classifySourceFailure(
            source,
            new Error("__NO_MATCH__"),
          );
          failureBySource.set(source, reason);
          return {
            source,
            ok: false,
            failureReason: reason,
            result: null,
          };
        }
        if (result?.metadata?.instrumental && !result?.lyrics?.length) {
          const reason = `${source}:instrumental`;
          failureBySource.set(source, reason);
          return {
            source,
            ok: false,
            failureReason: reason,
            result,
          };
        }
        const quickCandidate = await finalizeFetchedLyricsResult(result);
        if (!meetsCoverageDemand(track, null, quickCandidate)) {
          const reason = `${source}:insufficient-coverage`;
          failureBySource.set(source, reason);
          return {
            source,
            ok: false,
            failureReason: reason,
            result: null,
          };
        }
        cacheSourceResult(source, quickCandidate);
        return {
          source,
          ok: true,
          failureReason: "",
          result: quickCandidate,
        };
      } catch (error) {
        const reason = classifySourceFailure(source, error);
        failureBySource.set(source, reason);
        return {
          source,
          ok: false,
          failureReason: reason,
          result: null,
        };
      }
    });
    try {
      if (waitForAutoCompletion) {
        const settled = await Promise.all(sourceTasks);
        const successful = settled
          .filter((outcome) => outcome.ok && outcome.result?.lyrics?.length)
          .map((outcome) => outcome.result);
        if (!successful.length) {
          const instrumentalOutcome = settled.find(
            (outcome) => outcome.result?.metadata?.instrumental,
          );
          if (instrumentalOutcome) {
            return {
              lyrics: [],
              source: `${instrumentalOutcome.source}-instrumental`,
              metadata: {
                ...(instrumentalOutcome.result?.metadata || {}),
                instrumental: true,
              },
            };
          }
          const failures = apiAttemptOrder.map(
            (source) => failureBySource.get(source) || `${source}:no-match`,
          );
          return {
            lyrics: [],
            source: failures.join(" | ") || "lyrics-unavailable",
          };
        }
        let bestFinal = successful[0];
        for (const candidate of successful.slice(1)) {
          if (shouldUpgradeLyricsCandidate(track, bestFinal, candidate)) {
            bestFinal = candidate;
          }
        }
        return bestFinal;
      }

      const raceTasks = sourceTasks.map(async (taskPromise) => {
        const outcome = await taskPromise;
        if (!outcome.ok || !outcome.result?.lyrics?.length) {
          throw new Error(outcome.failureReason || "__NO_MATCH__");
        }
        return outcome;
      });

      let quickestOutcome = null;
      try {
        quickestOutcome = await Promise.any(raceTasks);
      } catch {
        quickestOutcome = null;
      }

      if (!quickestOutcome) {
        const settled = await Promise.all(sourceTasks);
        const successful = settled
          .filter((outcome) => outcome.ok && outcome.result?.lyrics?.length)
          .map((outcome) => outcome.result);
        if (!successful.length) {
          const instrumentalOutcome = settled.find(
            (outcome) => outcome.result?.metadata?.instrumental,
          );
          if (instrumentalOutcome) {
            return {
              lyrics: [],
              source: `${instrumentalOutcome.source}-instrumental`,
              metadata: {
                ...(instrumentalOutcome.result?.metadata || {}),
                instrumental: true,
              },
            };
          }
          const failures = apiAttemptOrder.map(
            (source) => failureBySource.get(source) || `${source}:no-match`,
          );
          return {
            lyrics: [],
            source: failures.join(" | ") || "lyrics-unavailable",
          };
        }
        let bestFinal = successful[0];
        for (const candidate of successful.slice(1)) {
          if (shouldUpgradeLyricsCandidate(track, bestFinal, candidate)) {
            bestFinal = candidate;
          }
        }
        return bestFinal;
      }
      let bestResult = quickestOutcome.result;

      // Continue probing in background; cache every successful source and upgrade when better.
      if (apiAttemptOrder.length > 1) {
        for (const taskPromise of sourceTasks) {
          void taskPromise
            .then(async (outcome) => {
              if (!outcome.ok || !outcome.result?.lyrics?.length) {
                return;
              }
              const finalizedCandidate = outcome.fromCache
                ? outcome.result
                : await finalizeFetchedLyricsResult(outcome.result);
              cacheSourceResult(outcome.source, finalizedCandidate);
              if (typeof onProgress !== "function") {
                return;
              }
              if (
                shouldUpgradeLyricsCandidate(
                  track,
                  bestResult,
                  finalizedCandidate,
                )
              ) {
                bestResult = finalizedCandidate;
                onProgress(finalizedCandidate);
              }
            })
            .catch(() => {
              // Individual background source failures are expected and ignored.
            });
        }
      }

      return bestResult || { lyrics: [], source: "lyrics-unavailable" };
    } catch {
      const failures = apiAttemptOrder.map(
        (source) => failureBySource.get(source) || `${source}:no-match`,
      );
      return {
        lyrics: [],
        source: failures.join(" | ") || "lyrics-unavailable",
      };
    }
  }

  for (const source of apiAttemptOrder) {
    const fetcher = SOURCE_FETCHERS[source];
    if (typeof fetcher !== "function") {
      continue;
    }
    const cachedResult =
      typeof sourceCache?.get === "function" ? sourceCache.get(source) : null;
    if (cachedResult?.lyrics?.length) {
      cacheSourceResult(source, cachedResult);
      return cachedResult;
    }
    try {
      const result = await invokeSourceFetcher(source, fetcher);
      if (result) {
        if (result?.metadata?.instrumental && !result?.lyrics?.length) {
          return {
            lyrics: [],
            source: `${source}-instrumental`,
            metadata: {
              ...(result.metadata || {}),
              instrumental: true,
            },
          };
        }
        const finalized = await finalizeFetchedLyricsResult(result);
        if (meetsCoverageDemand(track, null, finalized)) {
          cacheSourceResult(source, finalized);
          return finalized;
        }
        failures.push(`${source}:insufficient-coverage`);
        continue;
      }
      failures.push(classifySourceFailure(source, new Error("__NO_MATCH__")));
    } catch (error) {
      failures.push(classifySourceFailure(source, error));
    }
  }

  return { lyrics: [], source: failures.join(" | ") || "lyrics-unavailable" };
}

async function enrichTrackForVaultMatch(track, spotifyAccessToken = "") {
  let matchTrack = await buildLyricsMatchTrack(track, { spotifyAccessToken });
  if (String(matchTrack?.spotifyTrackId || "").trim() || !spotifyAccessToken) {
    return matchTrack;
  }
  if (!String(matchTrack?.title || "").trim()) {
    return matchTrack;
  }
  try {
    const resolved = await resolveSpotifyCatalogTrackViaPartnerSearch(
      matchTrack,
      spotifyAccessToken,
    );
    if (!resolved?.id) {
      return matchTrack;
    }
    return buildLyricsMatchTrack(
      { ...matchTrack, spotifyTrackId: resolved.id },
      { spotifyAccessToken },
    );
  } catch {
    return matchTrack;
  }
}

// ---- DesktopBridge/src/lyrics/parts/07b-service-orchestration.js ----
function createLyricsService({
  getMusixmatchUserToken = () => process.env.MUSIXMATCH_USER_TOKEN || "",
  refreshMusixmatchUserToken = null,
  getSpotifyWebToken = () => process.env.SPOTIFY_WEB_TOKEN || "",
  getGeminiApiKey = () =>
    process.env.GEMINI_API_KEY || process.env.OPENROUTER_API_KEY || "",
  getSpotifyAccessToken = () => "",
  getSpicyLyricsUseCorsProxy = null,
} = {}) {
  setSpicyLyricsNetworkOptions({ getSpicyLyricsUseCorsProxy });
  const lastDisplayedByTrack = new Map();
  const geminiTranslationCache = new Map();
  const publishedToFrontendCache = new Map();
  const activeTrackSourceCache = {
    trackId: "",
    bySource: new Map(),
  };
  const AUTO_TRANSLATION_QUIET_MS = 5_000;

  const stripDesktopSourceSuffix = (source) =>
    String(source || "")
      .replace(/\|mobile$/i, "")
      .trim();

  /** Map fetcher-specific labels (e.g. qq-musicu-qrc) to Expo/bridge source keys (qq-direct). */
  const canonicalSourceCacheKey = (source) => {
    const stripped = stripDesktopSourceSuffix(source).replace(
      /-instrumental$/i,
      "",
    );
    if (!stripped) {
      return "";
    }
    const aliased = normalizeSourceKey(stripped);
    if (VALID_SOURCE_KEYS.has(aliased) && aliased !== "auto") {
      return aliased;
    }
    const lower = stripped.toLowerCase();
    if (lower.includes("qq")) {
      return "qq-direct";
    }
    if (lower.includes("netease") || lower === "163") {
      return "netease";
    }
    if (lower.includes("musixmatch") || lower === "mxm") {
      return "musixmatch";
    }
    if (lower.includes("lrclib")) {
      return "lrclib";
    }
    if (lower.includes("spicy")) {
      return "spicy-lyrics";
    }
    if (lower.includes("kugou")) {
      return "kugou";
    }
    if (lower.includes("local-vault")) {
      return "local-vault";
    }
    const preferred = sanitizePreferredSource(stripped);
    return preferred === "auto" ? "" : preferred;
  };

  const hasTranslatedLinesInLyrics = (lyrics) =>
    Array.isArray(lyrics) &&
    lyrics.some((line) => String(line?.translatedText || "").trim().length > 0);

  const packetLyricsSignature = (packet) => {
    const lyrics = Array.isArray(packet?.lyrics) ? packet.lyrics : [];
    const first = lyrics[0];
    const last = lyrics[lyrics.length - 1];
    return [
      lyrics.length,
      Number(first?.lineStartTime || -1),
      Number(last?.lineEndTime || -1),
    ].join("|");
  };

  const cloneSourceCachePacket = (basePacket) => {
    const safeLyrics = Array.isArray(basePacket?.lyrics)
      ? basePacket.lyrics.map((line) =>
          line && typeof line === "object"
            ? JSON.parse(JSON.stringify(line))
            : line,
        )
      : [];
    if (basePacket?.lyrics?.translationMeta) {
      safeLyrics.translationMeta = JSON.parse(
        JSON.stringify(basePacket.lyrics.translationMeta),
      );
    }
    return {
      source:
        stripDesktopSourceSuffix(basePacket?.source) ||
        String(basePacket?.source || "mobile-app"),
      metadata:
        basePacket?.metadata && typeof basePacket.metadata === "object"
          ? JSON.parse(JSON.stringify(basePacket.metadata))
          : {},
      lyrics: safeLyrics,
      statusMessage: String(basePacket?.statusMessage || ""),
    };
  };

  const setActiveTrack = (trackId) => {
    const cacheKey = String(trackId || "").trim();
    if (!cacheKey) {
      activeTrackSourceCache.trackId = "";
      activeTrackSourceCache.bySource = new Map();
      return;
    }
    if (activeTrackSourceCache.trackId === cacheKey) {
      return;
    }
    activeTrackSourceCache.trackId = cacheKey;
    activeTrackSourceCache.bySource = new Map();
    for (const publishedTrackId of [...publishedToFrontendCache.keys()]) {
      if (publishedTrackId !== cacheKey) {
        publishedToFrontendCache.delete(publishedTrackId);
      }
    }
    for (const displayedTrackId of [...lastDisplayedByTrack.keys()]) {
      if (displayedTrackId !== cacheKey) {
        lastDisplayedByTrack.delete(displayedTrackId);
      }
    }
  };

  const rememberSourceLyrics = (trackId, sourceKey, basePacket) => {
    const cacheKey = String(trackId || "").trim();
    const normalizedSource = canonicalSourceCacheKey(sourceKey);
    if (!cacheKey || !normalizedSource) {
      return;
    }
    if (!basePacket?.lyrics?.length) {
      return;
    }
    if (activeTrackSourceCache.trackId !== cacheKey) {
      setActiveTrack(cacheKey);
    }
    const incoming = cloneSourceCachePacket(basePacket);
    const existing = activeTrackSourceCache.bySource.get(normalizedSource);
    if (
      existing?.lyrics?.length &&
      hasTranslatedLinesInLyrics(existing.lyrics) &&
      !hasTranslatedLinesInLyrics(incoming.lyrics) &&
      packetLyricsSignature(existing) === packetLyricsSignature(incoming)
    ) {
      return;
    }
    activeTrackSourceCache.bySource.set(normalizedSource, incoming);
  };

  const getCachedSourceLyricsPacket = (trackId, preferredSource) => {
    const cacheKey = String(trackId || "").trim();
    const normalizedSource = canonicalSourceCacheKey(preferredSource);
    if (!cacheKey || !normalizedSource) {
      return null;
    }
    if (activeTrackSourceCache.trackId !== cacheKey) {
      return null;
    }
    const base = activeTrackSourceCache.bySource.get(normalizedSource);
    if (!base?.lyrics?.length) {
      return null;
    }
    return buildLyricsPacketFromBase({ trackId: cacheKey }, base);
  };

  const cloneLyricsLinesWithoutTranslations = (lyrics) => {
    if (!Array.isArray(lyrics)) {
      return [];
    }
    return lyrics.map((line) => {
      if (!line || typeof line !== "object") {
        return line;
      }
      const { translatedText, translationMeta, ...rest } = line;
      return rest;
    });
  };

  const rememberPublishedLyrics = (trackId, packet) => {
    const cacheKey = String(trackId || "").trim();
    if (!cacheKey || !packet) {
      return;
    }
    const lyrics = cloneLyricsLinesWithoutTranslations(packet.lyrics);
    if (!lyrics.length) {
      return;
    }
    const metadata =
      packet.metadata && typeof packet.metadata === "object"
        ? { ...packet.metadata }
        : {};
    delete metadata.translation;
    publishedToFrontendCache.set(cacheKey, {
      source:
        stripDesktopSourceSuffix(packet.source) ||
        String(packet.source || "mobile-app"),
      metadata,
      lyrics,
      statusMessage: String(packet.statusMessage || ""),
    });
  };

  const getPublishedLyrics = (trackId) => {
    const cacheKey = String(trackId || "").trim();
    if (!cacheKey) {
      return null;
    }
    return publishedToFrontendCache.get(cacheKey) || null;
  };

  const buildLyricsPacketFromBase = (track, basePacket) => {
    const safeLyrics = Array.isArray(basePacket?.lyrics) ? basePacket.lyrics : [];
    const sourceRoot =
      stripDesktopSourceSuffix(basePacket?.source) || "mobile-app";
    return {
      trackId: track.trackId,
      lyrics: safeLyrics,
      source: `${sourceRoot}|mobile`,
      metadata: mergeLyricsMetadata(basePacket?.metadata, {
        translation:
          safeLyrics.translationMeta || basePacket?.metadata?.translation,
      }),
      statusMessage: safeLyrics.length
        ? basePacket?.statusMessage ||
          `Loaded ${safeLyrics.length} synced lines from ${sourceRoot} on mobile.`
        : basePacket?.statusMessage ||
          (basePacket?.metadata?.instrumental
            ? "This song is an instrumental."
            : `No synced lyrics found (${sourceRoot}).`),
    };
  };

  const getMusixmatchRuntimeStatus = () => {
    const cooldown = getMusixmatchCooldownInfo();
    const geminiCooldown = getGeminiCooldownInfo();
    cleanupExpiredMusixmatchResultCache();
    return {
      musixmatchCooldownActive: cooldown.active,
      musixmatchCooldownRemainingMs: cooldown.remainingMs,
      musixmatchCooldownReason: cooldown.reason || "",
      musixmatchCooldownStartedAt: cooldown.startedAt || 0,
      musixmatchCacheEntries: musixmatchRuntimeState.resultCache.size,
      musixmatchTranslationCacheEntries:
        musixmatchRuntimeState.translationCache.size,
      geminiTranslationCacheEntries: geminiTranslationCache.size,
      publishedLyricsCacheEntries: publishedToFrontendCache.size,
      activeTrackSourceCacheEntries: activeTrackSourceCache.bySource.size,
      activeTrackSourceCacheTrackId: activeTrackSourceCache.trackId || "",
      geminiCooldownActive: geminiCooldown.active,
      geminiCooldownRemainingMs: geminiCooldown.remainingMs,
      geminiCooldownReason: geminiCooldown.reason || "",
      geminiCooldownStartedAt: geminiCooldown.startedAt || 0,
      musixmatchCacheTtlMs: MUSIXMATCH_RESULT_CACHE_TTL_MS,
      musixmatchCooldownTtlMs: MUSIXMATCH_COOLDOWN_MS,
      geminiCooldownTtlMs: GEMINI_RATE_LIMIT_COOLDOWN_MS,
    };
  };

  return {
    setActiveTrack,
    rememberPublishedLyrics,
    getPublishedLyrics,
    getCachedSourceLyricsPacket,
    resolveSpotifyCatalogTrackById,
    resolveSpotifyCatalogTrackViaPartnerSearch,
    buildLyricsMatchTrack,
    mergeNativePlaybackArtist,
    applySpotifyCatalogOverlay,
    async translatePublishedLyrics(track, { onSyncedLyrics = null } = {}) {
      if (!track?.trackId || !track?.title) {
        const empty = {
          trackId: "",
          lyrics: [],
          source: "mobile-app",
          statusMessage: "No active track.",
        };
        if (typeof onSyncedLyrics === "function") {
          onSyncedLyrics(empty);
        }
        return empty;
      }

      const cacheKey = track.trackId;
      const published = getPublishedLyrics(cacheKey);
      if (!published?.lyrics?.length) {
        const empty = {
          trackId: cacheKey,
          lyrics: [],
          source: "mobile-app",
          statusMessage:
            "No lyrics on screen to translate yet. Wait for lyrics to load, then try again.",
        };
        if (typeof onSyncedLyrics === "function") {
          onSyncedLyrics(empty);
        }
        return empty;
      }

      const basePacket = {
        source: published.source,
        metadata: published.metadata,
        lyrics: published.lyrics,
        statusMessage: published.statusMessage,
      };

      const emitToFrontend = (packetBase) => {
        const packet = buildLyricsPacketFromBase(track, packetBase);
        lastDisplayedByTrack.set(cacheKey, packet);
        if (typeof onSyncedLyrics === "function") {
          onSyncedLyrics(packet);
        }
      };

      console.log(
        `[lyrics-translate] translate-only for ${String(track.title || "unknown title")} using ${published.lyrics.length} published lines (source=${String(published.source || "unknown")})`,
      );

      emitToFrontend({
        ...basePacket,
        metadata: mergeLyricsMetadata(basePacket.metadata, {
          translation: {
            isLoading: true,
            provider: "Gemini",
            requestedAt: Date.now(),
          },
        }),
      });

      const enrichedLyrics = await enrichLyricsWithGeminiTranslations(
        track,
        basePacket.lyrics,
        {
          geminiApiKey: String(getGeminiApiKey() || "").trim(),
          geminiCache: geminiTranslationCache,
        },
      );

      const finalBase = {
        ...basePacket,
        lyrics: enrichedLyrics,
        metadata: mergeLyricsMetadata(basePacket.metadata, {
          translation: enrichedLyrics.translationMeta,
        }),
      };

      emitToFrontend(finalBase);
      rememberSourceLyrics(cacheKey, published.source, finalBase);
      return buildLyricsPacketFromBase(track, finalBase);
    },
    async fetchSyncedLyrics(
      track,
      {
        force = false,
        preferredSource = "auto",
        onSyncedLyrics = null,
        immediateTranslation = false,
      } = {},
    ) {
      if (!track?.trackId || !track?.title) {
        return {
          trackId: "",
          lyrics: [],
          source: "mobile-app",
          statusMessage: "No active track.",
        };
      }
      const cacheKey = track.trackId;
      setActiveTrack(cacheKey);
      const normalizedPreferredSource =
        sanitizePreferredSource(preferredSource);

      let matchTrack = { ...track };

      if (!force && normalizedPreferredSource !== "auto") {
        const cachedSourcePacket = getCachedSourceLyricsPacket(
          cacheKey,
          normalizedPreferredSource,
        );
        if (cachedSourcePacket) {
          console.log(
            `[bridge-lyrics] per-source cache hit track=${cacheKey} source=${normalizedPreferredSource} lines=${cachedSourcePacket.lyrics.length}`,
          );
          lastDisplayedByTrack.set(cacheKey, cachedSourcePacket);
          if (typeof onSyncedLyrics === "function") {
            onSyncedLyrics(cachedSourcePacket);
          }
          return cachedSourcePacket;
        }
      }

      const sourceCache = {
        get: (source) => {
          if (activeTrackSourceCache.trackId !== cacheKey) {
            return null;
          }
          return (
            activeTrackSourceCache.bySource.get(
              sanitizePreferredSource(source),
            ) || null
          );
        },
        set: (source, basePacket) => {
          rememberSourceLyrics(cacheKey, source, basePacket);
        },
      };

      let lastEmittedSignature = "";
      let bestBasePacket = null;

      const buildCachedPacket = (basePacket) => {
        const safeLyrics = Array.isArray(basePacket?.lyrics)
          ? basePacket.lyrics
          : [];
        return {
          trackId: track.trackId,
          lyrics: safeLyrics,
          source: `${String(basePacket?.source || "mobile-app")}|mobile`,
          metadata: mergeLyricsMetadata(basePacket?.metadata, {
            translation: safeLyrics.translationMeta,
          }),
          statusMessage: safeLyrics.length
            ? `Loaded ${safeLyrics.length} synced lines from ${String(basePacket?.source || "mobile-app")} on mobile.`
            : basePacket?.metadata?.instrumental
              ? "This song is an instrumental."
              : `No synced lyrics found (${String(basePacket?.source || "unknown reason")}).`,
        };
      };

      const cacheDisplayedPacket = (basePacket) => {
        if (!basePacket) {
          return;
        }
        const packet = buildCachedPacket(basePacket);
        lastDisplayedByTrack.set(cacheKey, packet);
        rememberSourceLyrics(cacheKey, basePacket?.source, basePacket);
      };

      const emitPacket = (basePacket) => {
        if (!basePacket) {
          return;
        }
        const safeLyrics = Array.isArray(basePacket?.lyrics)
          ? basePacket.lyrics
          : [];
        cacheDisplayedPacket(basePacket);
        if (typeof onSyncedLyrics !== "function") {
          return;
        }
        const first = safeLyrics[0];
        const last = safeLyrics[safeLyrics.length - 1];
        const translatedLineCount = Array.isArray(safeLyrics)
          ? safeLyrics.reduce(
              (count, line) =>
                count + (String(line?.translatedText || "").trim() ? 1 : 0),
              0,
            )
          : 0;
        const signature = [
          String(basePacket.source || ""),
          Number(safeLyrics.length || 0),
          Number(first?.lineStartTime || -1),
          Number(last?.lineEndTime || -1),
          translatedLineCount,
          Boolean(basePacket?.metadata?.translation?.isLoading),
          String(basePacket?.metadata?.translation?.model || ""),
        ].join("|");
        if (signature === lastEmittedSignature) {
          return;
        }
        lastEmittedSignature = signature;
        onSyncedLyrics({
          trackId: track.trackId,
          lyrics: safeLyrics,
          source: `${basePacket.source}|mobile`,
          metadata: mergeLyricsMetadata(basePacket?.metadata, {
            translation: safeLyrics.translationMeta,
          }),
          statusMessage: safeLyrics.length
            ? `Loaded ${safeLyrics.length} synced lines from ${basePacket.source} on mobile.`
            : basePacket?.metadata?.instrumental
              ? "This song is an instrumental."
              : `No synced lyrics found (${basePacket.source || "unknown reason"}).`,
        });
      };

      const registerCandidate = (candidatePacket) => {
        const safeCandidate = {
          ...candidatePacket,
          lyrics: Array.isArray(candidatePacket?.lyrics)
            ? candidatePacket.lyrics
            : [],
        };
        if (!safeCandidate.lyrics.length) {
          return false;
        }
        if (!bestBasePacket?.lyrics?.length) {
          bestBasePacket = safeCandidate;
          return true;
        }
        if (
          shouldUpgradeLyricsCandidate(matchTrack, bestBasePacket, safeCandidate)
        ) {
          bestBasePacket = safeCandidate;
          return true;
        }
        return false;
      };

      const getBasePacketSignature = (packet) => {
        const first = packet?.lyrics?.[0];
        const last = packet?.lyrics?.[packet?.lyrics?.length - 1];
        return [
          String(packet?.source || ""),
          Number(packet?.lyrics?.length || 0),
          Number(first?.lineStartTime || -1),
          Number(last?.lineEndTime || -1),
        ].join("|");
      };

      const countTranslatedLines = (lyrics) =>
        Array.isArray(lyrics)
          ? lyrics.reduce(
              (count, line) =>
                count + (String(line?.translatedText || "").trim() ? 1 : 0),
              0,
            )
          : 0;

      const hasTranslatedLines = (lyrics) => countTranslatedLines(lyrics) > 0;

      const attemptedTranslationSignatures = new Set();
      let sourceStableTranslationTimer = null;
      let sourceStableTranslationInFlight = false;
      let initialBaseCandidate = null;
      let initialBase = null;

      const getLatestBasePacket = () =>
        bestBasePacket || initialBase || initialBaseCandidate;

      const isCurrentBestPacket = (packet) => {
        if (!packet?.lyrics?.length) {
          return false;
        }
        const currentBest = getLatestBasePacket();
        if (!currentBest?.lyrics?.length) {
          return false;
        }
        return (
          getBasePacketSignature(packet) === getBasePacketSignature(currentBest)
        );
      };

      const emitTranslatedPacketIfCurrentBest = (packet) => {
        if (!packet?.lyrics?.length) {
          return false;
        }
        if (!hasTranslatedLines(packet.lyrics)) {
          emitPacket(packet);
          return true;
        }
        if (!isCurrentBestPacket(packet)) {
          return false;
        }
        emitPacket(packet);
        return true;
      };

      const runTranslationForLatestBasePacket = async () => {
        if (sourceStableTranslationInFlight) {
          return;
        }
        const latestBase = getLatestBasePacket();
        if (!latestBase?.lyrics?.length) {
          return;
        }

        sourceStableTranslationInFlight = true;
        try {
          const latestSignature = getBasePacketSignature(latestBase);
          emitPacket({
            ...latestBase,
            metadata: mergeLyricsMetadata(latestBase.metadata, {
              translation: {
                isLoading: true,
                provider: "Gemini",
                requestedAt: Date.now(),
              },
            }),
          });
          const enrichedLyrics = await enrichLyricsWithGeminiTranslations(
            track,
            latestBase.lyrics,
            {
              geminiApiKey: String(getGeminiApiKey() || "").trim(),
              geminiCache: geminiTranslationCache,
            },
          );
          const translatedBase = {
            ...latestBase,
            lyrics: enrichedLyrics,
            metadata: mergeLyricsMetadata(latestBase.metadata, {
              translation: enrichedLyrics.translationMeta,
            }),
          };

          const currentBest = getLatestBasePacket();
          if (
            getBasePacketSignature(currentBest) === latestSignature &&
            bestBasePacket?.lyrics?.length
          ) {
            bestBasePacket = translatedBase;
          }
          emitTranslatedPacketIfCurrentBest(translatedBase);
        } finally {
          sourceStableTranslationInFlight = false;
        }
      };

      const scheduleStableSourceTranslation = ({ immediate = false } = {}) => {
        const latestBase = getLatestBasePacket();
        if (!latestBase?.lyrics?.length) {
          return;
        }
        if (hasTranslatedLines(latestBase.lyrics)) {
          return;
        }
        const signature = getBasePacketSignature(latestBase);
        if (!immediate) {
          return;
        }
        if (attemptedTranslationSignatures.has(signature)) {
          return;
        }

        if (sourceStableTranslationTimer) {
          clearTimeout(sourceStableTranslationTimer);
        }

        sourceStableTranslationTimer = setTimeout(
          () => {
            sourceStableTranslationTimer = null;
            const currentBase = getLatestBasePacket();
            if (!currentBase?.lyrics?.length) {
              return;
            }
            const currentSignature = getBasePacketSignature(currentBase);
            if (currentSignature !== signature) {
              scheduleStableSourceTranslation();
              return;
            }
            attemptedTranslationSignatures.add(currentSignature);
            void runTranslationForLatestBasePacket();
          },
          immediate ? 0 : AUTO_TRANSLATION_QUIET_MS,
        );
      };

      const isAutoPreferredSource =
        sanitizePreferredSource(preferredSource) === "auto";
      let autoTranslationTimer = null;
      let resolveAutoTranslationReady = null;
      const autoTranslationReadyPromise = new Promise((resolve) => {
        resolveAutoTranslationReady = resolve;
      });
      let autoTranslationReadyResolved = false;
      let sourceChangedAfterAutoReady = false;

      const shouldTranslate = () => Boolean(immediateTranslation);

      const resolveAutoTranslationReadyNow = () => {
        if (autoTranslationReadyResolved) {
          return;
        }
        autoTranslationReadyResolved = true;
        if (autoTranslationTimer) {
          clearTimeout(autoTranslationTimer);
          autoTranslationTimer = null;
        }
        resolveAutoTranslationReady?.();
      };

      const scheduleAutoTranslationQuietWindow = () => {
        if (!isAutoPreferredSource || !bestBasePacket?.lyrics?.length) {
          return;
        }
        if (autoTranslationTimer) {
          clearTimeout(autoTranslationTimer);
        }
        resolveAutoTranslationReadyNow();
      };

      const handleProgressPacket = (candidatePacket) => {
        const upgraded = registerCandidate(candidatePacket);
        if (upgraded) {
          emitPacket(bestBasePacket);
          const shouldTranslateImmediately = shouldTranslate();
          if (
            isAutoPreferredSource &&
            !hasTranslatedLines(bestBasePacket?.lyrics || []) &&
            shouldTranslateImmediately
          ) {
            scheduleStableSourceTranslation({
              immediate: shouldTranslateImmediately,
            });
          }
          if (autoTranslationReadyResolved) {
            sourceChangedAfterAutoReady = true;
          } else if (shouldTranslateImmediately) {
            resolveAutoTranslationReadyNow();
          } else {
            scheduleAutoTranslationQuietWindow();
          }
        }
      };

      let resolvedSpotifyAccessToken = "";
      try {
        resolvedSpotifyAccessToken = String(
          (typeof getSpotifyAccessToken === "function"
            ? await getSpotifyAccessToken()
            : "") || "",
        ).trim();
      } catch {
        // Spotify OAuth token unavailable; continue without it.
      }

      matchTrack = await buildLyricsMatchTrack(track, {
        spotifyAccessToken: resolvedSpotifyAccessToken,
      });

      let resolvedMusixmatchUserToken = "";
      try {
        resolvedMusixmatchUserToken = String(
          (typeof getMusixmatchUserToken === "function"
            ? await getMusixmatchUserToken()
            : "") || "",
        ).trim();
      } catch {
        // Automatic Musixmatch token provisioning failed; other sources remain available.
      }

      const base = await fetchBestSyncedLyrics(matchTrack, {
        preferredSource,
        onProgress: handleProgressPacket,
        onSourceCached: (candidate, source) => {
          rememberSourceLyrics(
            cacheKey,
            source || candidate?.source,
            candidate,
          );
        },
        sourceCache,
        musixmatchUserToken: resolvedMusixmatchUserToken,
        refreshMusixmatchUserToken,
        spotifyWebToken: String(getSpotifyWebToken() || "").trim(),
        spotifyAccessToken: resolvedSpotifyAccessToken,
        waitForAutoCompletion: false,
      });
      initialBaseCandidate = {
        ...base,
        lyrics: Array.isArray(base.lyrics) ? base.lyrics : [],
      };
      if (!bestBasePacket?.lyrics?.length) {
        registerCandidate(initialBaseCandidate);
      } else {
        registerCandidate(initialBaseCandidate);
      }

      initialBase = bestBasePacket || initialBaseCandidate;
      emitPacket(initialBase);

      if (
        isAutoPreferredSource &&
        !hasTranslatedLines(initialBase?.lyrics || []) &&
        shouldTranslate()
      ) {
        scheduleStableSourceTranslation({
          immediate: shouldTranslate(),
        });
      }

      if (isAutoPreferredSource) {
        // ponytail: both branches resolved immediately; simplified from dead conditional
        resolveAutoTranslationReadyNow();
        await autoTranslationReadyPromise;
      }

      const MAX_POST_QUIET_RETRANSLATES = 3;
      let translationBase = bestBasePacket || initialBase;
      let translationPass = 0;
      let finalBase = {
        ...translationBase,
        lyrics: Array.isArray(translationBase?.lyrics)
          ? translationBase.lyrics
          : [],
      };

      while (translationPass <= MAX_POST_QUIET_RETRANSLATES) {
        const inputPacket = translationBase || initialBase;
        if (!shouldTranslate()) {
          finalBase = {
            ...inputPacket,
            lyrics: Array.isArray(inputPacket?.lyrics)
              ? inputPacket.lyrics
              : [],
          };
          break;
        }
        const inputSignature = getBasePacketSignature(inputPacket);
        attemptedTranslationSignatures.add(inputSignature);
        sourceChangedAfterAutoReady = false;
        emitPacket({
          ...inputPacket,
          metadata: mergeLyricsMetadata(inputPacket?.metadata, {
            translation: {
              isLoading: true,
              provider: "Gemini",
              requestedAt: Date.now(),
            },
          }),
        });

        const enrichedLyrics = await enrichLyricsWithGeminiTranslations(
          track,
          inputPacket.lyrics,
          {
            geminiApiKey: String(getGeminiApiKey() || "").trim(),
            geminiCache: geminiTranslationCache,
          },
        );

        finalBase = {
          ...inputPacket,
          lyrics: enrichedLyrics,
          metadata: mergeLyricsMetadata(inputPacket?.metadata, {
            translation: enrichedLyrics.translationMeta,
          }),
        };
        emitTranslatedPacketIfCurrentBest(finalBase);

        if (!isAutoPreferredSource) {
          break;
        }

        const latestBase = bestBasePacket || initialBase;
        const latestSignature = getBasePacketSignature(latestBase);
        const shouldRetranslate =
          latestSignature !== inputSignature || sourceChangedAfterAutoReady;
        if (!shouldRetranslate) {
          break;
        }

        translationPass += 1;
        translationBase = latestBase;
      }

      const latestBaseAtCompletion = getLatestBasePacket();
      const finalOutputBase =
        latestBaseAtCompletion?.lyrics?.length &&
        getBasePacketSignature(latestBaseAtCompletion) !==
          getBasePacketSignature(finalBase)
          ? latestBaseAtCompletion
          : finalBase;

      emitTranslatedPacketIfCurrentBest(finalOutputBase);
      const finalLyrics = Array.isArray(finalOutputBase?.lyrics)
        ? finalOutputBase.lyrics
        : [];
      const result = {
        trackId: track.trackId,
        lyrics: finalLyrics,
        source: `${finalOutputBase.source}|mobile`,
        metadata: mergeLyricsMetadata(finalOutputBase?.metadata, {
          translation: finalLyrics.translationMeta,
        }),
        statusMessage: finalLyrics.length
          ? `Loaded ${finalLyrics.length} synced lines from ${finalOutputBase.source} on mobile.`
          : finalOutputBase?.metadata?.instrumental
            ? "This song is an instrumental."
            : `No synced lyrics found (${finalOutputBase.source || "unknown reason"}).`,
      };
      lastDisplayedByTrack.set(cacheKey, result);
      if (autoTranslationTimer) {
        clearTimeout(autoTranslationTimer);
      }
      return result;
    },
    getCachedLyrics(trackId) {
      const cacheKey = String(trackId || "");
      if (!cacheKey) {
        return null;
      }
      const displayed = lastDisplayedByTrack.get(cacheKey);
      if (displayed) {
        return displayed;
      }
      const published = getPublishedLyrics(cacheKey);
      if (!published?.lyrics?.length) {
        return null;
      }
      return buildLyricsPacketFromBase({ trackId: cacheKey }, published);
    },
    clearCache() {
      lastDisplayedByTrack.clear();
      geminiTranslationCache.clear();
      publishedToFrontendCache.clear();
      activeTrackSourceCache.trackId = "";
      activeTrackSourceCache.bySource = new Map();
      clearMusixmatchRuntimeState();
      geminiRuntimeState.cooldownUntil = 0;
      geminiRuntimeState.cooldownReason = "";
      geminiRuntimeState.lastRateLimitAt = 0;
    },
    getMusixmatchRuntimeStatus,
    async saveCurrentLyricsToVault(
      track,
      lyrics,
      { includeTranslations = false, source = "", metadata = null } = {},
    ) {
      const {
        getLyricsVaultStore,
        resolveVaultSourceLabel,
      } = mobileLyricsVaultShim;
      const store = getLyricsVaultStore();
      if (!store) {
        throw new Error("Lyrics vault is not initialized.");
      }
      if (!Array.isArray(lyrics) || !lyrics.length) {
        throw new Error("No lyrics available to save.");
      }

      let lyricsToSave = cloneSourceCachePacket({ lyrics }).lyrics;
      const matchTrack = await buildLyricsMatchTrack(track, {
        spotifyAccessToken: String(
          (typeof getSpotifyAccessToken === "function"
            ? await getSpotifyAccessToken()
            : "") || "",
        ).trim(),
      });

      if (
        includeTranslations &&
        !hasTranslatedLinesInLyrics(lyricsToSave)
      ) {
        const translated = await enrichLyricsWithGeminiTranslations(
          matchTrack,
          lyricsToSave,
          {
            geminiApiKey: String(getGeminiApiKey() || "").trim(),
            geminiCache: geminiTranslationCache,
          },
        );
        lyricsToSave = Array.isArray(translated) ? translated : lyricsToSave;
      }

      const strippedSource = stripDesktopSourceSuffix(source);
      const sourceLabel = strippedSource.startsWith("local-vault-")
        ? strippedSource
        : resolveVaultSourceLabel(lyricsToSave, strippedSource);

      const saved = store.save({
        track: matchTrack,
        lyrics: lyricsToSave,
        sourceLabel,
        includeTranslations,
        originalSource: stripDesktopSourceSuffix(source),
        metadata,
      });

      rememberSourceLyrics(matchTrack.trackId, "local-vault", {
        lyrics: lyricsToSave,
        source: sourceLabel,
        metadata: saved.metadata || {},
      });

      return saved;
    },
    async importTtmlToVault(
      ttmlContent,
      track,
      { includeTranslations = false } = {},
    ) {
      const { parseTtmlToLyrics, extractTtmlMetadata } = mobileTtmlImportShim;
      const {
        getLyricsVaultStore,
        resolveVaultSourceLabel,
      } = mobileLyricsVaultShim;
      const store = getLyricsVaultStore();
      if (!store) {
        throw new Error("Lyrics vault is not initialized.");
      }

      const parsed = parseTtmlToLyrics(ttmlContent);
      if (!parsed?.lyrics?.length) {
        throw new Error("TTML file did not contain any lyric lines.");
      }

      const ttmlMeta = extractTtmlMetadata(ttmlContent);
      const mergedTrack = {
        trackId: String(track?.trackId || track?.spotifyTrackId || "").trim(),
        title: String(track?.title || ttmlMeta.title || "").trim(),
        artist: String(track?.artist || ttmlMeta.artist || "").trim(),
        album: String(track?.album || "").trim(),
        durationMs: Number(
          track?.durationMs || parsed.durationMs || 0,
        ),
        spotifyTrackId: String(track?.spotifyTrackId || "").trim(),
      };
      if (!mergedTrack.title) {
        throw new Error(
          "Could not determine song title. Play the track on Spotify or use a TTML with title metadata.",
        );
      }

      const matchTrack = await enrichTrackForVaultMatch(
        mergedTrack,
        String(
          (typeof getSpotifyAccessToken === "function"
            ? await getSpotifyAccessToken()
            : "") || "",
        ).trim(),
      );

      let lyricsToSave = cloneSourceCachePacket({ lyrics: parsed.lyrics }).lyrics;
      if (
        includeTranslations &&
        !hasTranslatedLinesInLyrics(lyricsToSave)
      ) {
        const translated = await enrichLyricsWithGeminiTranslations(
          matchTrack,
          lyricsToSave,
          {
            geminiApiKey: String(getGeminiApiKey() || "").trim(),
            geminiCache: geminiTranslationCache,
          },
        );
        lyricsToSave = Array.isArray(translated) ? translated : lyricsToSave;
      }

      const sourceLabel = resolveVaultSourceLabel(
        lyricsToSave,
        parsed.useKaraokeTiming ? "local-vault-karaoke" : "local-vault-line",
      );

      const saved = store.save({
        track: matchTrack,
        lyrics: lyricsToSave,
        sourceLabel,
        includeTranslations,
        originalSource: "ttml-import",
      });

      if (matchTrack.trackId) {
        rememberSourceLyrics(matchTrack.trackId, "local-vault", {
          lyrics: lyricsToSave,
          source: sourceLabel,
          metadata: {},
        });
      }

      return saved;
    },
    async importLyricsFileToVault(
      fileContent,
      filePath,
      track,
      { includeTranslations = false } = {},
    ) {
      const { parseLyricsImportFile } = mobileLyricsVaultShim;
      const {
        getLyricsVaultStore,
        resolveVaultSourceLabel,
      } = mobileLyricsVaultShim;
      const store = getLyricsVaultStore();
      if (!store) {
        throw new Error("Lyrics vault is not initialized.");
      }

      const parsed = parseLyricsImportFile(fileContent, filePath);
      const mergedTrack = {
        trackId: String(track?.trackId || track?.spotifyTrackId || "").trim(),
        title: String(track?.title || parsed.title || "").trim(),
        artist: String(track?.artist || parsed.artist || "").trim(),
        album: String(track?.album || parsed.album || "").trim(),
        durationMs: Number(track?.durationMs || parsed.durationMs || 0),
        spotifyTrackId: String(track?.spotifyTrackId || parsed.spotifyTrackId || "").trim(),
      };
      if (!mergedTrack.title) {
        throw new Error(
          "Could not determine song title. Play the track on Spotify or include title metadata in the file.",
        );
      }

      const matchTrack = await enrichTrackForVaultMatch(
        mergedTrack,
        String(
          (typeof getSpotifyAccessToken === "function"
            ? await getSpotifyAccessToken()
            : "") || "",
        ).trim(),
      );

      let lyricsToSave = cloneSourceCachePacket({ lyrics: parsed.lyrics }).lyrics;
      if (
        includeTranslations &&
        !hasTranslatedLinesInLyrics(lyricsToSave)
      ) {
        const translated = await enrichLyricsWithGeminiTranslations(
          matchTrack,
          lyricsToSave,
          {
            geminiApiKey: String(getGeminiApiKey() || "").trim(),
            geminiCache: geminiTranslationCache,
          },
        );
        lyricsToSave = Array.isArray(translated) ? translated : lyricsToSave;
      }

      const sourceLabel = resolveVaultSourceLabel(
        lyricsToSave,
        parsed.sourceLabel ||
          (parsed.useKaraokeTiming ? "local-vault-karaoke" : "local-vault-line"),
      );

      const saved = store.save({
        track: matchTrack,
        lyrics: lyricsToSave,
        sourceLabel,
        includeTranslations,
        originalSource: `${parsed.format}-import`,
      });

      if (matchTrack.trackId) {
        rememberSourceLyrics(matchTrack.trackId, "local-vault", {
          lyrics: lyricsToSave,
          source: sourceLabel,
          metadata: {},
        });
      }

      return saved;
    },
  };
}

export {
  createLyricsService,
  getAvailableLyricsSources,
  getTemporarilyDisabledLyricsSources,
  probeLyricsSource,
  previewQQDirectSearchCandidates,
  previewNeteaseSearchCandidates,
  previewKugouSearchCandidates,
  scoreCandidate,
  isLikelySameTrack,
  filterLikelySameTrackCandidates,
  findClearWinnerAmongTitleMatched,
  getBestArtistOverlap,
  explainTrackMatch,
  ARTIST_OVERLAP_CONFIDENT_THRESHOLD,
  CLEAR_WINNER_MIN_OVERLAP,
  CLEAR_WINNER_MIN_OVERLAP_GAP,
  buildQueryVariants,
  isAmbiguousTopMatch,
  MATCH_ACCEPTANCE_THRESHOLD,
  MATCH_CONFIDENCE_SCORE,
  featuredVariantLyricsMismatch,
  collectFeaturedArtistHints,
  extractSpicyPayloadMetadata,
  buildLyricsContentFingerprint,
  lyricsContentFingerprintsMatch,
  trackNeedsFeaturedVariantVerification,
  resolveSpotifyCatalogTrackViaPartnerSearch,
  resolveSpotifyCatalogTrackById,
  buildLyricsMatchTrack,
  mergeNativePlaybackArtist,
  applySpotifyCatalogOverlay,
};

export const normalizeLyricsSourceKey = normalizeSourceKey;
