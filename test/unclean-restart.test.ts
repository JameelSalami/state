import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { Effect } from "effect";

import { openNodeSqliteStateStore } from "../src/adapters/node-sqlite.js";

const distRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("SQLite WAL recovers a committed StateMap after an unclean SIGKILL", async () => {
  const root = await mkdtemp(join(tmpdir(), "state-runtime-crash-"));
  const path = join(root, "assistant.sqlite3");
  const indexUrl = pathToFileURL(join(distRoot, "src", "index.js")).href;
  const sqliteUrl = pathToFileURL(
    join(distRoot, "src", "adapters", "node-sqlite.js")
  ).href;
  const effectUrl = pathToFileURL(
    join(process.cwd(), "node_modules", "effect", "dist", "esm", "index.js")
  ).href;

  const childCode = `
    import { Effect } from ${JSON.stringify(effectUrl)};
    import {
      makeRecord,
      makeStateMap,
      makePointer,
      semanticDigest
    } from ${JSON.stringify(indexUrl)};
    import { openNodeSqliteStateStore } from ${JSON.stringify(sqliteUrl)};

    const store = await Effect.runPromise(
      openNodeSqliteStateStore({
        projectId: "assistant",
        path: ${JSON.stringify(path)}
      })
    );

    const record = makeRecord(
      "assistant",
      "conversation:crash",
      "conversation",
      { text: "committed" }
    );
    const recordDigest = await Effect.runPromise(store.putRecord(record));
    const map = makeStateMap({
      project: "assistant",
      generation: 0,
      parent: null,
      compiler: "crash-test/v1",
      sourceDigest: semanticDigest({ crash: true }),
      entries: {
        [record.id]: { kind: record.kind, record: recordDigest }
      }
    });
    const mapDigest = await Effect.runPromise(store.putMap(map));
    await Effect.runPromise(
      store.compareAndSwapCurrent(
        null,
        makePointer("assistant", 0, mapDigest)
      )
    );

    process.stdout.write("COMMITTED\\n");
    setInterval(() => {}, 1000);
  `;

  try {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", childCode],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    await new Promise<void>((resolve, reject) => {
      let output = "";
      let stderr = "";

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
        if (output.includes("COMMITTED")) resolve();
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });

      child.once("exit", (code) => {
        if (!output.includes("COMMITTED")) {
          reject(
            new Error(
              `child exited before commit: code=${code}, stderr=${stderr}`
            )
          );
        }
      });
    });

    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));

    const reopened = await Effect.runPromise(
      openNodeSqliteStateStore({ projectId: "assistant", path })
    );

    const health = await Effect.runPromise(reopened.verify);
    assert.equal(health.generation, 0);
    assert.equal(health.entries, 1);
    assert.equal(
      (await Effect.runPromise(reopened.current))?.generation,
      0
    );

    await Effect.runPromise(reopened.close);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
