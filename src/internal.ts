import type { JsonValue, SemanticDigest } from "./canonical.js";
import { canonicalJson, isSemanticDigest, semanticDigest } from "./canonical.js";
import { StateRuntimeCorrupt, StateRuntimeValidationError } from "./errors.js";
import {
  STATE_MAP_SCHEMA,
  STATE_POINTER_SCHEMA,
  STATE_RECORD_SCHEMA,
  makePointer,
  type StateMap,
  type StateMapEntry,
  type StateMapPointer,
  type StateRecord,
  type StoredMap,
  type StoredRecord,
  validatePointer,
  validateRecord,
  validateStateMap
} from "./model.js";

export const encodeRecord = (record: StateRecord): StoredRecord => {
  const value = validateRecord(record);
  const text = canonicalJson(value as unknown as JsonValue);
  return { digest: semanticDigest(value as unknown as JsonValue), canonicalJson: text, value };
};

export const encodeMap = (map: StateMap): StoredMap => {
  const value = validateStateMap(map);
  const text = canonicalJson(value as unknown as JsonValue);
  return { digest: semanticDigest(value as unknown as JsonValue), canonicalJson: text, value };
};

export const decodeRecord = (
  digest: SemanticDigest,
  text: string,
  projectId: string
): StoredRecord => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new StateRuntimeCorrupt({ digest, message: `invalid record JSON: ${String(cause)}` });
  }
  if (typeof value !== "object" || value === null || (value as { schema?: unknown }).schema !== STATE_RECORD_SCHEMA) {
    throw new StateRuntimeCorrupt({ digest, message: "invalid record envelope" });
  }
  const record = validateRecord(value as StateRecord);
  if (record.project !== projectId) {
    throw new StateRuntimeCorrupt({ digest, message: "record belongs to another project" });
  }
  const observed = semanticDigest(record as unknown as JsonValue);
  if (observed !== digest || canonicalJson(record as unknown as JsonValue) !== text) {
    throw new StateRuntimeCorrupt({ digest, message: "record digest/canonical bytes mismatch" });
  }
  return { digest, canonicalJson: text, value: record };
};

export const decodeMap = (
  digest: SemanticDigest,
  text: string,
  projectId: string
): StoredMap => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new StateRuntimeCorrupt({ digest, message: `invalid StateMap JSON: ${String(cause)}` });
  }
  if (typeof value !== "object" || value === null || (value as { schema?: unknown }).schema !== STATE_MAP_SCHEMA) {
    throw new StateRuntimeCorrupt({ digest, message: "invalid StateMap envelope" });
  }
  const map = validateStateMap(value as StateMap);
  if (map.project !== projectId) {
    throw new StateRuntimeCorrupt({ digest, message: "StateMap belongs to another project" });
  }
  const observed = semanticDigest(map as unknown as JsonValue);
  if (observed !== digest || canonicalJson(map as unknown as JsonValue) !== text) {
    throw new StateRuntimeCorrupt({ digest, message: "StateMap digest/canonical bytes mismatch" });
  }
  return { digest, canonicalJson: text, value: map };
};

export const decodePointer = (
  text: string,
  projectId: string
): StateMapPointer => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new StateRuntimeCorrupt({ message: `invalid pointer JSON: ${String(cause)}` });
  }
  if (typeof value !== "object" || value === null || (value as { schema?: unknown }).schema !== STATE_POINTER_SCHEMA) {
    throw new StateRuntimeCorrupt({ message: "invalid StateMap pointer" });
  }
  const pointer = validatePointer(value as StateMapPointer);
  if (pointer.project !== projectId) {
    throw new StateRuntimeCorrupt({ message: "StateMap pointer belongs to another project" });
  }
  return pointer;
};

export const assertProject = (expected: string, observed: string, path: string): void => {
  if (observed !== expected) {
    throw new StateRuntimeValidationError({
      path,
      message: `expected project ${expected}, observed ${observed}`
    });
  }
};

