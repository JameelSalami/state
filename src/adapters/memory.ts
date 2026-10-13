import { Effect, Ref } from "effect";

import type { SemanticDigest } from "../canonical.js";
import {
  StateRuntimeConflict,
  StateRuntimeCorrupt,
  StateRuntimeValidationError
} from "../errors.js";
import {
  makePointer,
  type StateMap,
  type StateMapPointer,
  type StateRecord
} from "../model.js";
import type {
  StateRuntimeCommit,
  StateRuntimeHealth,
  StateRuntimeStore,
  StateRuntimeVerification
} from "../store.js";
import {
  assertAdvanceTransition,
  assertProject,
  decodeMap,
  decodeRecord,
  encodeMap,
  encodeRecord,
  getCurrentEntryState,
  getLatestEntryState,
  samePointer,
  verifyCurrentState,
  verifyHistoryState,
  type IntegritySource
} from "../internal.js";

interface MemoryState {
  readonly records: ReadonlyMap<SemanticDigest, string>;
  readonly maps: ReadonlyMap<SemanticDigest, string>;
  readonly current: StateMapPointer | null;
}

const asFailure = (cause: unknown): StateRuntimeCorrupt | StateRuntimeValidationError =>
  cause instanceof StateRuntimeCorrupt || cause instanceof StateRuntimeValidationError
    ? cause
    : new StateRuntimeCorrupt({ message: cause instanceof Error ? cause.message : String(cause) });

type MutationFailure = StateRuntimeCorrupt | StateRuntimeValidationError;

type MutationResult<A> =
  | { readonly _tag: "Ok"; readonly value: A }
  | { readonly _tag: "Failure"; readonly error: MutationFailure };

type CasMutationResult<A> =
  | MutationResult<A>
  | { readonly _tag: "Conflict"; readonly error: StateRuntimeConflict };

const sourceFor = (state: MemoryState): IntegritySource => ({
  getMapText: (digest) => state.maps.get(digest),
  getRecordText: (digest) => state.records.get(digest)
});

const health = (
  projectId: string,
  mechanism: string,
  scope: "current" | "history",
  summary: ReturnType<typeof verifyCurrentState>
): StateRuntimeVerification => ({
  state: "Healthy",
  scope,
  project: projectId,
  generation: summary.generation,
  map: summary.map,
  entries: summary.entries,
  maps: summary.maps,
  records: summary.records,
  mechanism
});

const legacyHealth = (
  verification: StateRuntimeVerification
): StateRuntimeHealth => ({
  state: verification.state,
  project: verification.project,
  generation: verification.generation,
  map: verification.map,
  entries: verification.entries,
  mechanism: verification.mechanism
});


