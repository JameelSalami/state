import { Effect } from "effect";

import {
  canonicalJson,
  semanticDigest,
  type JsonValue,
  type SemanticDigest
} from "./canonical.js";
import {
  StateRuntimeConflict,
  StateRuntimeCorrupt,
  StateRuntimeValidationError
} from "./errors.js";
import {
  makePointer,
  type StateMap,
  type StateMapEntry,
  type StateMapPointer,
  type StateRecord,
  type StoredMap,
  validatePointer,
  validateRecord,
  validateStateMap
} from "./model.js";
import type {
  StateRuntimeFailure,
  StateRuntimeStore
} from "./store.js";

export const STATE_RUNTIME_SNAPSHOT_SCHEMA = "state-runtime.snapshot/v1" as const;

export interface SnapshotRecord {
  readonly digest: SemanticDigest;
  readonly canonicalJson: string;
}

export interface SnapshotMap {
  readonly digest: SemanticDigest;
  readonly canonicalJson: string;
}

export interface StateRuntimeSnapshotPayload {
  readonly current: StateMapPointer | null;
  readonly records: readonly SnapshotRecord[];
  readonly maps: readonly SnapshotMap[];
}

export interface StateRuntimeSnapshot {
  readonly schema: typeof STATE_RUNTIME_SNAPSHOT_SCHEMA;
  readonly project: string;
  readonly payload: StateRuntimeSnapshotPayload;
  readonly payloadDigest: SemanticDigest;
}

export type StateRuntimeSnapshotFailure =
  | StateRuntimeFailure
  | StateRuntimeConflict;

const normalizedPayload = (
  payload: StateRuntimeSnapshotPayload
): StateRuntimeSnapshotPayload => ({
  current: payload.current === null ? null : { ...payload.current },
  records: [...payload.records]
    .map((record) => ({ ...record }))
    .sort((left, right) => left.digest.localeCompare(right.digest)),
  maps: [...payload.maps]
    .map((map) => ({ ...map }))
    .sort((left, right) => left.digest.localeCompare(right.digest))
});

const digestPayload = (
  payload: StateRuntimeSnapshotPayload
): SemanticDigest =>
  semanticDigest(normalizedPayload(payload) as unknown as JsonValue);

const decodeRecord = (record: SnapshotRecord): StateRecord => {
  let value: unknown;
  try {
    value = JSON.parse(record.canonicalJson);
  } catch (cause) {
    throw new StateRuntimeCorrupt({
      digest: record.digest,
      message: `snapshot record JSON is invalid: ${cause instanceof Error ? cause.message : String(cause)}`
    });
  }
  const decoded = validateRecord(value as StateRecord);
  const canonical = canonicalJson(decoded as unknown as JsonValue);
  if (
    canonical !== record.canonicalJson ||
    semanticDigest(decoded as unknown as JsonValue) !== record.digest
  ) {
    throw new StateRuntimeCorrupt({
      digest: record.digest,
      message: "snapshot record digest/canonical bytes mismatch"
    });
  }
  return decoded;
};

const decodeMap = (map: SnapshotMap): StateMap => {
  let value: unknown;
  try {
    value = JSON.parse(map.canonicalJson);
  } catch (cause) {
    throw new StateRuntimeCorrupt({
      digest: map.digest,
      message: `snapshot StateMap JSON is invalid: ${cause instanceof Error ? cause.message : String(cause)}`
    });
  }
  const decoded = validateStateMap(value as StateMap);
  const canonical = canonicalJson(decoded as unknown as JsonValue);
  if (
    canonical !== map.canonicalJson ||
    semanticDigest(decoded as unknown as JsonValue) !== map.digest
  ) {
    throw new StateRuntimeCorrupt({
      digest: map.digest,
      message: "snapshot StateMap digest/canonical bytes mismatch"
    });
  }
  return decoded;
};

