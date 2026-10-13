import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import {
  describeStateImplementations,
  memoryStateImplementation,
  type StateImplementationAdapter,
} from "../src/index.js";
import { nodeSqliteStateImplementation } from "../src/adapters/node-sqlite.js";

test("State adapters advertise declarative manifests without opening user storage", () => {
  let opened = false;
  const thirdParty: StateImplementationAdapter = {
    id: "user.provider",
    version: "1.2.3",
    capabilities: memoryStateImplementation.capabilities,
    requiredChecks: ["atomic-commit", "cas-conflict", "history-verification", "snapshot-roundtrip"],
    configurationSchemaDigest: null,
    open: () => { opened = true; return Effect.die("must not be invoked"); },
  };
  const result = describeStateImplementations([thirdParty, memoryStateImplementation, nodeSqliteStateImplementation]);
  assert.equal(result._tag, "StateImplementationDiscovery");
  assert.equal(opened, false);
  if (result._tag !== "StateImplementationDiscovery") return;
  assert.deepEqual(result.contributions.map((item) => item.id),
    ["memory", "node-sqlite", "user.provider"]);
  assert.ok(result.contributions.every((item) => item.authority === "none"));
  assert.ok(result.contributions.every((item) => item.schema === "contract.extension-manifest/v1"));
  assert.ok(result.contributions.every((item) => item.interface.id === "state/StateRuntimeStore"));
  assert.ok(result.contributions.every((item) => item.interface.version === "v1"));
});

test("only adapters declaring the complete State core laws can be discovered", () => {
  const broken: StateImplementationAdapter = {
    ...memoryStateImplementation,
    version: "1.0.0",
    capabilities: ["atomic-commit"],
  };
  assert.deepEqual(describeStateImplementations([broken]), {
    _tag: "Refusal", reason: "invalid-implementation-catalog",
  });
  assert.equal(describeStateImplementations([memoryStateImplementation, memoryStateImplementation])._tag,
    "Refusal");
  assert.equal(describeStateImplementations([
    { ...memoryStateImplementation, version: "latest" }
  ])._tag, "Refusal");
  assert.equal(describeStateImplementations([
    { ...memoryStateImplementation, requiredChecks: [] }
  ])._tag, "Refusal");
  assert.equal(describeStateImplementations([
    { ...memoryStateImplementation, requiredChecks: ["always-green"] }
  ])._tag, "Refusal");
  assert.equal(describeStateImplementations([
    { ...memoryStateImplementation,
      capabilities: [...memoryStateImplementation.capabilities, "durable-restart"] }
  ])._tag, "Refusal");
  assert.equal(describeStateImplementations([
    { ...memoryStateImplementation, version: "1.0.0", configurationSchemaDigest: "bad" }
  ])._tag, "Refusal");
});