export const assertDigest = (value: string, path: string): SemanticDigest => {
  if (!isSemanticDigest(value)) {
    throw new StateRuntimeCorrupt({ message: `${path}: invalid digest` });
  }
  return value;
};

export const samePointer = (
  left: StateMapPointer | null,
  right: StateMapPointer | null
): boolean =>
  left === null
    ? right === null
    : right !== null &&
      left.project === right.project &&
      left.generation === right.generation &&
      left.map === right.map;

export interface IntegritySource {
  readonly getMapText: (digest: SemanticDigest) => string | undefined;
  readonly getRecordText: (digest: SemanticDigest) => string | undefined;
}

export interface IntegritySummary {
  readonly generation: number;
  readonly map: SemanticDigest;
  readonly entries: number;
  readonly maps: number;
  readonly records: number;
}

const boundMap = (
  projectId: string,
  pointer: StateMapPointer,
  source: IntegritySource,
  label: string
): StateMap => {
  const checked = validatePointer(pointer);
  if (checked.project !== projectId) {
    throw new StateRuntimeCorrupt({
      digest: checked.map,
      message: `${label} pointer belongs to another project`
    });
  }
  const text = source.getMapText(checked.map);
  if (text === undefined) {
    throw new StateRuntimeCorrupt({
      digest: checked.map,
      message: `${label} pointer references missing StateMap`
    });
  }
  const map = decodeMap(checked.map, text, projectId).value;
  if (map.generation !== checked.generation) {
    throw new StateRuntimeCorrupt({
      digest: checked.map,
      message: `${label} pointer/StateMap generation mismatch`
    });
  }
  return map;
};

export const assertAdvanceTransition = (
  projectId: string,
  expected: StateMapPointer | null,
  next: StateMapPointer,
  source: IntegritySource
): StateMap => {
  const checkedNext = validatePointer(next);
  assertProject(projectId, checkedNext.project, "$.next.project");
  const nextMap = boundMap(projectId, checkedNext, source, "next");

  if (expected === null) {
    if (checkedNext.generation !== 0 || nextMap.parent !== null) {
      throw new StateRuntimeCorrupt({
        digest: checkedNext.map,
        message: "ordinary empty-store advancement must install generation 0 with null parent"
      });
    }
    return nextMap;
  }

  const checkedExpected = validatePointer(expected);
  assertProject(projectId, checkedExpected.project, "$.expected.project");
  boundMap(projectId, checkedExpected, source, "expected");

  if (checkedNext.generation !== checkedExpected.generation + 1) {
    throw new StateRuntimeCorrupt({
      digest: checkedNext.map,
      message: "ordinary advancement must increase generation by exactly one"
    });
  }
  if (nextMap.parent !== checkedExpected.map) {
    throw new StateRuntimeCorrupt({
      digest: checkedNext.map,
      message: "ordinary advancement StateMap parent must equal expected current map"
    });
  }
  return nextMap;
};

const verifyEntry = (
  projectId: string,
  id: string,
  entry: StateMapEntry,
  source: IntegritySource
): StoredRecord => {
  const text = source.getRecordText(entry.record);
  if (text === undefined) {
    throw new StateRuntimeCorrupt({
      digest: entry.record,
      message: `${id}: record missing`
    });
  }
  const record = decodeRecord(entry.record, text, projectId);
  if (record.value.id !== id || record.value.kind !== entry.kind) {
    throw new StateRuntimeCorrupt({
      digest: entry.record,
      message: `${id}: record identity mismatch`
    });
  }
  return record;
};

export const verifyCurrentState = (
  projectId: string,
  current: StateMapPointer | null,
  source: IntegritySource
): IntegritySummary => {
  if (current === null) {
    throw new StateRuntimeCorrupt({ message: "StateMap current pointer is missing" });
  }
  const map = boundMap(projectId, current, source, "current");
  const records = new Set<SemanticDigest>();
  for (const [id, entry] of Object.entries(map.entries)) {
    verifyEntry(projectId, id, entry, source);
    records.add(entry.record);
  }
  return {
    generation: map.generation,
    map: current.map,
    entries: Object.keys(map.entries).length,
    maps: 1,
    records: records.size
  };
};

