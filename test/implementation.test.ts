import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";

import {
  STATE_STORE_INTERFACE,
  memoryStateImplementation,
  openStateImplementation,
  makeRecord,
  makeStateMap,
  recordDigest,
  semanticDigest,
  exportStateRuntimeSnapshot,
  restoreStateRuntimeSnapshotToEmpty,
  type StateImplementationBinding
} from "../src/index.js";
import { nodeSqliteStateImplementation } from "../src/adapters/node-sqlite.js";

const binding = (driver: string): StateImplementationBinding => ({
  schema: "state.implementation-binding/v1",
  projectId: "portable",
  interface: STATE_STORE_INTERFACE,
  driver,
  requiredCapabilities: ["atomic-commit", "verified-history"],
  authority: "none",
});

const adapters = [memoryStateImplementation, nodeSqliteStateImplementation] as const;

test("a consumer can choose the memory driver using the same portable State interface", async () => {
  const store = await Effect.runPromise(openStateImplementation(
    binding("memory"), adapters, null
  ));
  assert.equal(store.mechanismId, "memory");
  assert.equal(store.projectId, "portable");
  assert.equal(await Effect.runPromise(store.current), null);
  await Effect.runPromise(store.close);
});

test("explicit implementation lookup fails closed and cannot silently fall back", async () => {
  const invalid = [
    [binding("postgresql"), adapters, null, "missing-driver"],
    [binding("memory"), [memoryStateImplementation, memoryStateImplementation], null, "duplicate-driver"],
    [binding("memory"), adapters, { path: ":memory:" }, "invalid-configuration"],
    [{ ...binding("memory"), authority: "execute" }, adapters, null, "invalid-binding"],
    [{ ...binding("memory"), requiredCapabilities: ["unproven-storage-law"] }, adapters, null, "missing-capability"],
    [{ ...binding("memory"), requiredCapabilities: ["atomic-commit", "atomic-commit"] }, adapters, null, "invalid-binding"],
  ] as const;
  for (const [selected, choices, config, reason] of invalid) {
    const result = await Effect.runPromiseExit(openStateImplementation(
      selected as StateImplementationBinding, choices, config
    ));
    assert.equal(result._tag, "Failure", reason);
    if (result._tag === "Failure") {
      assert.match(String(result.cause), new RegExp(reason));
    }
  }
});

test("an explicit SQLite adapter preserves the StateMap identity across verified memory-to-SQLite migration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "state-implementation-"));
  const source = await Effect.runPromise(openStateImplementation(binding("memory"), adapters, null));
  try {
    const record = makeRecord("portable", "item:1", "example/v1", { current: true });
    const map = makeStateMap({
      project: "portable",
      generation: 0,
      parent: null,
      compiler: "example/v1",
      sourceDigest: semanticDigest({ source: "fixture" }),
      entries: {
        "item:1": { kind: record.kind, record: recordDigest(record) },
      }
    });
    const pointer = await Effect.runPromise(source.commit({ expected: null, records: [record], map }));
    const snapshot = await Effect.runPromise(exportStateRuntimeSnapshot(source));

    const target = await Effect.runPromise(openStateImplementation(
      binding("node-sqlite"), adapters, { path: join(dir, "state.sqlite3") }
    ));
    try {
      assert.equal(await Effect.runPromise(target.current), null);
      const restored = await Effect.runPromise(restoreStateRuntimeSnapshotToEmpty(target, snapshot));
      assert.deepEqual(restored, pointer);
      const verification = await Effect.runPromise(target.verifyHistory);
      assert.equal(verification.generation, 0);
      assert.equal(verification.map, pointer.map);
      const repeat = await Effect.runPromise(exportStateRuntimeSnapshot(target));
      assert.equal(repeat.payloadDigest, snapshot.payloadDigest);
    } finally {
      await Effect.runPromise(target.close);
    }
  } finally {
    await Effect.runPromise(source.close);
    await rm(dir, { recursive: true, force: true });
  }
});
