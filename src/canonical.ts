import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type SemanticDigest = `sha256:${string}`;

const assertUnicode = (value: string, path: string): void => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    let codePoint: number;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error(`${path}: lone high surrogate is not canonical JSON`);
      }
      codePoint =
        0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`${path}: lone low surrogate is not canonical JSON`);
    } else {
      codePoint = code;
    }

    if (
      (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
      (codePoint & 0xffff) === 0xfffe ||
      (codePoint & 0xffff) === 0xffff
    ) {
      throw new Error(`${path}: Unicode noncharacter is not canonical JSON`);
    }
  }
};

const canonicalize = (
  value: unknown,
  path: string,
  ancestors: Set<object>
): string => {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    assertUnicode(value, path);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${path}: non-finite numbers are not canonical JSON`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new Error(`${path}: cyclic JSON value is not canonical JSON`);
    }
    ancestors.add(value);
    try {
      const items: string[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) {
          throw new Error(
            `${path}[${index}]: sparse arrays are not canonical JSON`
          );
        }
        items.push(
          canonicalize(value[index], `${path}[${index}]`, ancestors)
        );
      }
      return `[${items.join(",")}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value !== "object") {
    throw new Error(`${path}: unsupported JSON value`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path}: JSON objects must be plain objects`);
  }
  if (ancestors.has(value)) {
    throw new Error(`${path}: cyclic JSON value is not canonical JSON`);
  }

  ancestors.add(value);
  try {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    for (const key of keys) assertUnicode(key, `${path} property name`);
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalize(
            object[key],
            `${path}.${key}`,
            ancestors
          )}`,
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
};

export const canonicalJson = (value: JsonValue): string =>
  canonicalize(value, "$", new Set());

export const semanticDigest = (value: JsonValue): SemanticDigest =>
  `sha256:${bytesToHex(sha256(utf8ToBytes(canonicalJson(value))))}`;

export const isSemanticDigest = (value: unknown): value is SemanticDigest =>
  typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);