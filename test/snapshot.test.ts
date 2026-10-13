import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";

import {
  exportStateRuntimeSnapshot,
  makeMemoryStateStore,
  makePointer,
  makeRecord,
  makeStateMap,
  restoreStateRuntimeSnapshotToEmpty,
  semanticDigest
} from "../src/index.js";
import { openNodeSqliteStateStore, replaceNodeSqliteDatabaseFromSnapshot } from "../src/adapters/node-sqlite.js";
import type { StateRuntimeStore } from "../src/store.js";

const seedStore = async (store: StateRuntimeStore) => {
  const first = makeRecord(store.projectId, "conversation:1", "conversation", {
    text: "hello"
  });
  const firstDigest = await Effect.runPromise(store.putRecord(first));

  const map0 = makeStateMap({
    project: store.projectId,
    generation: 0,
    parent: null,
    compiler: "snapshot-test/v1",
    sourceDigest: semanticDigest({ generation: 0 }),
    entries: {
      [first.id]: { kind: first.kind, record: firstDigest }
    }
  });
  const map0Digest = await Effect.runPromise(store.putMap(map0));
  const pointer0 = makePointer(store.projectId, 0, map0Digest);
  await Effect.runPromise(store.compareAndSwapCurrent(null, pointer0));

  const second = makeRecord(store.projectId, "invocation:1", "invocation", {
    state: "executing"
  });
  const secondDigest = await Effect.runPromise(store.putRecord(second));

  const map1 = makeStateMap({
    project: store.projectId,
    generation: 1,
    parent: map0Digest,
    compiler: "snapshot-test/v1",
    sourceDigest: semanticDigest({ generation: 1 }),
    entries: {
      [first.id]: { kind: first.kind, record: firstDigest },
      [second.id]: { kind: second.kind, record: secondDigest }
    }
  });
  const map1Digest = await Effect.runPromise(store.putMap(map1));
  const pointer1 = makePointer(store.projectId, 1, map1Digest);
  await Effect.runPromise(store.compareAndSwapCurrent(pointer0, pointer1));

  return pointer1;
};

test("portable snapshot restores memory state into SQLite without changing current identity", async () => {
  const source = await Effect.runPromise(makeMemoryStateStore("assistant"));
  const pointer = await seedStore(source);
  const snapshot = await Effect.runPromise(exportStateRuntimeSnapshot(source));

  const root = await mkdtemp(join(tmpdir(), "state-runtime-snapshot-"));
  try {
    const target = await Effect.runPromise(
      openNodeSqliteStateStore({
        projectId: "assistant",
        path: join(root, "assistant.sqlite3")
      })
    );

    const restored = await Effect.runPromise(
      restoreStateRuntimeSnapshotToEmpty(target, snapshot)
    );

    assert.deepEqual(restored, pointer);
    assert.equal((await Effect.runPromise(target.verify)).generation, 1);
    assert.deepEqual(
      await Effect.runPromise(exportStateRuntimeSnapshot(target)),
      snapshot
    );

    await Effect.runPromise(target.close);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portable snapshot rejects cross-project restore and tampering before current advances", async () => {
  const source = await Effect.runPromise(makeMemoryStateStore("assistant"));
  await seedStore(source);
  const snapshot = await Effect.runPromise(exportStateRuntimeSnapshot(source));

  const foreign = await Effect.runPromise(makeMemoryStateStore("agent"));
  const foreignExit = await Effect.runPromiseExit(
    restoreStateRuntimeSnapshotToEmpty(foreign, snapshot)
  );
  assert.equal(foreignExit._tag, "Failure");
  assert.equal(await Effect.runPromise(foreign.current), null);

  const target = await Effect.runPromise(makeMemoryStateStore("assistant"));
  const tampered = {
    ...snapshot,
    payload: {
      ...snapshot.payload,
      records: snapshot.payload.records.map((record, index) =>
        index === 0
          ? { ...record, canonicalJson: record.canonicalJson + " " }
          : record
      )
    }
  };

  const tamperedExit = await Effect.runPromiseExit(
    restoreStateRuntimeSnapshotToEmpty(target, tampered)
  );
  assert.equal(tamperedExit._tag, "Failure");
  assert.equal(await Effect.runPromise(target.current), null);
});


test("snapshot replacement rebases active SQLite history without retained forgotten bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "state-runtime-replace-"));
  const path = join(root, "assistant.sqlite3");
  try {
    const original = await Effect.runPromise(
      openNodeSqliteStateStore({ projectId: "assistant", path })
    );

    const forgotten = makeRecord(
      "assistant",
      "conversation:forgotten",
      "conversation",
      { text: "SECRET_FORGET_ME_4baf56f2" }
    );
    const forgottenDigest = await Effect.runPromise(original.putRecord(forgotten));
    const oldMap = makeStateMap({
      project: "assistant",
      generation: 0,
      parent: null,
      compiler: "replace-test/v1",
      sourceDigest: semanticDigest({ old: true }),
      entries: {
        [forgotten.id]: { kind: forgotten.kind, record: forgottenDigest }
      }
    });
    const oldMapDigest = await Effect.runPromise(original.putMap(oldMap));
    await Effect.runPromise(
      original.compareAndSwapCurrent(
        null,
        makePointer("assistant", 0, oldMapDigest)
      )
    );
    await Effect.runPromise(original.close);

    const retained = await Effect.runPromise(makeMemoryStateStore("assistant"));
    const kept = makeRecord(
      "assistant",
      "conversation:kept",
      "conversation",
      { text: "keep me" }
    );
    const keptDigest = await Effect.runPromise(retained.putRecord(kept));
    const newMap = makeStateMap({
      project: "assistant",
      generation: 0,
      parent: null,
      compiler: "replace-test/v2",
      sourceDigest: semanticDigest({ rebased: true }),
      entries: {
        [kept.id]: { kind: kept.kind, record: keptDigest }
      }
    });
    const newMapDigest = await Effect.runPromise(retained.putMap(newMap));
    await Effect.runPromise(
      retained.compareAndSwapCurrent(
        null,
        makePointer("assistant", 0, newMapDigest)
      )
    );
    const sanitized = await Effect.runPromise(
      exportStateRuntimeSnapshot(retained)
    );

    await Effect.runPromise(
      replaceNodeSqliteDatabaseFromSnapshot(sanitized, path)
    );

    const reopened = await Effect.runPromise(
      openNodeSqliteStateStore({ projectId: "assistant", path })
    );
    const health = await Effect.runPromise(reopened.verify);
    assert.equal(health.entries, 1);
    assert.equal(health.generation, 0);
    const exported = await Effect.runPromise(
      exportStateRuntimeSnapshot(reopened)
    );
    assert.equal(
      JSON.stringify(exported).includes("SECRET_FORGET_ME_4baf56f2"),
      false
    );
    await Effect.runPromise(reopened.close);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
