import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeSqliteStateStore, replaceNodeSqliteDatabaseFromSnapshot } from "../src/adapters/node-sqlite.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import {
  commitDisjointStateChanges, prepareStateCheckpoint,
  makeMemoryStateStore, makeRecord, makePointer, makeStateMap,
  semanticDigest, restoreStateRuntimeSnapshotToEmpty
} from "../src/index.js";

const digest = semanticDigest({ test: "disjoint-checkpoint" });
const mk = (id: string, value: number) => makeRecord("demo", id, "demo.record/v1", { value });

test("disjoint concurrent commits rebase unrelated keys and refuse touched-key overwrites", async () => {
  const store = await Effect.runPromise(makeMemoryStateStore("demo"));
  const initial = await Effect.runPromise(commitDisjointStateChanges(store, {
    expected: null, records: [mk("a", 0)], compiler: "test", sourceDigest: digest
  }));
  const alice = await Effect.runPromise(commitDisjointStateChanges(store, {
    expected: initial, records: [mk("b", 1)], compiler: "test", sourceDigest: digest
  }));
  assert.equal(alice.generation, 1);
  const bob = await Effect.runPromise(commitDisjointStateChanges(store, {
    expected: initial, records: [mk("c", 2)], compiler: "test", sourceDigest: digest
  }));
  assert.equal(bob.generation, 2);
  assert.deepEqual((await Effect.runPromise(store.getCurrentEntry("b")))?.record.value.value, { value: 1 });
  assert.deepEqual((await Effect.runPromise(store.getCurrentEntry("c")))?.record.value.value, { value: 2 });
  const sameKey = await Effect.runPromise(Effect.either(commitDisjointStateChanges(store, {
    expected: initial, records: [mk("b", 9)], compiler: "test", sourceDigest: digest
  })));
  assert.equal(sameKey._tag, "Left");
  assert.match(String(sameKey._tag === "Left" ? sameKey.left : ""), /record changed since base/);
  assert.equal((await Effect.runPromise(store.current))?.map, bob.map);
  const orphanMap = makeStateMap({
    project: "demo", generation: 0, parent: null,
    compiler: "unrelated", sourceDigest: digest, entries: {}
  });
  const orphanDigest = await Effect.runPromise(store.putMap(orphanMap));
  const falseBase = await Effect.runPromise(Effect.either(commitDisjointStateChanges(store, {
    expected: makePointer("demo", 0, orphanDigest),
    records: [mk("unrelated", 7)], compiler: "test", sourceDigest: digest
  })));
  assert.equal(falseBase._tag,"Left");
  assert.match(String(falseBase._tag === "Left" ? falseBase.left : ""), /not an ancestor/);
  const reserved = await Effect.runPromise(Effect.either(commitDisjointStateChanges(store, {
    expected: bob, records: [mk("__proto__", 1)], compiler: "test", sourceDigest: digest
  })));
  assert.equal(reserved._tag,"Left");
  const history = await Effect.runPromise(store.verifyHistory);
  assert.equal(history.maps, 3);
  await Effect.runPromise(store.close);
});

test("explicit checkpoint drops historical maps without changing the materialized records", async () => {
  const store = await Effect.runPromise(makeMemoryStateStore("demo"));
  let latest = await Effect.runPromise(commitDisjointStateChanges(store, {
    expected: null, records: [mk("one", 1)], compiler: "test", sourceDigest: digest
  }));
  for (let i = 0; i < 8; i++) {
    latest = await Effect.runPromise(commitDisjointStateChanges(store, {
      expected: latest, records: [mk("one", i + 2)], compiler: "test", sourceDigest: digest
    }));
  }
  const old = await Effect.runPromise(store.verifyHistory);
  assert.equal(old.maps, 9);
  const proposal = await Effect.runPromise(prepareStateCheckpoint(store));
  assert.equal(proposal.droppedHistoricalGenerations, 8);
  assert.equal(proposal.snapshot.payload.maps.length, 1);
  assert.equal(proposal.snapshot.payload.records.length, 1);
  assert.notEqual(proposal.snapshot.payload.current?.map, latest.map);
  assert.equal((await Effect.runPromise(store.current))?.map, latest.map);

  const replacement = await Effect.runPromise(makeMemoryStateStore("demo"));
  await Effect.runPromise(restoreStateRuntimeSnapshotToEmpty(replacement, proposal.snapshot));
  assert.equal((await Effect.runPromise(replacement.verifyHistory)).maps, 1);
  assert.deepEqual((await Effect.runPromise(replacement.getCurrentEntry("one")))?.record.value.value, { value: 9 });
  await Effect.runPromise(store.close);
  await Effect.runPromise(replacement.close);
});

test("explicit SQLite checkpoint replacement retains current data but stores one map", async () => {
  const dir = await mkdtemp(join(tmpdir(), "state-checkpoint-sqlite-"));
  const file = join(dir,"live.sqlite3");
  try {
    const store = await Effect.runPromise(openNodeSqliteStateStore({projectId:"demo",path:file}));
    let pointer = await Effect.runPromise(commitDisjointStateChanges(store,{
      expected:null, records:[mk("one",1)], sourceDigest:digest, compiler:"checkpoint-test"
    }));
    for (let i=2;i<=12;i++){
      pointer=await Effect.runPromise(commitDisjointStateChanges(store,{
        expected:pointer, records:[mk("one",i)], sourceDigest:digest, compiler:"checkpoint-test"
      }));
    }
    const proposal=await Effect.runPromise(prepareStateCheckpoint(store));
    assert.equal((await Effect.runPromise(store.verifyHistory)).maps,12);
    await Effect.runPromise(store.close);
    const before=new DatabaseSync(file);
    const oldCount=before.prepare("SELECT COUNT(*) AS n FROM state_maps").get() as {n:number};
    before.close();
    assert.equal(oldCount.n,12);
    await Effect.runPromise(replaceNodeSqliteDatabaseFromSnapshot(proposal.snapshot,file));
    const after=new DatabaseSync(file);
    const newCount=after.prepare("SELECT COUNT(*) AS n FROM state_maps").get() as {n:number};
    after.close();
    assert.equal(newCount.n,1);
    const reopened=await Effect.runPromise(openNodeSqliteStateStore({projectId:"demo",path:file}));
    assert.equal((await Effect.runPromise(reopened.verifyHistory)).maps,1);
    assert.deepEqual((await Effect.runPromise(reopened.getCurrentEntry("one")))?.record.value.value,{value:12});
    assert.notEqual((await Effect.runPromise(reopened.current))?.map,pointer.map);
    await Effect.runPromise(reopened.close);
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});
