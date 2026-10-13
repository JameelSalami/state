import { Effect } from "effect";

import type { SemanticDigest } from "./canonical.js";
import { StateRuntimeConflict, StateRuntimeValidationError } from "./errors.js";
import { makePointer, makeStateMap, recordDigest, type StateMap, type StateMapEntry, type StateMapPointer, type StateRecord } from "./model.js";
import type { StateRuntimeStore } from "./store.js";

/**
 * Opt-in optimistic rebase of disjoint consumer-owned record IDs.
 *
 * Underlying adapter CAS remains whole-store and atomic. A caller's expected
 * pointer is the base of its changes. If a touched record ID was changed by
 * another writer, we refuse rather than overwriting. Unrelated concurrent
 * changes are merged into a newly compiled full StateMap and CAS-retried.
 *
 * A conflict that occurs during commit is retried up to maxRetries, but this
 * helper never retries by discarding changes to touched IDs.
 */
export interface DisjointStateChanges {
  readonly expected: StateMapPointer | null;
  readonly records: readonly StateRecord[];
  readonly deleteIds?: readonly string[];
  readonly compiler: string;
  readonly sourceDigest: SemanticDigest;
  readonly maxRetries?: number;
}

const sameEntry = (
  left: StateMapEntry | undefined,
  right: StateMapEntry | undefined
): boolean => left === undefined
  ? right === undefined
  : right !== undefined && left.kind === right.kind && left.record === right.record;

export const commitDisjointStateChanges = (
  store: StateRuntimeStore,
  input: DisjointStateChanges
): Effect.Effect<StateMapPointer, StateRuntimeConflict | import("./store.js").StateRuntimeFailure> =>
  Effect.gen(function*() {
    const deletes = input.deleteIds ?? [];
    const touchedIds = [...input.records.map(record => record.id), ...deletes];
    if (touchedIds.length === 0 || touchedIds.some(id => !id.trim() || id === "__proto__") ||
        new Set(touchedIds).size !== touchedIds.length ||
        !Number.isSafeInteger(input.maxRetries ?? 4) ||
        (input.maxRetries ?? 4) < 0 || (input.maxRetries ?? 4) > 64) {
      return yield* Effect.fail(new StateRuntimeValidationError({
        path: "$.records/deleteIds/maxRetries",
        message: "require unique touched record IDs and 0-64 retries"
      }));
    }
    if (!input.compiler.trim() || !/^sha256:[0-9a-f]{64}$/.test(input.sourceDigest)) {
      return yield* Effect.fail(new StateRuntimeValidationError({
        path: "$.compiler/sourceDigest", message: "require compiler and valid SHA-256 source identity"
      }));
    }
    if (input.records.some(record => record.project !== store.projectId)) {
      return yield* Effect.fail(new StateRuntimeValidationError({
        path: "$.records", message: "record crosses project boundary"
      }));
    }
    const base = input.expected === null
      ? null
      : (yield* store.getMap(input.expected.map)).value;
    if (base !== null && (base.project !== store.projectId ||
        base.generation !== input.expected?.generation)) {
      return yield* Effect.fail(new StateRuntimeValidationError({
        path: "$.expected", message: "base pointer does not bind the expected immutable map"
      }));
    }

    const maxAttempts = (input.maxRetries ?? 4) + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const current = yield* store.current;
      const present = current === null ? null : (yield* store.getMap(current.map)).value;
      if (current !== null && present?.generation !== current.generation) {
        return yield* Effect.fail(new StateRuntimeValidationError({
          path: "$.current", message: "current pointer does not bind its immutable map"
        }));
      }
      if (input.expected !== null &&
          (current === null || current.generation < input.expected.generation)) {
        return yield* Effect.fail(new StateRuntimeConflict({
          expectedGeneration: input.expected.generation,
          observedGeneration: current?.generation ?? null,
          message: "base is newer than current or current was reset"
        }));
      }
      // Verify that the supplied base truly belongs to the current linear
      // history. An unrelated putMap object with matching project/generation
      // is not a valid basis for optimistic conflict detection.
      if (input.expected !== null && current !== null &&
          (current.generation !== input.expected.generation ||
           current.map !== input.expected.map)) {
        let cursor: StateMapPointer | null = current;
        while (cursor !== null && cursor.generation > input.expected.generation) {
          const historyMap: StateMap = (yield* store.getMap(cursor.map)).value;
          if (historyMap.project !== store.projectId ||
              historyMap.generation !== cursor.generation) {
            return yield* Effect.fail(new StateRuntimeValidationError({
              path: "$.current", message: "current history pointer/map mismatch"
            }));
          }
          cursor = historyMap.parent === null
            ? null
            : makePointer(store.projectId, cursor.generation - 1, historyMap.parent);
        }
        if (cursor === null || cursor.generation !== input.expected.generation ||
            cursor.map !== input.expected.map) {
          return yield* Effect.fail(new StateRuntimeConflict({
            expectedGeneration: input.expected.generation,
            observedGeneration: current.generation,
            message: "base is not an ancestor of current StateMap"
          }));
        }
      }
      for (const id of touchedIds) {
        if (!sameEntry(base?.entries[id], present?.entries[id])) {
          return yield* Effect.fail(new StateRuntimeConflict({
            expectedGeneration: input.expected?.generation ?? null,
            observedGeneration: current?.generation ?? null,
            message: "record changed since base: " + id
          }));
        }
      }
      const entries: Record<string, StateMapEntry> = { ...present?.entries };
      for (const id of deletes) delete entries[id];
      for (const record of input.records) {
        entries[record.id] = { kind: record.kind, record: recordDigest(record) };
      }
      const map = makeStateMap({
        project: store.projectId,
        generation: current === null ? 0 : current.generation + 1,
        parent: current?.map ?? null,
        compiler: input.compiler,
        sourceDigest: input.sourceDigest,
        entries
      });
      const result = yield* Effect.either(store.commit({
        expected: current, records: input.records, map
      }));
      if (result._tag === "Right") return result.right;
      if (result.left._tag !== "StateRuntimeConflict" || attempt === maxAttempts - 1) {
        return yield* Effect.fail(result.left);
      }
    }
    return yield* Effect.fail(new StateRuntimeConflict({
      expectedGeneration: input.expected?.generation ?? null,
      observedGeneration: (yield* store.current)?.generation ?? null,
      message: "exhausted disjoint-commit retries"
    }));
  });
