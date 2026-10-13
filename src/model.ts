import {
  canonicalJson,
  isSemanticDigest,
  semanticDigest,
  type JsonValue,
  type SemanticDigest
} from "./canonical.js";
import { StateRuntimeValidationError } from "./errors.js";

export const STATE_RECORD_SCHEMA = "state-runtime.record/v1" as const;
export const STATE_MAP_SCHEMA = "state-runtime.statemap/v1" as const;
export const STATE_POINTER_SCHEMA = "state-runtime.pointer/v1" as const;

export interface StateRecord {
  readonly schema: typeof STATE_RECORD_SCHEMA;
  readonly project: string;
  readonly id: string;
  readonly kind: string;
  readonly value: JsonValue;
}

export interface StateMapEntry {
  readonly kind: string;
  readonly record: SemanticDigest;
}

export interface StateMap {
  readonly schema: typeof STATE_MAP_SCHEMA;
  readonly project: string;
  readonly generation: number;
  readonly parent: SemanticDigest | null;
  readonly compiler: string;
  readonly sourceDigest: SemanticDigest;
  readonly entries: Readonly<Record<string, StateMapEntry>>;
}

export interface StateMapPointer {
  readonly schema: typeof STATE_POINTER_SCHEMA;
  readonly project: string;
  readonly generation: number;
  readonly map: SemanticDigest;
}

export interface StoredRecord {
  readonly digest: SemanticDigest;
  readonly canonicalJson: string;
  readonly value: StateRecord;
}

export interface StoredMap {
  readonly digest: SemanticDigest;
  readonly canonicalJson: string;
  readonly value: StateMap;
}

const plainObject = (
  value: unknown,
  path: string
): Record<string, unknown> => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new StateRuntimeValidationError({
      path,
      message: "must be a plain object"
    });
  }
  return value as Record<string, unknown>;
};

const exactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  path: string
): void => {
  const expected = new Set(required);
  for (const key of required) {
    if (!(key in value)) {
      throw new StateRuntimeValidationError({
        path: `${path}.${key}`,
        message: "is required"
      });
    }
  }
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new StateRuntimeValidationError({
        path: `${path}.${key}`,
        message: "is not allowed"
      });
    }
  }
};

const nonEmpty = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new StateRuntimeValidationError({
      path,
      message: "must be a non-empty string"
    });
  }
  return value;
};

const safeGeneration = (value: unknown, path: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new StateRuntimeValidationError({
      path,
      message: "must be a safe non-negative integer"
    });
  }
  return Number(value);
};

const digest = (value: unknown, path: string): SemanticDigest => {
  if (!isSemanticDigest(value)) {
    throw new StateRuntimeValidationError({
      path,
      message: "must be a SHA-256 digest"
    });
  }
  return value;
};

export const validateRecord = (value: unknown): StateRecord => {
  const record = plainObject(value, "$");
  exactKeys(record, ["schema", "project", "id", "kind", "value"], "$");
  if (record.schema !== STATE_RECORD_SCHEMA) {
    throw new StateRuntimeValidationError({
      path: "$.schema",
      message: "unsupported record schema"
    });
  }
  const checked: StateRecord = {
    schema: STATE_RECORD_SCHEMA,
    project: nonEmpty(record.project, "$.project"),
    id: nonEmpty(record.id, "$.id"),
    kind: nonEmpty(record.kind, "$.kind"),
    value: record.value as JsonValue
  };
  try {
    canonicalJson(checked.value);
  } catch (cause) {
    throw new StateRuntimeValidationError({
      path: "$.value",
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
  return checked;
};

export const validateStateMap = (value: unknown): StateMap => {
  const map = plainObject(value, "$");
  exactKeys(
    map,
    [
      "schema",
      "project",
      "generation",
      "parent",
      "compiler",
      "sourceDigest",
      "entries"
    ],
    "$"
  );
  if (map.schema !== STATE_MAP_SCHEMA) {
    throw new StateRuntimeValidationError({
      path: "$.schema",
      message: "unsupported StateMap schema"
    });
  }

  const entriesValue = plainObject(map.entries, "$.entries");
  const entries: Record<string, StateMapEntry> = {};
  for (const [id, rawEntry] of Object.entries(entriesValue)) {
    nonEmpty(id, "$.entries key");
    const entry = plainObject(rawEntry, `$.entries.${id}`);
    exactKeys(entry, ["kind", "record"], `$.entries.${id}`);
    entries[id] = {
      kind: nonEmpty(entry.kind, `$.entries.${id}.kind`),
      record: digest(entry.record, `$.entries.${id}.record`)
    };
  }

  const parent =
    map.parent === null
      ? null
      : digest(map.parent, "$.parent");

  const checked: StateMap = {
    schema: STATE_MAP_SCHEMA,
    project: nonEmpty(map.project, "$.project"),
    generation: safeGeneration(map.generation, "$.generation"),
    parent,
    compiler: nonEmpty(map.compiler, "$.compiler"),
    sourceDigest: digest(map.sourceDigest, "$.sourceDigest"),
    entries
  };
  canonicalJson(checked as unknown as JsonValue);
  return checked;
};

export const validatePointer = (value: unknown): StateMapPointer => {
  const pointer = plainObject(value, "$");
  exactKeys(pointer, ["schema", "project", "generation", "map"], "$");
  if (pointer.schema !== STATE_POINTER_SCHEMA) {
    throw new StateRuntimeValidationError({
      path: "$.schema",
      message: "unsupported pointer schema"
    });
  }
  return {
    schema: STATE_POINTER_SCHEMA,
    project: nonEmpty(pointer.project, "$.project"),
    generation: safeGeneration(pointer.generation, "$.generation"),
    map: digest(pointer.map, "$.map")
  };
};

export const recordDigest = (record: StateRecord): SemanticDigest =>
  semanticDigest(validateRecord(record) as unknown as JsonValue);

export const mapDigest = (map: StateMap): SemanticDigest =>
  semanticDigest(validateStateMap(map) as unknown as JsonValue);

export const makeRecord = (
  project: string,
  id: string,
  kind: string,
  value: JsonValue
): StateRecord =>
  validateRecord({
    schema: STATE_RECORD_SCHEMA,
    project,
    id,
    kind,
    value
  });

export const makeStateMap = (input: Omit<StateMap, "schema">): StateMap =>
  validateStateMap({ schema: STATE_MAP_SCHEMA, ...input });

export const makePointer = (
  project: string,
  generation: number,
  map: SemanticDigest
): StateMapPointer =>
  validatePointer({
    schema: STATE_POINTER_SCHEMA,
    project,
    generation,
    map
  });
