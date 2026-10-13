import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Effect } from "effect";

import {
  makeMemoryStateStore,
  makePointer,
  makeRecord,
  makeStateMap,
  semanticDigest,
  type StateRuntimeStore
} from "../src/index.js";
import { backupNodeSqliteDatabase, openNodeSqliteStateStore } from "../src/adapters/node-sqlite.js";

const exercise = async (
  store: StateRuntimeStore,
  projectId: string
): Promise<{ readonly firstRecordDigest: string; readonly currentMapDigest: string }> => {
  const first = makeRecord(projectId, "conversation:1", "conversation", {
    state: "active",
    title: "hello"
  });
  const firstDigest = await Effect.runPromise(store.putRecord(first));

  const map0 = makeStateMap({
    project: projectId,
    generation: 0,
    parent: null,
    compiler: "test-compiler/v1",
    sourceDigest: semanticDigest({ source: "generation-0" }),
    entries: {
      [first.id]: {
        kind: first.kind,
        record: firstDigest
      }
    }
  });
  const map0Digest = await Effect.runPromise(store.putMap(map0));
  const pointer0 = makePointer(projectId, 0, map0Digest);
  await Effect.runPromise(store.compareAndSwapCurrent(null, pointer0));

  const loadedRecord = await Effect.runPromise(store.getRecord(firstDigest));
  assert.deepEqual(loadedRecord.value, first);
  assert.deepEqual(await Effect.runPromise(store.current), pointer0);

  const second = makeRecord(projectId, "invocation:1", "invocation", {
    state: "executing",
    attempt: "a1"
  });
  const secondDigest = await Effect.runPromise(store.putRecord(second));
  const map1 = makeStateMap({
    project: projectId,
    generation: 1,
    parent: map0Digest,
    compiler: "test-compiler/v1",
    sourceDigest: semanticDigest({ source: "generation-1" }),
    entries: {
      [first.id]: {
        kind: first.kind,
        record: firstDigest
      },
      [second.id]: {
        kind: second.kind,
        record: secondDigest
      }
    }
  });
  const map1Digest = await Effect.runPromise(store.putMap(map1));
  const pointer1 = makePointer(projectId, 1, map1Digest);
  await Effect.runPromise(store.compareAndSwapCurrent(pointer0, pointer1));

  const staleExit = await Effect.runPromiseExit(
    store.compareAndSwapCurrent(pointer0, pointer1)
  );
  assert.equal(staleExit._tag, "Failure");
  if (staleExit._tag === "Failure") {
    assert.match(String(staleExit.cause), /StateRuntimeConflict/);
  }

  const health = await Effect.runPromise(store.verify);
  assert.equal(health.state, "Healthy");
  assert.equal(health.project, projectId);
  assert.equal(health.generation, 1);
  assert.equal(health.entries, 2);

  const history = await Effect.runPromise(store.history());
  assert.deepEqual(history.map((entry) => entry.generation), [1, 0]);

  return {
    firstRecordDigest: firstDigest,
    currentMapDigest: map1Digest
  };
};

test("MemoryStateStore implements the shared State Runtime contract", async () => {
  const store = await Effect.runPromise(makeMemoryStateStore("assistant"));
  await exercise(store, "assistant");
  await Effect.runPromise(store.close);
});

test("NodeSqliteStateStore implements the same contract and survives restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "state-runtime-sqlite-"));
  const path = join(root, "assistant.sqlite3");
  try {
    let store = await Effect.runPromise(
      openNodeSqliteStateStore({ projectId: "assistant", path })
    );
    const expected = await exercise(store, "assistant");
    await Effect.runPromise(store.close);

    store = await Effect.runPromise(
      openNodeSqliteStateStore({ projectId: "assistant", path })
    );
    const health = await Effect.runPromise(store.verify);
    assert.equal(health.generation, 1);
    assert.equal(health.map, expected.currentMapDigest);
    const current = await Effect.runPromise(store.current);
    assert.equal(current?.generation, 1);
    await Effect.runPromise(store.close);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one SQLite file still isolates project namespaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "state-runtime-isolation-"));
  const path = join(root, "shared-engine.sqlite3");
  try {
    const assistant = await Effect.runPromise(
      openNodeSqliteStateStore({ projectId: "assistant", path })
    );
    const agent = await Effect.runPromise(
      openNodeSqliteStateStore({ projectId: "agent", path })
    );

    await exercise(assistant, "assistant");
    assert.equal(await Effect.runPromise(agent.current), null);

    await exercise(agent, "agent");
    assert.equal((await Effect.runPromise(assistant.verify)).project, "assistant");
    assert.equal((await Effect.runPromise(agent.verify)).project, "agent");

    await Effect.runPromise(assistant.close);
    await Effect.runPromise(agent.close);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite corruption fails closed instead of manufacturing a healthy StateMap", async () => {
  const root = await mkdtemp(join(tmpdir(), "state-runtime-corrupt-"));
  const path = join(root, "assistant.sqlite3");
  try {
    const store = await Effect.runPromise(
      openNodeSqliteStateStore({ projectId: "assistant", path })
    );
    const expected = await exercise(store, "assistant");
    await Effect.runPromise(store.close);

    const db = new DatabaseSync(path);
    db.prepare(
      "UPDATE state_records SET canonical_json = ? WHERE project = ? AND digest = ?"
    ).run(
      JSON.stringify({
        schema: "state-runtime.record/v1",
        project: "assistant",
        id: "conversation:1",
        kind: "conversation",
        value: { state: "fabricated" }
      }),
      "assistant",
      expected.firstRecordDigest
    );
    db.close();

    const reopened = await Effect.runPromise(
      openNodeSqliteStateStore({ projectId: "assistant", path })
    );
    const exit = await Effect.runPromiseExit(reopened.verify);
    assert.equal(exit._tag, "Failure");
    await Effect.runPromise(reopened.close);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("Node SQLite online backup captures a live committed StateMap", async () => {
  const root = await mkdtemp(join(tmpdir(), "state-runtime-backup-"));
  const sourcePath = join(root, "assistant.sqlite3");
  const backupPath = join(root, "assistant.backup.sqlite3");
  try {
    const source = await Effect.runPromise(
      openNodeSqliteStateStore({ projectId: "assistant", path: sourcePath })
    );
    await exercise(source, "assistant");

    const pages = await Effect.runPromise(
      backupNodeSqliteDatabase(sourcePath, backupPath)
    );
    assert.equal(pages > 0, true);

    const restored = await Effect.runPromise(
      openNodeSqliteStateStore({ projectId: "assistant", path: backupPath })
    );
    const health = await Effect.runPromise(restored.verify);
    assert.equal(health.generation, 1);
    assert.equal(health.entries, 2);

    await Effect.runPromise(restored.close);
    await Effect.runPromise(source.close);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
