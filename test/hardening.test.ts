import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Effect } from "effect";

import {
  canonicalJson,
  exportStateRuntimeSnapshot,
  makeMemoryStateStore,
  makePointer,
  makeRecord,
  makeStateMap,
  mapDigest,
  recordDigest,
  restoreStateRuntimeSnapshotToEmpty,
  semanticDigest,
  type JsonValue,
  type StateRuntimeStore
} from "../src/index.js";
import { openNodeSqliteStateStore } from "../src/adapters/node-sqlite.js";

const left = async <A, E>(effect: Effect.Effect<A, E>): Promise<E> => {
  const result = await Effect.runPromise(Effect.either(effect));
  assert.equal(result._tag, "Left");
  if (result._tag !== "Left") throw new Error("expected failure");
  return result.left;
};

const withStores = async (
  run: (name: string, store: StateRuntimeStore) => Promise<void>
): Promise<void> => {
  const memory = await Effect.runPromise(makeMemoryStateStore("assistant"));
  await run("memory", memory);
  await Effect.runPromise(memory.close);

  const root = await mkdtemp(join(tmpdir(), "state-runtime-hardening-"));
  try {
    const sqlite = await Effect.runPromise(
      openNodeSqliteStateStore({
        projectId: "assistant",
        path: join(root, "assistant.sqlite3")
      })
    );
    await run("sqlite", sqlite);
    await Effect.runPromise(sqlite.close);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const seedGenesis = async (store: StateRuntimeStore) => {
  const record = makeRecord("assistant", "a", "kind", { value: 0 });
  const recordDigestValue = await Effect.runPromise(store.putRecord(record));
  const map = makeStateMap({
    project: "assistant",
    generation: 0,
    parent: null,
    compiler: "hardening/v1",
    sourceDigest: semanticDigest({ generation: 0 }),
    entries: {
      a: { kind: record.kind, record: recordDigestValue }
    }
  });
  const mapDigestValue = await Effect.runPromise(store.putMap(map));
  const pointer = makePointer("assistant", 0, mapDigestValue);
  await Effect.runPromise(store.compareAndSwapCurrent(null, pointer));
  return { record, map, pointer };
};

test("ordinary advancement law is identical in memory and SQLite", async () => {
  await withStores(async (name, store) => {
    const { pointer: pointer0 } = await seedGenesis(store);

    const skipped = makeStateMap({
      project: "assistant",
      generation: 2,
      parent: pointer0.map,
      compiler: "hardening/v1",
      sourceDigest: semanticDigest({ skipped: name }),
      entries: {}
    });
    const skippedDigest = await Effect.runPromise(store.putMap(skipped));
    const skippedError = await left(
      store.compareAndSwapCurrent(
        pointer0,
        makePointer("assistant", 2, skippedDigest)
      )
    );
    assert.equal((skippedError as { _tag?: string })._tag, "StateRuntimeCorrupt");

    const wrongParent = makeStateMap({
      project: "assistant",
      generation: 1,
      parent: null,
      compiler: "hardening/v1",
      sourceDigest: semanticDigest({ wrongParent: name }),
      entries: {}
    });
    const wrongParentDigest = await Effect.runPromise(store.putMap(wrongParent));
    const parentError = await left(
      store.compareAndSwapCurrent(
        pointer0,
        makePointer("assistant", 1, wrongParentDigest)
      )
    );
    assert.equal((parentError as { _tag?: string })._tag, "StateRuntimeCorrupt");

    const nextRecord = makeRecord("assistant", "b", "kind", { value: 1 });
    const nextRecordDigest = await Effect.runPromise(store.putRecord(nextRecord));
    const nextMap = makeStateMap({
      project: "assistant",
      generation: 1,
      parent: pointer0.map,
      compiler: "hardening/v1",
      sourceDigest: semanticDigest({ generation: 1, name }),
      entries: {
        b: { kind: nextRecord.kind, record: nextRecordDigest }
      }
    });
    const nextMapDigest = await Effect.runPromise(store.putMap(nextMap));
    const pointer1 = makePointer("assistant", 1, nextMapDigest);
    await Effect.runPromise(store.compareAndSwapCurrent(pointer0, pointer1));

    const stale = await left(store.compareAndSwapCurrent(pointer0, pointer1));
    assert.equal((stale as { _tag?: string })._tag, "StateRuntimeConflict");

    const legacyHealth = await Effect.runPromise(store.verify);
    const currentHealth = await Effect.runPromise(store.verifyCurrent);
    const historyHealth = await Effect.runPromise(store.verifyHistory);
    assert.equal("scope" in legacyHealth, false);
    assert.equal(currentHealth.scope, "current");
    assert.equal(currentHealth.maps, 1);
    assert.equal(historyHealth.scope, "history");
    assert.equal(historyHealth.maps, 2);

    const currentB = await Effect.runPromise(store.getCurrentEntry("b"));
    assert.equal(currentB?.record.value.id, "b");
    const ghost = makeRecord("assistant", "ghost", "kind", { value: 99 });
    await Effect.runPromise(store.putRecord(ghost));
    assert.equal(await Effect.runPromise(store.getCurrentEntry("ghost")), null);
  });
});

test("ordinary empty-store CAS is genesis-only while verified snapshot restore can install history", async () => {
  const source = await Effect.runPromise(makeMemoryStateStore("assistant"));
  const { pointer: pointer0 } = await seedGenesis(source);
  const record = makeRecord("assistant", "b", "kind", { value: 1 });
  const digest = await Effect.runPromise(source.putRecord(record));
  const map1 = makeStateMap({
    project: "assistant",
    generation: 1,
    parent: pointer0.map,
    compiler: "hardening/v1",
    sourceDigest: semanticDigest({ generation: 1 }),
    entries: { b: { kind: record.kind, record: digest } }
  });
  const map1Digest = await Effect.runPromise(source.putMap(map1));
  const pointer1 = makePointer("assistant", 1, map1Digest);
  await Effect.runPromise(source.compareAndSwapCurrent(pointer0, pointer1));
  const snapshot = await Effect.runPromise(exportStateRuntimeSnapshot(source));

  const target = await Effect.runPromise(makeMemoryStateStore("assistant"));
  for (const encoded of snapshot.payload.records) {
    await Effect.runPromise(target.putRecord(JSON.parse(encoded.canonicalJson)));
  }
  for (const encoded of snapshot.payload.maps) {
    await Effect.runPromise(target.putMap(JSON.parse(encoded.canonicalJson)));
  }
  const normalInstall = await left(target.compareAndSwapCurrent(null, pointer1));
  assert.equal((normalInstall as { _tag?: string })._tag, "StateRuntimeCorrupt");
  assert.equal(await Effect.runPromise(target.current), null);

  const restored = await Effect.runPromise(
    restoreStateRuntimeSnapshotToEmpty(target, snapshot)
  );
  assert.deepEqual(restored, pointer1);
  assert.equal((await Effect.runPromise(target.verifyHistory)).maps, 2);
});

test("snapshot restore rejects structurally incomplete history before current advances", async () => {
  const source = await Effect.runPromise(makeMemoryStateStore("assistant"));
  const { pointer: pointer0 } = await seedGenesis(source);
  const map1 = makeStateMap({
    project: "assistant",
    generation: 1,
    parent: pointer0.map,
    compiler: "hardening/v1",
    sourceDigest: semanticDigest({ generation: 1 }),
    entries: {}
  });
  const map1Digest = await Effect.runPromise(source.putMap(map1));
  await Effect.runPromise(
    source.compareAndSwapCurrent(
      pointer0,
      makePointer("assistant", 1, map1Digest)
    )
  );
  const snapshot = await Effect.runPromise(exportStateRuntimeSnapshot(source));
  const payload = {
    ...snapshot.payload,
    maps: snapshot.payload.maps.filter((map) => map.digest !== pointer0.map)
  };
  const incomplete = {
    ...snapshot,
    payload,
    payloadDigest: semanticDigest(payload as unknown as JsonValue)
  };

  const target = await Effect.runPromise(makeMemoryStateStore("assistant"));
  const error = await left(
    restoreStateRuntimeSnapshotToEmpty(target, incomplete)
  );
  assert.equal((error as { _tag?: string })._tag, "StateRuntimeCorrupt");
  assert.equal(await Effect.runPromise(target.current), null);
});

test("atomic commit is all-or-nothing and conflict writes nothing", async () => {
  await withStores(async (name, store) => {
    const first = makeRecord("assistant", "a", "kind", { value: 0 });
    const firstDigest = recordDigest(first);
    const map0 = makeStateMap({
      project: "assistant",
      generation: 0,
      parent: null,
      compiler: "commit/v1",
      sourceDigest: semanticDigest({ name, generation: 0 }),
      entries: { a: { kind: first.kind, record: firstDigest } }
    });
    const pointer0 = await Effect.runPromise(
      store.commit({ expected: null, records: [first], map: map0 })
    );

    const second = makeRecord("assistant", "b", "kind", { value: 1 });
    const secondDigest = recordDigest(second);
    const map1 = makeStateMap({
      project: "assistant",
      generation: 1,
      parent: pointer0.map,
      compiler: "commit/v1",
      sourceDigest: semanticDigest({ name, generation: 1 }),
      entries: { b: { kind: second.kind, record: secondDigest } }
    });
    const pointer1 = await Effect.runPromise(
      store.commit({ expected: pointer0, records: [second], map: map1 })
    );

    const ghost = makeRecord("assistant", "ghost", "kind", { value: 2 });
    const ghostDigest = recordDigest(ghost);
    const map2 = makeStateMap({
      project: "assistant",
      generation: 2,
      parent: pointer1.map,
      compiler: "commit/v1",
      sourceDigest: semanticDigest({ name, generation: 2 }),
      entries: { ghost: { kind: ghost.kind, record: ghostDigest } }
    });
    const map2Digest = mapDigest(map2);
    const conflict = await left(
      store.commit({ expected: pointer0, records: [ghost], map: map2 })
    );
    assert.equal((conflict as { _tag?: string })._tag, "StateRuntimeConflict");
    assert.deepEqual(await Effect.runPromise(store.current), pointer1);
    assert.equal((await Effect.runPromise(Effect.either(store.getRecord(ghostDigest))))._tag, "Left");
    assert.equal((await Effect.runPromise(Effect.either(store.getMap(map2Digest))))._tag, "Left");

    const missingDigest = semanticDigest({ missing: name });
    const invalidMap = makeStateMap({
      project: "assistant",
      generation: 2,
      parent: pointer1.map,
      compiler: "commit/v1",
      sourceDigest: semanticDigest({ invalid: name }),
      entries: { missing: { kind: "kind", record: missingDigest } }
    });
    const invalidMapDigest = mapDigest(invalidMap);
    const invalid = await left(
      store.commit({ expected: pointer1, records: [], map: invalidMap })
    );
    assert.equal((invalid as { _tag?: string })._tag, "StateRuntimeCorrupt");
    assert.deepEqual(await Effect.runPromise(store.current), pointer1);
    assert.equal((await Effect.runPromise(Effect.either(store.getMap(invalidMapDigest))))._tag, "Left");
  });
});

const seedHistoricalOnlyRecord = async (store: StateRuntimeStore) => {
  const oldRecord = makeRecord("assistant", "old", "kind", { value: "old" });
  const oldDigest = await Effect.runPromise(store.putRecord(oldRecord));
  const map0 = makeStateMap({
    project: "assistant",
    generation: 0,
    parent: null,
    compiler: "history/v1",
    sourceDigest: semanticDigest({ generation: 0 }),
    entries: { old: { kind: oldRecord.kind, record: oldDigest } }
  });
  const map0Digest = await Effect.runPromise(store.putMap(map0));
  const pointer0 = makePointer("assistant", 0, map0Digest);
  await Effect.runPromise(store.compareAndSwapCurrent(null, pointer0));

  const currentRecord = makeRecord("assistant", "current", "kind", { value: "current" });
  const currentDigest = await Effect.runPromise(store.putRecord(currentRecord));
  const map1 = makeStateMap({
    project: "assistant",
    generation: 1,
    parent: map0Digest,
    compiler: "history/v1",
    sourceDigest: semanticDigest({ generation: 1 }),
    entries: { current: { kind: currentRecord.kind, record: currentDigest } }
  });
  const map1Digest = await Effect.runPromise(store.putMap(map1));
  await Effect.runPromise(
    store.compareAndSwapCurrent(
      pointer0,
      makePointer("assistant", 1, map1Digest)
    )
  );
  return { oldDigest, map0Digest };
};

for (const kind of ["map", "record"] as const) {
  test(`full-history verification detects corruption in an old non-current ${kind}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "state-runtime-history-corrupt-"));
    const path = join(root, "assistant.sqlite3");
    try {
      let store = await Effect.runPromise(
        openNodeSqliteStateStore({ projectId: "assistant", path })
      );
      const seeded = await seedHistoricalOnlyRecord(store);
      await Effect.runPromise(store.close);

      const db = new DatabaseSync(path);
      if (kind === "map") {
        db.prepare(
          "UPDATE state_maps SET canonical_json = canonical_json || ' ' WHERE project = ? AND digest = ?"
        ).run("assistant", seeded.map0Digest);
      } else {
        db.prepare(
          "UPDATE state_records SET canonical_json = canonical_json || ' ' WHERE project = ? AND digest = ?"
        ).run("assistant", seeded.oldDigest);
      }
      db.close();

      store = await Effect.runPromise(
        openNodeSqliteStateStore({ projectId: "assistant", path })
      );
      assert.equal((await Effect.runPromise(store.verifyCurrent)).scope, "current");
      const historyError = await left(store.verifyHistory);
      assert.equal((historyError as { _tag?: string })._tag, "StateRuntimeCorrupt");
      await Effect.runPromise(store.close);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}



test("runtime boundaries reject non-canonical JSON and malformed StateMap shapes", () => {
  assert.equal(
    canonicalJson({ value: -0 } as unknown as JsonValue),
    "{\"value\":0}"
  );
  assert.throws(
    () =>
      makeRecord("assistant", "bad", "kind", {
        value: "\ud800"
      } as unknown as JsonValue),
    /surrogate/
  );
  assert.throws(
    () => canonicalJson(new Array(1) as unknown as JsonValue),
    /sparse arrays/
  );
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(
    () => canonicalJson(cyclic as unknown as JsonValue),
    /cyclic JSON value/
  );
  assert.throws(
    () =>
      makeStateMap({
        project: "assistant",
        generation: 0,
        parent: null,
        compiler: "strict/v1",
        sourceDigest: semanticDigest({ strict: true }),
        entries: [] as unknown as Record<string, never>
      }),
    /plain object/
  );
  assert.throws(
    () =>
      makeStateMap({
        project: "assistant",
        generation: 0,
        parent: null,
        compiler: "strict/v1",
        sourceDigest: semanticDigest({ strict: true }),
        entries: {
          a: {
            kind: "kind",
            record: semanticDigest({ record: true }),
            extra: true
          } as unknown as { kind: string; record: ReturnType<typeof semanticDigest> }
        }
      }),
    /not allowed/
  );
});

test("snapshot restore rejects disconnected immutable payload", async () => {
  const source = await Effect.runPromise(makeMemoryStateStore("assistant"));
  await seedGenesis(source);
  const snapshot = await Effect.runPromise(exportStateRuntimeSnapshot(source));

  const orphan = makeStateMap({
    project: "assistant",
    generation: 0,
    parent: null,
    compiler: "orphan/v1",
    sourceDigest: semanticDigest({ orphan: true }),
    entries: {}
  });
  const orphanDigest = mapDigest(orphan);
  const payload = {
    ...snapshot.payload,
    maps: [
      ...snapshot.payload.maps,
      {
        digest: orphanDigest,
        canonicalJson: canonicalJson(orphan as unknown as JsonValue)
      }
    ]
  };
  const forged = {
    ...snapshot,
    payload,
    payloadDigest: semanticDigest(payload as unknown as JsonValue)
  };

  const target = await Effect.runPromise(makeMemoryStateStore("assistant"));
  const error = await left(
    restoreStateRuntimeSnapshotToEmpty(target, forged)
  );
  assert.equal((error as { _tag?: string })._tag, "StateRuntimeCorrupt");
  assert.equal(await Effect.runPromise(target.current), null);
});

test("storage verification is explicit and replacement cleanup runs on failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "state-runtime-storage-"));
  try {
    const path = join(root, "active.sqlite3");
    const store = await Effect.runPromise(
      openNodeSqliteStateStore({ projectId: "assistant", path })
    );
    await seedGenesis(store);
    assert.deepEqual(await Effect.runPromise(store.verifyStorage), {
      state: "Healthy",
      mechanism: "node-sqlite"
    });
    const snapshot = await Effect.runPromise(exportStateRuntimeSnapshot(store));
    await Effect.runPromise(store.close);

    const invalid = {
      ...snapshot,
      payloadDigest: ("sha256:" + "0".repeat(64)) as ReturnType<typeof semanticDigest>
    };
    const replacement = await import("../src/adapters/node-sqlite.js");
    await assert.rejects(
      Effect.runPromise(
        replacement.replaceNodeSqliteDatabaseFromSnapshot(
          invalid,
          join(root, "replacement.sqlite3")
        )
      )
    );

    const { readdir } = await import("node:fs/promises");
    const leftovers = (await readdir(root)).filter((name) =>
      name.includes(".replacement.sqlite3")
    );
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});



test("latest-entry lookup is history-aware while current-entry lookup stays generation-local", async () => {
  await withStores(async (_name, store) => {
    const oldRecord = makeRecord("assistant", "old", "kind", { value: 0 });
    const oldDigest = recordDigest(oldRecord);
    const map0 = makeStateMap({
      project: "assistant",
      generation: 0,
      parent: null,
      compiler: "latest-entry/v1",
      sourceDigest: semanticDigest({ generation: 0 }),
      entries: {
        old: { kind: oldRecord.kind, record: oldDigest }
      }
    });
    const pointer0 = await Effect.runPromise(
      store.commit({ expected: null, records: [oldRecord], map: map0 })
    );

    const currentRecord = makeRecord("assistant", "current", "kind", { value: 1 });
    const currentDigest = recordDigest(currentRecord);
    const map1 = makeStateMap({
      project: "assistant",
      generation: 1,
      parent: pointer0.map,
      compiler: "latest-entry/v1",
      sourceDigest: semanticDigest({ generation: 1 }),
      entries: {
        current: { kind: currentRecord.kind, record: currentDigest }
      }
    });
    await Effect.runPromise(
      store.commit({
        expected: pointer0,
        records: [currentRecord],
        map: map1
      })
    );

    assert.equal(await Effect.runPromise(store.getCurrentEntry("old")), null);
    const latest = await Effect.runPromise(store.getLatestEntry("old"));
    assert.equal(latest?.pointer.generation, 0);
    assert.equal(latest?.record.value.id, "old");
    assert.equal(
      (await Effect.runPromise(store.getLatestEntry("current")))?.pointer.generation,
      1
    );
  });
});

test("low-level CAS refuses a current map whose records are incomplete", async () => {
  await withStores(async (name, store) => {
    const missing = semanticDigest({ missing: name });
    const map = makeStateMap({
      project: "assistant",
      generation: 0,
      parent: null,
      compiler: "cas-integrity/v1",
      sourceDigest: semanticDigest({ source: name }),
      entries: {
        missing: { kind: "kind", record: missing }
      }
    });
    const mapValue = await Effect.runPromise(store.putMap(map));
    const error = await left(
      store.compareAndSwapCurrent(
        null,
        makePointer("assistant", 0, mapValue)
      )
    );
    assert.equal((error as { _tag?: string })._tag, "StateRuntimeCorrupt");
    assert.equal(await Effect.runPromise(store.current), null);
  });
});

test("SQLite latest-entry index rebuilds from authenticated history on reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "state-runtime-latest-index-"));
  const path = join(root, "assistant.sqlite3");
  try {
    let store = await Effect.runPromise(
      openNodeSqliteStateStore({ projectId: "assistant", path })
    );
    const oldRecord = makeRecord("assistant", "old", "kind", { value: 0 });
    const map0 = makeStateMap({
      project: "assistant",
      generation: 0,
      parent: null,
      compiler: "latest-index/v1",
      sourceDigest: semanticDigest({ generation: 0 }),
      entries: {
        old: { kind: oldRecord.kind, record: recordDigest(oldRecord) }
      }
    });
    const pointer0 = await Effect.runPromise(
      store.commit({ expected: null, records: [oldRecord], map: map0 })
    );
    const currentRecord = makeRecord("assistant", "current", "kind", { value: 1 });
    const map1 = makeStateMap({
      project: "assistant",
      generation: 1,
      parent: pointer0.map,
      compiler: "latest-index/v1",
      sourceDigest: semanticDigest({ generation: 1 }),
      entries: {
        current: {
          kind: currentRecord.kind,
          record: recordDigest(currentRecord)
        }
      }
    });
    await Effect.runPromise(
      store.commit({
        expected: pointer0,
        records: [currentRecord],
        map: map1
      })
    );
    await Effect.runPromise(store.close);

    const raw = new DatabaseSync(path);
    raw.prepare("DELETE FROM state_latest_entries WHERE project = ?").run("assistant");
    raw.prepare("DELETE FROM state_latest_index_meta WHERE project = ?").run("assistant");
    raw.close();

    store = await Effect.runPromise(
      openNodeSqliteStateStore({ projectId: "assistant", path })
    );
    const latest = await Effect.runPromise(store.getLatestEntry("old"));
    assert.equal(latest?.pointer.generation, 0);
    assert.equal(latest?.record.value.id, "old");
    await Effect.runPromise(store.close);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("record, map, and snapshot digest fixtures are unchanged", async () => {
  const store = await Effect.runPromise(makeMemoryStateStore("assistant"));
  const record = makeRecord("assistant", "fixture:1", "fixture", { text: "hello" });
  const recordDigestValue = await Effect.runPromise(store.putRecord(record));
  const map = makeStateMap({
    project: "assistant",
    generation: 0,
    parent: null,
    compiler: "fixture/v1",
    sourceDigest: semanticDigest({ fixture: true }),
    entries: {
      [record.id]: { kind: record.kind, record: recordDigestValue }
    }
  });
  const mapDigestValue = await Effect.runPromise(store.putMap(map));
  await Effect.runPromise(
    store.compareAndSwapCurrent(
      null,
      makePointer("assistant", 0, mapDigestValue)
    )
  );
  const snapshot = await Effect.runPromise(exportStateRuntimeSnapshot(store));
  assert.equal(recordDigestValue, "sha256:2473542a9f63a5d7bff6ff39a7aff81888cb8ef8377cfa473e2be78d9650bad7");
  assert.equal(mapDigestValue, "sha256:bd28583c92c1adac4a71ec584f8a375dab83495316e5b0452ee36bd8e8faf0fe");
  assert.equal(snapshot.payloadDigest, "sha256:5af21056e271bc2465e9cfa2b6c13a3206ff6bbd5cb7551b7dafec9b85427d1f");
});
