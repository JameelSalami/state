import { backup, DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Effect } from "effect";
import type { StateImplementationAdapter } from "../implementation.js";
import { STATE_STORE_CAPABILITIES, STATE_STORE_REQUIRED_CHECKS, StateImplementationRefused } from "../implementation.js";

import type { SemanticDigest } from "../canonical.js";
import {
  StateRuntimeConflict,
  StateRuntimeCorrupt,
  StateRuntimeReadError,
  StateRuntimeValidationError,
  StateRuntimeWriteError
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
import { restoreStateRuntimeSnapshotToEmpty, type StateRuntimeSnapshot } from "../snapshot.js";
import {
  assertAdvanceTransition,
  assertDigest,
  assertProject,
  decodeMap,
  decodeRecord,
  encodeMap,
  encodeRecord,
  getCurrentEntryState,
  samePointer,
  verifyCurrentState,
  verifyHistoryState,
  type IntegritySource
} from "../internal.js";

export interface NodeSqliteStateStoreOptions {
  readonly projectId: string;
  readonly path: string;
}

const health = (
  projectId: string,
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
  mechanism: "node-sqlite"
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


const asReadFailure = (
  cause: unknown
): StateRuntimeCorrupt | StateRuntimeValidationError | StateRuntimeReadError =>
  cause instanceof StateRuntimeCorrupt || cause instanceof StateRuntimeValidationError
    ? cause
    : new StateRuntimeReadError({
        mechanism: "node-sqlite",
        message: cause instanceof Error ? cause.message : String(cause)
      });

const asStoreWriteFailure = (
  cause: unknown
): StateRuntimeCorrupt | StateRuntimeValidationError | StateRuntimeWriteError =>
  cause instanceof StateRuntimeCorrupt || cause instanceof StateRuntimeValidationError
    ? cause
    : new StateRuntimeWriteError({
        mechanism: "node-sqlite",
        message: cause instanceof Error ? cause.message : String(cause)
      });

const asWriteFailure = (
  cause: unknown
):
  | StateRuntimeConflict
  | StateRuntimeCorrupt
  | StateRuntimeValidationError
  | StateRuntimeWriteError =>
  cause instanceof StateRuntimeConflict ||
  cause instanceof StateRuntimeCorrupt ||
  cause instanceof StateRuntimeValidationError
    ? cause
    : new StateRuntimeWriteError({
        mechanism: "node-sqlite",
        message: cause instanceof Error ? cause.message : String(cause)
      });

export const openNodeSqliteStateStore = (
  options: NodeSqliteStateStoreOptions
): Effect.Effect<StateRuntimeStore, StateRuntimeWriteError> =>
  Effect.try({
    try: () => {
      const db = new DatabaseSync(options.path);
      db.exec("PRAGMA journal_mode=WAL;");
      db.exec("PRAGMA synchronous=FULL;");
      db.exec("PRAGMA foreign_keys=ON;");
      db.exec("PRAGMA busy_timeout=5000;");
      db.exec(`
        CREATE TABLE IF NOT EXISTS state_records (
          project TEXT NOT NULL,
          digest TEXT NOT NULL,
          canonical_json TEXT NOT NULL,
          PRIMARY KEY (project, digest)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS state_maps (
          project TEXT NOT NULL,
          digest TEXT NOT NULL,
          generation INTEGER NOT NULL,
          parent_digest TEXT,
          canonical_json TEXT NOT NULL,
          PRIMARY KEY (project, digest)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS state_current (
          project TEXT PRIMARY KEY,
          generation INTEGER NOT NULL,
          map_digest TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS state_latest_entries (
          project TEXT NOT NULL,
          id TEXT NOT NULL,
          kind TEXT NOT NULL,
          record_digest TEXT NOT NULL,
          map_digest TEXT NOT NULL,
          generation INTEGER NOT NULL,
          PRIMARY KEY (project, id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS state_latest_index_meta (
          project TEXT PRIMARY KEY,
          generation INTEGER NOT NULL,
          map_digest TEXT NOT NULL
        ) STRICT;
      `);

      const readPointer = (): StateMapPointer | null => {
        const row = db.prepare(
          "SELECT generation, map_digest FROM state_current WHERE project = ?"
        ).get(options.projectId) as { generation: number; map_digest: string } | undefined;
        return row === undefined
          ? null
          : makePointer(
              options.projectId,
              Number(row.generation),
              assertDigest(row.map_digest, "$.current.map_digest")
            );
      };

      const readMapText = (digest: SemanticDigest): string | undefined => {
        const row = db.prepare(
          "SELECT canonical_json FROM state_maps WHERE project = ? AND digest = ?"
        ).get(options.projectId, digest) as { canonical_json: string } | undefined;
        return row?.canonical_json;
      };

      const readRecordText = (digest: SemanticDigest): string | undefined => {
        const row = db.prepare(
          "SELECT canonical_json FROM state_records WHERE project = ? AND digest = ?"
        ).get(options.projectId, digest) as { canonical_json: string } | undefined;
        return row?.canonical_json;
      };

      const source: IntegritySource = {
        getMapText: readMapText,
        getRecordText: readRecordText
      };

      const writeRecord = (record: StateRecord): SemanticDigest => {
        assertProject(options.projectId, record.project, "$.project");
        const stored = encodeRecord(record);
        const existing = readRecordText(stored.digest);
        if (existing !== undefined && existing !== stored.canonicalJson) {
          throw new StateRuntimeCorrupt({
            digest: stored.digest,
            message: "content-addressed record collision"
          });
        }
        db.prepare(
          "INSERT OR IGNORE INTO state_records(project,digest,canonical_json) VALUES(?,?,?)"
        ).run(options.projectId, stored.digest, stored.canonicalJson);
        return stored.digest;
      };

      const writeMap = (map: StateMap): SemanticDigest => {
        assertProject(options.projectId, map.project, "$.project");
        const stored = encodeMap(map);
        const existing = readMapText(stored.digest);
        if (existing !== undefined && existing !== stored.canonicalJson) {
          throw new StateRuntimeCorrupt({
            digest: stored.digest,
            message: "content-addressed StateMap collision"
          });
        }
        db.prepare(
          "INSERT OR IGNORE INTO state_maps(project,digest,generation,parent_digest,canonical_json) VALUES(?,?,?,?,?)"
        ).run(
          options.projectId,
          stored.digest,
          stored.value.generation,
          stored.value.parent,
          stored.canonicalJson
        );
        return stored.digest;
      };

      const writeCurrent = (pointer: StateMapPointer): void => {
        db.prepare(
          "INSERT INTO state_current(project,generation,map_digest) VALUES(?,?,?) " +
          "ON CONFLICT(project) DO UPDATE SET generation=excluded.generation,map_digest=excluded.map_digest"
        ).run(options.projectId, pointer.generation, pointer.map);
      };

      const readLatestIndexPointer = (): StateMapPointer | null => {
        const row = db.prepare(
          "SELECT generation, map_digest FROM state_latest_index_meta WHERE project = ?"
        ).get(options.projectId) as { generation: number; map_digest: string } | undefined;
        return row === undefined
          ? null
          : makePointer(
              options.projectId,
              Number(row.generation),
              assertDigest(row.map_digest, "$.latest_index.map_digest")
            );
      };

      const applyLatestMap = (pointer: StateMapPointer, reset: boolean): void => {
        const text = readMapText(pointer.map);
        if (text === undefined) {
          throw new StateRuntimeCorrupt({ digest: pointer.map, message: "latest-index StateMap missing" });
        }
        const map = decodeMap(pointer.map, text, options.projectId).value;
        if (map.generation !== pointer.generation) {
          throw new StateRuntimeCorrupt({
            digest: pointer.map,
            message: "latest-index pointer/StateMap generation mismatch"
          });
        }
        if (reset) {
          db.prepare("DELETE FROM state_latest_entries WHERE project = ?").run(options.projectId);
        }
        const upsert = db.prepare(
          "INSERT INTO state_latest_entries(project,id,kind,record_digest,map_digest,generation) VALUES(?,?,?,?,?,?) " +
          "ON CONFLICT(project,id) DO UPDATE SET kind=excluded.kind,record_digest=excluded.record_digest,map_digest=excluded.map_digest,generation=excluded.generation"
        );
        for (const [id, entry] of Object.entries(map.entries)) {
          upsert.run(
            options.projectId,
            id,
            entry.kind,
            entry.record,
            pointer.map,
            pointer.generation
          );
        }
        db.prepare(
          "INSERT INTO state_latest_index_meta(project,generation,map_digest) VALUES(?,?,?) " +
          "ON CONFLICT(project) DO UPDATE SET generation=excluded.generation,map_digest=excluded.map_digest"
        ).run(options.projectId, pointer.generation, pointer.map);
      };

      const rebuildLatestIndex = (head: StateMapPointer | null): void => {
        db.prepare("DELETE FROM state_latest_entries WHERE project = ?").run(options.projectId);
        db.prepare("DELETE FROM state_latest_index_meta WHERE project = ?").run(options.projectId);
        if (head === null) return;
        verifyHistoryState(options.projectId, head, source);
        const chain: StateMapPointer[] = [];
        let pointer: StateMapPointer | null = head;
        while (pointer !== null) {
          chain.push(pointer);
          const text = readMapText(pointer.map);
          if (text === undefined) {
            throw new StateRuntimeCorrupt({ digest: pointer.map, message: "latest-index history StateMap missing" });
          }
          const map: StateMap = decodeMap(pointer.map, text, options.projectId).value;
          pointer = map.parent === null
            ? null
            : makePointer(options.projectId, map.generation - 1, map.parent);
        }
        for (const item of chain.reverse()) applyLatestMap(item, false);
      };

      const advanceLatestIndex = (
        expected: StateMapPointer | null,
        next: StateMapPointer
      ): void => {
        if (!samePointer(readLatestIndexPointer(), expected)) {
          throw new StateRuntimeCorrupt({
            message: "latest-entry index is not bound to expected current pointer"
          });
        }
        applyLatestMap(next, expected === null);
      };

      const ensureLatestIndex = (): void => {
        const current = readPointer();
        if (samePointer(readLatestIndexPointer(), current)) return;
        db.exec("BEGIN IMMEDIATE;");
        try {
          const observed = readPointer();
          if (!samePointer(readLatestIndexPointer(), observed)) {
            rebuildLatestIndex(observed);
          }
          db.exec("COMMIT;");
        } catch (cause) {
          try { db.exec("ROLLBACK;"); } catch {}
          throw cause;
        }
      };

      ensureLatestIndex();

      const verifyEffect = (scope: "current" | "history") =>
        Effect.try({
          try: () => {
            const summary =
              scope === "current"
                ? verifyCurrentState(options.projectId, readPointer(), source)
                : verifyHistoryState(options.projectId, readPointer(), source);
            return health(options.projectId, scope, summary);
          },
          catch: asReadFailure
        });

      const verifyCurrent = verifyEffect("current");
      const verifyHistory = verifyEffect("history");

      const verifyStorage = Effect.try({
        try: () => {
          const rows = db.prepare("PRAGMA integrity_check;").all() as Record<string, unknown>[];
          if (
            rows.length !== 1 ||
            !Object.values(rows[0] ?? {}).includes("ok")
          ) {
            throw new StateRuntimeCorrupt({
              message: "SQLite integrity_check failed"
            });
          }
          return {
            state: "Healthy" as const,
            mechanism: "node-sqlite"
          };
        },
        catch: asReadFailure
      });

      const store: StateRuntimeStore = {
        projectId: options.projectId,
        mechanismId: "node-sqlite",

        putRecord: (record: StateRecord) =>
          Effect.try({
            try: () => writeRecord(record),
            catch: asStoreWriteFailure
          }),

        getRecord: (digest: SemanticDigest) =>
          Effect.try({
            try: () => {
              const text = readRecordText(digest);
              if (text === undefined) {
                throw new StateRuntimeCorrupt({ digest, message: "record not found" });
              }
              return decodeRecord(digest, text, options.projectId);
            },
            catch: asReadFailure
          }),

        putMap: (map: StateMap) =>
          Effect.try({
            try: () => writeMap(map),
            catch: asStoreWriteFailure
          }),

        getMap: (digest: SemanticDigest) =>
          Effect.try({
            try: () => {
              const text = readMapText(digest);
              if (text === undefined) {
                throw new StateRuntimeCorrupt({ digest, message: "StateMap not found" });
              }
              return decodeMap(digest, text, options.projectId);
            },
            catch: asReadFailure
          }),

        current: Effect.try({
          try: readPointer,
          catch: asReadFailure
        }),

        getCurrentEntry: (id) =>
          Effect.try({
            try: () =>
              getCurrentEntryState(
                options.projectId,
                readPointer(),
                id,
                source
              ),
            catch: asReadFailure
          }),

        getLatestEntry: (id) =>
          Effect.try({
            try: () => {
              const current = readPointer();
              if (current === null) return null;
              if (!samePointer(readLatestIndexPointer(), current)) {
                throw new StateRuntimeCorrupt({
                  message: "latest-entry index is not bound to current pointer"
                });
              }
              const row = db.prepare(
                "SELECT kind,record_digest,map_digest,generation FROM state_latest_entries WHERE project = ? AND id = ?"
              ).get(options.projectId, id) as
                | { kind: string; record_digest: string; map_digest: string; generation: number }
                | undefined;
              if (row === undefined) return null;
              const pointer = makePointer(
                options.projectId,
                Number(row.generation),
                assertDigest(row.map_digest, "$.latest_entry.map_digest")
              );
              const mapText = readMapText(pointer.map);
              if (mapText === undefined) {
                throw new StateRuntimeCorrupt({ digest: pointer.map, message: "latest-entry StateMap missing" });
              }
              const map = decodeMap(pointer.map, mapText, options.projectId).value;
              if (map.generation !== pointer.generation) {
                throw new StateRuntimeCorrupt({ digest: pointer.map, message: "latest-entry StateMap generation mismatch" });
              }
              const entry = map.entries[id];
              const recordDigest = assertDigest(row.record_digest, "$.latest_entry.record_digest");
              if (
                entry === undefined ||
                entry.kind !== row.kind ||
                entry.record !== recordDigest
              ) {
                throw new StateRuntimeCorrupt({
                  digest: pointer.map,
                  message: "latest-entry index does not match immutable StateMap"
                });
              }
              const recordText = readRecordText(recordDigest);
              if (recordText === undefined) {
                throw new StateRuntimeCorrupt({ digest: recordDigest, message: "latest-entry record missing" });
              }
              const record = decodeRecord(recordDigest, recordText, options.projectId);
              if (record.value.id !== id || record.value.kind !== row.kind) {
                throw new StateRuntimeCorrupt({ digest: recordDigest, message: "latest-entry record identity mismatch" });
              }
              return { pointer, id, kind: row.kind, record };
            },
            catch: asReadFailure
          }),

        compareAndSwapCurrent: (expected, next) =>
          Effect.try({
            try: () => {
              db.exec("BEGIN IMMEDIATE;");
              try {
                const observed = readPointer();
                if (!samePointer(expected, observed)) {
                  throw new StateRuntimeConflict({
                    expectedGeneration: expected?.generation ?? null,
                    observedGeneration: observed?.generation ?? null,
                    message: "StateMap current pointer changed"
                  });
                }
                assertAdvanceTransition(options.projectId, expected, next, source);
                verifyCurrentState(options.projectId, next, source);
                advanceLatestIndex(expected, next);
                writeCurrent(next);
                db.exec("COMMIT;");
              } catch (cause) {
                try { db.exec("ROLLBACK;"); } catch {}
                throw cause;
              }
            },
            catch: asWriteFailure
          }),

        commit: (input: StateRuntimeCommit) =>
          Effect.try({
            try: () => {
              db.exec("BEGIN IMMEDIATE;");
              try {
                const observed = readPointer();
                if (!samePointer(input.expected, observed)) {
                  throw new StateRuntimeConflict({
                    expectedGeneration: input.expected?.generation ?? null,
                    observedGeneration: observed?.generation ?? null,
                    message: "StateMap current pointer changed"
                  });
                }

                for (const record of input.records) {
                  writeRecord(record);
                }
                const mapDigest = writeMap(input.map);
                const next = makePointer(
                  options.projectId,
                  input.map.generation,
                  mapDigest
                );
                assertAdvanceTransition(options.projectId, input.expected, next, source);
                verifyCurrentState(options.projectId, next, source);
                advanceLatestIndex(input.expected, next);
                writeCurrent(next);
                db.exec("COMMIT;");
                return next;
              } catch (cause) {
                try { db.exec("ROLLBACK;"); } catch {}
                throw cause;
              }
            },
            catch: asWriteFailure
          }),

        installVerifiedHistory: (next) =>
          Effect.try({
            try: () => {
              db.exec("BEGIN IMMEDIATE;");
              try {
                const observed = readPointer();
                if (observed !== null) {
                  throw new StateRuntimeConflict({
                    expectedGeneration: null,
                    observedGeneration: observed.generation,
                    message: "verified history installation requires an empty target store"
                  });
                }
                verifyHistoryState(options.projectId, next, source);
                rebuildLatestIndex(next);
                writeCurrent(next);
                db.exec("COMMIT;");
              } catch (cause) {
                try { db.exec("ROLLBACK;"); } catch {}
                throw cause;
              }
            },
            catch: asWriteFailure
          }),

        history: (limit = 100) =>
          Effect.try({
            try: () => {
              const out: StateMapPointer[] = [];
              let pointer = readPointer();
              const bounded = Math.max(1, Math.min(limit, 1000));
              while (pointer !== null && out.length < bounded) {
                out.push(pointer);
                const text = readMapText(pointer.map);
                if (text === undefined) {
                  throw new StateRuntimeCorrupt({
                    digest: pointer.map,
                    message: "history StateMap missing"
                  });
                }
                const map = decodeMap(pointer.map, text, options.projectId).value;
                if (map.generation !== pointer.generation) {
                  throw new StateRuntimeCorrupt({
                    digest: pointer.map,
                    message: "history pointer/StateMap generation mismatch"
                  });
                }
                if (map.generation === 0 && map.parent !== null) {
                  throw new StateRuntimeCorrupt({
                    digest: pointer.map,
                    message: "generation 0 StateMap must have null parent"
                  });
                }
                if (map.generation > 0 && map.parent === null) {
                  throw new StateRuntimeCorrupt({
                    digest: pointer.map,
                    message: "non-zero StateMap generation is missing its parent"
                  });
                }
                pointer = map.parent === null
                  ? null
                  : makePointer(
                      options.projectId,
                      map.generation - 1,
                      map.parent
                    );
              }
              return out;
            },
            catch: asReadFailure
          }),

        verify: verifyCurrent.pipe(Effect.map(legacyHealth)),
        verifyCurrent,
        verifyHistory,
        verifyStorage,

        close: Effect.try({
          try: () => db.close(),
          catch: (cause) =>
            new StateRuntimeWriteError({
              mechanism: "node-sqlite",
              message: cause instanceof Error ? cause.message : String(cause)
            })
        })
      };
      return store;
    },
    catch: (cause) =>
      new StateRuntimeWriteError({
        mechanism: "node-sqlite",
        message: cause instanceof Error ? cause.message : String(cause)
      })
  });


export const backupNodeSqliteDatabase = (
  sourcePath: string,
  destinationPath: string
): Effect.Effect<number, StateRuntimeReadError | StateRuntimeWriteError> =>
  Effect.tryPromise({
    try: async () => {
      const source = new DatabaseSync(sourcePath, {
        readOnly: true,
        timeout: 5000
      });
      try {
        return await backup(source, destinationPath);
      } finally {
        source.close();
      }
    },
    catch: (cause) =>
      new StateRuntimeWriteError({
        mechanism: "node-sqlite-backup",
        message: cause instanceof Error ? cause.message : String(cause)
      })
  });


const checkpointSqliteFile = (
  path: string
): Effect.Effect<void, StateRuntimeWriteError> =>
  Effect.try({
    try: () => {
      const db = new DatabaseSync(path, { timeout: 5000 });
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      } finally {
        db.close();
      }
    },
    catch: (cause) =>
      new StateRuntimeWriteError({
        mechanism: "node-sqlite-checkpoint",
        message: cause instanceof Error ? cause.message : String(cause)
      })
  });

const fsyncFile = (
  path: string
): Effect.Effect<void, StateRuntimeWriteError> =>
  Effect.tryPromise({
    try: async () => {
      const handle = await open(path, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    catch: (cause) =>
      new StateRuntimeWriteError({
        mechanism: "node-sqlite-replace",
        message: cause instanceof Error ? cause.message : String(cause)
      })
  });

const fsyncDirectory = (
  path: string
): Effect.Effect<void, StateRuntimeWriteError> =>
  Effect.tryPromise({
    try: async () => {
      const handle = await open(path, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    catch: (cause) =>
      new StateRuntimeWriteError({
        mechanism: "node-sqlite-replace",
        message: cause instanceof Error ? cause.message : String(cause)
      })
  });

export const replaceNodeSqliteDatabaseFromSnapshot = (
  snapshot: StateRuntimeSnapshot,
  destinationPath: string
) => {
  const directory = dirname(destinationPath);
  const tempPath = join(
    directory,
    `.${basename(destinationPath)}.${randomUUID()}.replacement.sqlite3`
  );

  const cleanupTemporaryDatabase = Effect.tryPromise({
    try: async () => {
      await rm(tempPath, { force: true });
      await rm(tempPath + "-wal", { force: true });
      await rm(tempPath + "-shm", { force: true });
    },
    catch: (cause) =>
      new StateRuntimeWriteError({
        mechanism: "node-sqlite-replace",
        message: cause instanceof Error ? cause.message : String(cause)
      })
  });

  const program = Effect.gen(function*() {
    yield* Effect.tryPromise({
      try: () => mkdir(directory, { recursive: true }),
      catch: (cause) =>
        new StateRuntimeWriteError({
          mechanism: "node-sqlite-replace",
          message: cause instanceof Error ? cause.message : String(cause)
        })
    });

    const restored = yield* Effect.acquireUseRelease(
      openNodeSqliteStateStore({
        projectId: snapshot.project,
        path: tempPath
      }),
      (replacement) =>
        Effect.gen(function*() {
          const value = yield* restoreStateRuntimeSnapshotToEmpty(
            replacement,
            snapshot
          );
          yield* replacement.verifyHistory;
          yield* replacement.verifyStorage;
          return value;
        }),
      (replacement) => replacement.close.pipe(Effect.orDie)
    );

    yield* checkpointSqliteFile(tempPath);
    yield* fsyncFile(tempPath);

    const destinationExists = yield* Effect.tryPromise({
      try: async () => {
        try {
          await stat(destinationPath);
          return true;
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw cause;
        }
      },
      catch: (cause) =>
        new StateRuntimeWriteError({
          mechanism: "node-sqlite-replace",
          message: cause instanceof Error ? cause.message : String(cause)
        })
    });

    if (destinationExists) {
      yield* checkpointSqliteFile(destinationPath);
    }

    yield* Effect.tryPromise({
      try: async () => {
        await rm(destinationPath + "-wal", { force: true });
        await rm(destinationPath + "-shm", { force: true });
        await rm(tempPath + "-wal", { force: true });
        await rm(tempPath + "-shm", { force: true });
        await rename(tempPath, destinationPath);
      },
      catch: (cause) =>
        new StateRuntimeWriteError({
          mechanism: "node-sqlite-replace",
          message: cause instanceof Error ? cause.message : String(cause)
        })
    });

    yield* fsyncDirectory(directory);
    return restored;
  });

  return program.pipe(
    Effect.onError(() => cleanupTemporaryDatabase.pipe(Effect.orDie))
  );
};

/** Optional Node-specific realization; not referenced by State's portable root. */
export const nodeSqliteStateImplementation: StateImplementationAdapter = {
  id: "node-sqlite",
  version: "1.0.0",
  requiredChecks: [...STATE_STORE_REQUIRED_CHECKS, "crash-recovery"],
  configurationSchemaDigest: null,
  capabilities: [...STATE_STORE_CAPABILITIES, "durable-restart"],
  open: ({ projectId, configuration }) => {
    if (
      !configuration || typeof configuration !== "object" ||
      Array.isArray(configuration) ||
      Object.keys(configuration).sort().join(",") !== "path" ||
      typeof (configuration as { path?: unknown }).path !== "string" ||
      !(configuration as { path: string }).path.trim()
    ) {
      return Effect.fail(new StateImplementationRefused("invalid-configuration"));
    }
    return openNodeSqliteStateStore({
      projectId,
      path: (configuration as { path: string }).path,
    });
  },
};