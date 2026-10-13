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
  mapDigest,
  canonicalJson,
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


test("restore-to-empty refuses nonempty target before importing any source bytes", async () => {
  const source = await Effect.runPromise(makeMemoryStateStore("assistant"));
  await seedStore(source);
  const exported = await Effect.runPromise(exportStateRuntimeSnapshot(source));

  const target = await Effect.runPromise(makeMemoryStateStore("assistant"));
  const original = makeRecord("assistant", "target-only", "kind", { value: "keep" });
  const record = await Effect.runPromise(target.putRecord(original));
  const existingMap = makeStateMap({
    project: "assistant", generation: 0, parent: null,
    compiler: "test-preoccupied", sourceDigest: semanticDigest({ occupied: true }),
    entries: { [original.id]: { kind: original.kind, record } }
  });
  const existingDigest = await Effect.runPromise(target.putMap(existingMap));
  const existing = makePointer("assistant", 0, existingDigest);
  await Effect.runPromise(target.compareAndSwapCurrent(null, existing));

  const exit = await Effect.runPromiseExit(restoreStateRuntimeSnapshotToEmpty(target, exported));
  assert.equal(exit._tag, "Failure");
  assert.deepEqual(await Effect.runPromise(target.current), existing);
  // A failed restore must not import records or maps into the occupied store.
  const unseen = exported.payload.maps.find(entry => entry.digest !== existingDigest)!;
  const imported = await Effect.runPromise(Effect.either(target.getMap(unseen.digest)));
  assert.equal(imported._tag, "Left");
  assert.equal((await Effect.runPromise(target.verifyHistory)).generation, 0);
  await Effect.runPromise(source.close);
  await Effect.runPromise(target.close);
});

test("snapshot with a generation gap is refused before writing immutable maps", async () => {
  const genesis = makeStateMap({
    project: "assistant", generation: 0, parent: null,
    compiler: "gap-test", sourceDigest: semanticDigest({ version: 0 }), entries: {}
  });
  const baseDigest = mapDigest(genesis);
  const jumped = makeStateMap({
    project: "assistant", generation: 2, parent: baseDigest,
    compiler: "gap-test", sourceDigest: semanticDigest({ version: 2 }), entries: {}
  });
  const jumpDigest = mapDigest(jumped);
  const payload = {
    current: makePointer("assistant", 2, jumpDigest),
    records: [],
    maps: [
      { digest: baseDigest, canonicalJson: canonicalJson(genesis as never) },
      { digest: jumpDigest, canonicalJson: canonicalJson(jumped as never) }
    ].sort((a,b) => a.digest.localeCompare(b.digest))
  };
  const forged = {
    schema: "state-runtime.snapshot/v1" as const,
    project: "assistant",
    payload,
    payloadDigest: semanticDigest(payload as never)
  };
  const target = await Effect.runPromise(makeMemoryStateStore("assistant"));
  const outcome = await Effect.runPromise(
    Effect.either(restoreStateRuntimeSnapshotToEmpty(target, forged))
  );
  assert.equal(outcome._tag, "Left");
  if (outcome._tag === "Left") {
    // Snapshot validation must name a generation gap rather than relying on
    // later traversal/install checks to reject the malformed history.
    assert.match(String(outcome.left), /snapshot StateMap generations are not continuous/);
  }
  assert.deepEqual(await Effect.runPromise(target.current), null);
  // Guard must run BEFORE putMap writes anything (not merely reject installation).
  const uploaded = await Effect.runPromise(Effect.either(target.getMap(jumpDigest)));
  assert.equal(uploaded._tag, "Left");
  const root = await Effect.runPromise(Effect.either(target.getMap(baseDigest)));
  assert.equal(root._tag, "Left");
  await Effect.runPromise(target.close);
});


test("installVerifiedHistory refuses a preoccupied memory store, even for an existing valid pointer", async () => {
  const target = await Effect.runPromise(makeMemoryStateStore("assistant"));
  const existing = await seedStore(target);
  const outcome = await Effect.runPromise(Effect.either(target.installVerifiedHistory(existing)));
  assert.equal(outcome._tag, "Left", "only an EMPTY target may install historical state");
  if (outcome._tag === "Left") {
    assert.match(String(outcome.left), /verified history installation requires an empty target store/);
  }
  assert.deepEqual(await Effect.runPromise(target.current), existing);
  await Effect.runPromise(target.close);
});
