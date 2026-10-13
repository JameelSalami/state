import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA,
  STATE_RUNTIME_BRIDGE_RESPONSE_SCHEMA
} from "../src/stdio-protocol.js";

const sidecar = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "stdio.js"
);

const call = (
  project: string,
  path: string,
  request: Record<string, unknown>
): Record<string, unknown> => {
  const result = spawnSync(
    process.execPath,
    [sidecar, "--project", project, "--path", path],
    {
      input: JSON.stringify(request),
      encoding: "utf8"
    }
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
};

test("stdio bridge exposes State Runtime without leaking SQLite semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "state-runtime-stdio-"));
  const path = join(root, "forge.sqlite3");
  const project = "forge-cad:test";
  try {
    const recordResponse = call(project, path, {
      schema: STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA,
      operation: "put_record",
      record: {
        schema: "state-runtime.record/v1",
        project,
        id: "document:current",
        kind: "forge.authoritative-document/v1",
        value: { source_sha256: "a".repeat(64), document: { version: 0 } }
      }
    });
    assert.equal(recordResponse.schema, STATE_RUNTIME_BRIDGE_RESPONSE_SCHEMA);
    assert.equal(recordResponse._tag, "Ok");
    const recordDigest = String(recordResponse.value);

    const mapResponse = call(project, path, {
      schema: STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA,
      operation: "put_map",
      map: {
        schema: "state-runtime.statemap/v1",
        project,
        generation: 0,
        parent: null,
        compiler: "forge-cad.state-map/v1",
        sourceDigest: `sha256:${"b".repeat(64)}`,
        entries: {
          "document:current": {
            kind: "forge.authoritative-document/v1",
            record: recordDigest
          }
        }
      }
    });
    assert.equal(mapResponse._tag, "Ok");
    const mapDigest = String(mapResponse.value);

    const cas = call(project, path, {
      schema: STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA,
      operation: "compare_and_swap_current",
      expected: null,
      next: {
        schema: "state-runtime.pointer/v1",
        project,
        generation: 0,
        map: mapDigest
      }
    });
    assert.equal(cas._tag, "Ok");

    const current = call(project, path, {
      schema: STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA,
      operation: "current"
    });
    assert.deepEqual(current.value, {
      schema: "state-runtime.pointer/v1",
      project,
      generation: 0,
      map: mapDigest
    });

    const verify = call(project, path, {
      schema: STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA,
      operation: "verify"
    });
    assert.equal(verify._tag, "Ok");
    assert.equal((verify.value as Record<string, unknown>).state, "Healthy");
    assert.equal("scope" in (verify.value as Record<string, unknown>), false);

    const conflict = call(project, path, {
      schema: STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA,
      operation: "compare_and_swap_current",
      expected: null,
      next: {
        schema: "state-runtime.pointer/v1",
        project,
        generation: 0,
        map: mapDigest
      }
    });
    assert.equal(conflict._tag, "Refused");
    assert.equal(conflict.code, "conflict");
    assert.equal(conflict.observedGeneration, 0);

    const invalid = call(project, path, {
      schema: STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA,
      operation: "current",
      sqlite: "must-not-leak"
    });
    assert.equal(invalid._tag, "Refused");
    assert.equal(invalid.code, "invalid-request");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