const validateSnapshot = (
  snapshot: StateRuntimeSnapshot,
  projectId: string
): {
  readonly current: StateMapPointer | null;
  readonly records: readonly StateRecord[];
  readonly maps: readonly StateMap[];
} => {
  if (snapshot.schema !== STATE_RUNTIME_SNAPSHOT_SCHEMA) {
    throw new StateRuntimeValidationError({
      path: "$.schema",
      message: "unsupported snapshot schema"
    });
  }
  if (snapshot.project !== projectId) {
    throw new StateRuntimeValidationError({
      path: "$.project",
      message: `snapshot belongs to ${snapshot.project}, expected ${projectId}`
    });
  }

  const normalized = normalizedPayload(snapshot.payload);
  if (digestPayload(normalized) !== snapshot.payloadDigest) {
    throw new StateRuntimeCorrupt({
      digest: snapshot.payloadDigest,
      message: "snapshot payload digest mismatch"
    });
  }

  const recordsByDigest = new Map<SemanticDigest, StateRecord>();
  for (const encoded of normalized.records) {
    if (recordsByDigest.has(encoded.digest)) {
      throw new StateRuntimeCorrupt({
        digest: encoded.digest,
        message: "snapshot contains duplicate record digest"
      });
    }
    const record = decodeRecord(encoded);
    if (record.project !== projectId) {
      throw new StateRuntimeCorrupt({
        digest: encoded.digest,
        message: "snapshot record crosses project boundary"
      });
    }
    recordsByDigest.set(encoded.digest, record);
  }

  const mapsByDigest = new Map<SemanticDigest, StateMap>();
  for (const encoded of normalized.maps) {
    if (mapsByDigest.has(encoded.digest)) {
      throw new StateRuntimeCorrupt({
        digest: encoded.digest,
        message: "snapshot contains duplicate StateMap digest"
      });
    }
    const map = decodeMap(encoded);
    if (map.project !== projectId) {
      throw new StateRuntimeCorrupt({
        digest: encoded.digest,
        message: "snapshot StateMap crosses project boundary"
      });
    }
    mapsByDigest.set(encoded.digest, map);
  }

  for (const [digest, map] of mapsByDigest) {
    for (const [id, entry] of Object.entries(map.entries)) {
      const record = recordsByDigest.get(entry.record);
      if (record === undefined) {
        throw new StateRuntimeCorrupt({
          digest: entry.record,
          message: "snapshot StateMap references a missing record"
        });
      }
      if (record.id !== id || record.kind !== entry.kind) {
        throw new StateRuntimeCorrupt({
          digest: entry.record,
          message: `${id}: snapshot record identity mismatch`
        });
      }
    }

    if (map.generation === 0) {
      if (map.parent !== null) {
        throw new StateRuntimeCorrupt({
          digest,
          message: "snapshot generation 0 StateMap must have null parent"
        });
      }
      continue;
    }

    if (map.parent === null) {
      throw new StateRuntimeCorrupt({
        digest,
        message: "snapshot non-zero StateMap is missing its parent"
      });
    }
    const parent = mapsByDigest.get(map.parent);
    if (parent === undefined) {
      throw new StateRuntimeCorrupt({
        digest: map.parent,
        message: "snapshot StateMap history is incomplete"
      });
    }
    if (parent.generation !== map.generation - 1) {
      throw new StateRuntimeCorrupt({
        digest: map.parent,
        message: "snapshot StateMap generations are not continuous"
      });
    }
  }

  const current =
    normalized.current === null ? null : validatePointer(normalized.current);

  if (
    current === null &&
    (mapsByDigest.size !== 0 || recordsByDigest.size !== 0)
  ) {
    throw new StateRuntimeCorrupt({
      message: "empty snapshot current cannot carry immutable payload"
    });
  }

  if (current !== null) {
    if (current.project !== projectId) {
      throw new StateRuntimeCorrupt({
        digest: current.map,
        message: "snapshot current pointer crosses project boundary"
      });
    }
    const head = mapsByDigest.get(current.map);
    if (head === undefined) {
      throw new StateRuntimeCorrupt({
        digest: current.map,
        message: "snapshot current pointer references a missing StateMap"
      });
    }
    if (head.generation !== current.generation) {
      throw new StateRuntimeCorrupt({
        digest: current.map,
        message: "snapshot current pointer/StateMap generation mismatch"
      });
    }

    let pointer: StateMapPointer | null = current;
    const seen = new Set<SemanticDigest>();
    const reachableRecords = new Set<SemanticDigest>();
    while (pointer !== null) {
      if (seen.has(pointer.map)) {
        throw new StateRuntimeCorrupt({
          digest: pointer.map,
          message: "snapshot StateMap history cycle detected"
        });
      }
      seen.add(pointer.map);
      const map = mapsByDigest.get(pointer.map);
      if (map === undefined || map.generation !== pointer.generation) {
        throw new StateRuntimeCorrupt({
          digest: pointer.map,
          message: "snapshot reachable history binding mismatch"
        });
      }
      for (const entry of Object.values(map.entries)) {
        reachableRecords.add(entry.record);
      }
      pointer =
        map.parent === null
          ? null
          : makePointer(projectId, map.generation - 1, map.parent);
    }

    if (seen.size !== mapsByDigest.size) {
      const orphan = [...mapsByDigest.keys()].find((digest) => !seen.has(digest));
      throw new StateRuntimeCorrupt({
        ...(orphan === undefined ? {} : { digest: orphan }),
        message: "snapshot contains unreachable StateMap"
      });
    }

    if (reachableRecords.size !== recordsByDigest.size) {
      const orphan = [...recordsByDigest.keys()].find(
        (digest) => !reachableRecords.has(digest)
      );
      throw new StateRuntimeCorrupt({
        ...(orphan === undefined ? {} : { digest: orphan }),
        message: "snapshot contains unreachable record"
      });
    }
  }

  return {
    current,
    records: normalized.records.map((record) => recordsByDigest.get(record.digest)!),
    maps: normalized.maps.map((map) => mapsByDigest.get(map.digest)!)
  };
};

