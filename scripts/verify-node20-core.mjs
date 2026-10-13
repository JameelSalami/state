import assert from "node:assert/strict";
import { Effect } from "effect";
import { makeMemoryStateStore, semanticDigest } from "../dist/src/index.js";
import { STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA } from "../dist/src/stdio-protocol.js";

// Node 20 supports the portable State API but not the optional node:sqlite
// adapter or state-stdio CLI. Do not import those here.
assert.match(process.version, /^v20\./);
assert.match(semanticDigest({ a: 1 }), /^sha256:[0-9a-f]{64}$/);
assert.equal(STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA, "state-runtime.bridge-request/v1");
const store = await Effect.runPromise(makeMemoryStateStore("node20-portable"));
assert.equal(await Effect.runPromise(store.current), null);
await Effect.runPromise(store.close);
console.log("State portable Node 20 core PASS");