export const makeMemoryStateStore = (
  projectId: string
): Effect.Effect<StateRuntimeStore> =>
  Effect.gen(function*() {
    const state = yield* Ref.make<MemoryState>({
      records: new Map(),
      maps: new Map(),
      current: null
    });

    const verifyCurrent = Ref.get(state).pipe(
      Effect.flatMap((current) =>
        Effect.try({
          try: () =>
            health(
              projectId,
              "memory",
              "current",
              verifyCurrentState(projectId, current.current, sourceFor(current))
            ),
          catch: asFailure
        })
      )
    );

    const verifyHistory = Ref.get(state).pipe(
      Effect.flatMap((current) =>
        Effect.try({
          try: () =>
            health(
              projectId,
              "memory",
              "history",
              verifyHistoryState(projectId, current.current, sourceFor(current))
            ),
          catch: asFailure
        })
      )
    );

    const store: StateRuntimeStore = {
      projectId,
      mechanismId: "memory",

      putRecord: (record: StateRecord) =>
        Effect.gen(function*() {
          const stored = yield* Effect.try({
            try: () => {
              assertProject(projectId, record.project, "$.project");
              return encodeRecord(record);
            },
            catch: asFailure
          });
          const result = yield* Ref.modify(state, (current): readonly [MutationResult<SemanticDigest>, MemoryState] => {
            const existing = current.records.get(stored.digest);
            if (existing !== undefined && existing !== stored.canonicalJson) {
              return [
                {
                  _tag: "Failure",
                  error: new StateRuntimeCorrupt({
                    digest: stored.digest,
                    message: "content-addressed record collision"
                  })
                },
                current
              ];
            }
            const records = new Map(current.records);
            records.set(stored.digest, stored.canonicalJson);
            return [{ _tag: "Ok", value: stored.digest }, { ...current, records }];
          });
          return result._tag === "Ok"
            ? result.value
            : yield* Effect.fail(result.error);
        }),

      getRecord: (digest) =>
        Ref.get(state).pipe(
          Effect.flatMap((current) => {
            const text = current.records.get(digest);
            if (text === undefined) {
              return Effect.fail(new StateRuntimeCorrupt({ digest, message: "record not found" }));
            }
            return Effect.try({
              try: () => decodeRecord(digest, text, projectId),
              catch: asFailure
            });
          })
        ),

      putMap: (map: StateMap) =>
        Effect.gen(function*() {
          const stored = yield* Effect.try({
            try: () => {
              assertProject(projectId, map.project, "$.project");
              return encodeMap(map);
            },
            catch: asFailure
          });
          const result = yield* Ref.modify(state, (current): readonly [MutationResult<SemanticDigest>, MemoryState] => {
            const existing = current.maps.get(stored.digest);
            if (existing !== undefined && existing !== stored.canonicalJson) {
              return [
                {
                  _tag: "Failure",
                  error: new StateRuntimeCorrupt({
                    digest: stored.digest,
                    message: "content-addressed StateMap collision"
                  })
                },
                current
              ];
            }
            const maps = new Map(current.maps);
            maps.set(stored.digest, stored.canonicalJson);
            return [{ _tag: "Ok", value: stored.digest }, { ...current, maps }];
          });
          return result._tag === "Ok"
            ? result.value
            : yield* Effect.fail(result.error);
        }),

      getMap: (digest) =>
        Ref.get(state).pipe(
          Effect.flatMap((current) => {
            const text = current.maps.get(digest);
            if (text === undefined) {
              return Effect.fail(new StateRuntimeCorrupt({ digest, message: "StateMap not found" }));
            }
            return Effect.try({
              try: () => decodeMap(digest, text, projectId),
              catch: asFailure
            });
          })
        ),

      current: Ref.get(state).pipe(Effect.map((current) => current.current)),

      getCurrentEntry: (id) =>
        Ref.get(state).pipe(
          Effect.flatMap((current) =>
            Effect.try({
              try: () =>
                getCurrentEntryState(
                  projectId,
                  current.current,
                  id,
                  sourceFor(current)
                ),
              catch: asFailure
            })
          )
        ),

      getLatestEntry: (id) =>
        Ref.get(state).pipe(
          Effect.flatMap((current) =>
            Effect.try({
              try: () =>
                getLatestEntryState(
                  projectId,
                  current.current,
                  id,
                  sourceFor(current)
                ),
              catch: asFailure
            })
          )
        ),

      compareAndSwapCurrent: (expected, next) =>
        Effect.gen(function*() {
          const result = yield* Ref.modify(state, (current): readonly [CasMutationResult<void>, MemoryState] => {
            if (!samePointer(expected, current.current)) {
              return [
                {
                  _tag: "Conflict",
                  error: new StateRuntimeConflict({
                    expectedGeneration: expected?.generation ?? null,
                    observedGeneration: current.current?.generation ?? null,
                    message: "StateMap current pointer changed"
                  })
                },
                current
              ];
            }
            try {
              assertAdvanceTransition(projectId, expected, next, sourceFor(current));
              verifyCurrentState(projectId, next, sourceFor(current));
              return [{ _tag: "Ok", value: undefined }, { ...current, current: { ...next } }];
            } catch (cause) {
              return [{ _tag: "Failure", error: asFailure(cause) }, current];
            }
          });
          if (result._tag !== "Ok") return yield* Effect.fail(result.error);
        }),

      commit: (input: StateRuntimeCommit) =>
        Effect.gen(function*() {
          const result = yield* Ref.modify(state, (current): readonly [CasMutationResult<StateMapPointer>, MemoryState] => {
            if (!samePointer(input.expected, current.current)) {
              return [
                {
                  _tag: "Conflict",
                  error: new StateRuntimeConflict({
                    expectedGeneration: input.expected?.generation ?? null,
                    observedGeneration: current.current?.generation ?? null,
                    message: "StateMap current pointer changed"
                  })
                },
                current
              ];
            }

            try {
              const records = new Map(current.records);
              for (const record of input.records) {
                assertProject(projectId, record.project, "$.records[].project");
                const stored = encodeRecord(record);
                const existing = records.get(stored.digest);
                if (existing !== undefined && existing !== stored.canonicalJson) {
                  throw new StateRuntimeCorrupt({
                    digest: stored.digest,
                    message: "content-addressed record collision"
                  });
                }
                records.set(stored.digest, stored.canonicalJson);
              }

              assertProject(projectId, input.map.project, "$.map.project");
              const storedMap = encodeMap(input.map);
              const maps = new Map(current.maps);
              const existingMap = maps.get(storedMap.digest);
              if (existingMap !== undefined && existingMap !== storedMap.canonicalJson) {
                throw new StateRuntimeCorrupt({
                  digest: storedMap.digest,
                  message: "content-addressed StateMap collision"
                });
              }
              maps.set(storedMap.digest, storedMap.canonicalJson);

              const candidate: MemoryState = { records, maps, current: current.current };
              const next = makePointer(projectId, input.map.generation, storedMap.digest);
              assertAdvanceTransition(projectId, input.expected, next, sourceFor(candidate));
              verifyCurrentState(projectId, next, sourceFor(candidate));

              return [
                { _tag: "Ok", value: next },
                { records, maps, current: next }
              ];
            } catch (cause) {
              return [{ _tag: "Failure", error: asFailure(cause) }, current];
            }
          });
          return result._tag === "Ok"
            ? result.value
            : yield* Effect.fail(result.error);
        }),

      installVerifiedHistory: (next) =>
        Effect.gen(function*() {
          const result = yield* Ref.modify(state, (current): readonly [CasMutationResult<void>, MemoryState] => {
            if (current.current !== null) {
              return [
                {
                  _tag: "Conflict",
                  error: new StateRuntimeConflict({
                    expectedGeneration: null,
                    observedGeneration: current.current.generation,
                    message: "verified history installation requires an empty target store"
                  })
                },
                current
              ];
            }
            try {
              verifyHistoryState(projectId, next, sourceFor(current));
              return [{ _tag: "Ok", value: undefined }, { ...current, current: { ...next } }];
            } catch (cause) {
              return [{ _tag: "Failure", error: asFailure(cause) }, current];
            }
          });
          if (result._tag !== "Ok") return yield* Effect.fail(result.error);
        }),

      history: (limit = 100) =>
        Ref.get(state).pipe(
          Effect.flatMap((current) =>
            Effect.try({
              try: () => {
                const out: StateMapPointer[] = [];
                let pointer = current.current;
                const bounded = Math.max(1, Math.min(limit, 1000));
                while (pointer !== null && out.length < bounded) {
                  out.push({ ...pointer });
                  const mapText = current.maps.get(pointer.map);
                  if (mapText === undefined) {
                    throw new StateRuntimeCorrupt({ digest: pointer.map, message: "history StateMap missing" });
                  }
                  const map = decodeMap(pointer.map, mapText, projectId).value;
                  if (map.generation !== pointer.generation) {
                    throw new StateRuntimeCorrupt({
                      digest: pointer.map,
                      message: "history pointer/StateMap generation mismatch"
                    });
                  }
                  pointer = map.parent === null
                    ? null
                    : makePointer(projectId, map.generation - 1, map.parent);
                }
                return out;
              },
              catch: asFailure
            })
          )
        ),

      verify: verifyCurrent.pipe(Effect.map(legacyHealth)),
      verifyCurrent,
      verifyHistory,
      verifyStorage: Effect.succeed({
        state: "Healthy" as const,
        mechanism: "memory"
      }),

      close: Effect.succeed(undefined)
    };
    return store;
  });
