import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { semanticDigest, type JsonValue } from "../src/canonical.js";

const golden = JSON.parse(readFileSync(new URL("../../test/portability-digests.v1.json", import.meta.url), "utf8")) as {
  readonly json: readonly { name: string; value: JsonValue; state: string }[];
};

test("State v1 digests remain byte-for-byte compatible with the frozen Node implementation", () => {
  for (const item of golden.json) {
    assert.equal(semanticDigest(item.value), item.state, item.name);
  }
});