export const exportStateRuntimeSnapshot = (
  store: StateRuntimeStore
): Effect.Effect<StateRuntimeSnapshot, StateRuntimeFailure> =>
  Effect.gen(function*() {
    const current = yield* store.current;
    if (current === null) {
      const payload = normalizedPayload({
        current: null,
        records: [],
        maps: []
      });
      return {
        schema: STATE_RUNTIME_SNAPSHOT_SCHEMA,
        project: store.projectId,
        payload,
        payloadDigest: digestPayload(payload)
      };
    }

    yield* store.verifyHistory;

    const maps = new Map<SemanticDigest, SnapshotMap>();
    const records = new Map<SemanticDigest, SnapshotRecord>();
    let pointer: StateMapPointer | null = current;

    while (pointer !== null) {
      const storedMap: StoredMap = yield* store.getMap(pointer.map);
      maps.set(storedMap.digest, {
        digest: storedMap.digest,
        canonicalJson: storedMap.canonicalJson
      });

      for (const entry of Object.values(storedMap.value.entries) as StateMapEntry[]) {
        if (!records.has(entry.record)) {
          const record = yield* store.getRecord(entry.record);
          records.set(record.digest, {
            digest: record.digest,
            canonicalJson: record.canonicalJson
          });
        }
      }

      pointer = storedMap.value.parent === null
        ? null
        : makePointer(
            store.projectId,
            storedMap.value.generation - 1,
            storedMap.value.parent
          );
    }

    const payload = normalizedPayload({
      current,
      records: [...records.values()],
      maps: [...maps.values()]
    });

    return {
      schema: STATE_RUNTIME_SNAPSHOT_SCHEMA,
      project: store.projectId,
      payload,
      payloadDigest: digestPayload(payload)
    };
  });

export const restoreStateRuntimeSnapshotToEmpty = (
  store: StateRuntimeStore,
  snapshot: StateRuntimeSnapshot
): Effect.Effect<StateMapPointer | null, StateRuntimeSnapshotFailure> =>
  Effect.gen(function*() {
    const observed = yield* store.current;
    if (observed !== null) {
      return yield* Effect.fail(
        new StateRuntimeConflict({
          expectedGeneration: null,
          observedGeneration: observed.generation,
          message: "snapshot restore requires an empty target store"
        })
      );
    }

    const validated = yield* Effect.try({
      try: () => validateSnapshot(snapshot, store.projectId),
      catch: (cause) =>
        cause instanceof StateRuntimeValidationError ||
        cause instanceof StateRuntimeCorrupt
          ? cause
          : new StateRuntimeCorrupt({
              message: cause instanceof Error ? cause.message : String(cause)
            })
    });

    for (const record of validated.records) {
      yield* store.putRecord(record);
    }
    for (const map of [...validated.maps].sort(
      (left, right) => left.generation - right.generation
    )) {
      yield* store.putMap(map);
    }

    if (validated.current === null) return null;

    yield* store.installVerifiedHistory(validated.current);
    yield* store.verifyHistory;
    return validated.current;
  });