export const verifyHistoryState = (
  projectId: string,
  current: StateMapPointer | null,
  source: IntegritySource
): IntegritySummary => {
  if (current === null) {
    throw new StateRuntimeCorrupt({ message: "StateMap current pointer is missing" });
  }

  const seenMaps = new Set<SemanticDigest>();
  const seenRecords = new Set<SemanticDigest>();
  let pointer: StateMapPointer | null = current;
  let headEntries = 0;
  let maps = 0;

  while (pointer !== null) {
    if (seenMaps.has(pointer.map)) {
      throw new StateRuntimeCorrupt({
        digest: pointer.map,
        message: "StateMap history cycle detected"
      });
    }
    seenMaps.add(pointer.map);

    const map = boundMap(projectId, pointer, source, maps === 0 ? "current" : "history");
    if (maps === 0) headEntries = Object.keys(map.entries).length;

    for (const [id, entry] of Object.entries(map.entries)) {
      verifyEntry(projectId, id, entry, source);
      seenRecords.add(entry.record);
    }

    maps += 1;
    if (map.generation === 0) {
      if (map.parent !== null) {
        throw new StateRuntimeCorrupt({
          digest: pointer.map,
          message: "generation 0 StateMap must have null parent"
        });
      }
      pointer = null;
      continue;
    }

    if (map.parent === null) {
      throw new StateRuntimeCorrupt({
        digest: pointer.map,
        message: "non-zero StateMap generation is missing its parent"
      });
    }
    pointer = makePointer(projectId, map.generation - 1, map.parent);
  }

  return {
    generation: current.generation,
    map: current.map,
    entries: headEntries,
    maps,
    records: seenRecords.size
  };
};

export const getLatestEntryState = (
  projectId: string,
  current: StateMapPointer | null,
  id: string,
  source: IntegritySource
): {
  readonly pointer: StateMapPointer;
  readonly id: string;
  readonly kind: string;
  readonly record: StoredRecord;
} | null => {
  let pointer = current;
  const seen = new Set<SemanticDigest>();
  while (pointer !== null) {
    if (seen.has(pointer.map)) {
      throw new StateRuntimeCorrupt({
        digest: pointer.map,
        message: "StateMap history cycle detected"
      });
    }
    seen.add(pointer.map);
    const map = boundMap(projectId, pointer, source, "history");
    const entry = map.entries[id];
    if (entry !== undefined) {
      const record = verifyEntry(projectId, id, entry, source);
      return { pointer: { ...pointer }, id, kind: entry.kind, record };
    }
    if (map.generation === 0) {
      if (map.parent !== null) {
        throw new StateRuntimeCorrupt({
          digest: pointer.map,
          message: "generation 0 StateMap must have null parent"
        });
      }
      return null;
    }
    if (map.parent === null) {
      throw new StateRuntimeCorrupt({
        digest: pointer.map,
        message: "non-zero StateMap generation is missing its parent"
      });
    }
    pointer = makePointer(projectId, map.generation - 1, map.parent);
  }
  return null;
};

export const getCurrentEntryState = (
  projectId: string,
  current: StateMapPointer | null,
  id: string,
  source: IntegritySource
): {
  readonly pointer: StateMapPointer;
  readonly id: string;
  readonly kind: string;
  readonly record: StoredRecord;
} | null => {
  if (current === null) return null;
  const map = boundMap(projectId, current, source, "current");
  const entry = map.entries[id];
  if (entry === undefined) return null;
  const record = verifyEntry(projectId, id, entry, source);
  return {
    pointer: { ...current },
    id,
    kind: entry.kind,
    record
  };
};
