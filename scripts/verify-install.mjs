#!/usr/bin/env node
// Source-only release preflight: packages State and installs the tarball in an
// unrelated consumer. No registry publishing and no sibling checkout.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const name = "@durable-systems/state";
const info = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (info.name !== name || info.version !== "0.1.0" || info.private !== true) {
  throw Error("unexpected State source identity or safety flag");
}
const scratch = mkdtempSync(join(tmpdir(), "state-independent-consumer-"));
let completed = false;
function execute(bin, args, cwd, input) {
  const r = spawnSync(bin, args, {
    cwd, input, encoding: "utf8", timeout: 240000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
  });
  if (r.error || r.status !== 0) {
    throw Error([bin + " " + args.join(" "), "cwd=" + cwd,
      "exit=" + r.status, r.error?.message ?? "",
      (r.stdout ?? "").slice(-2000), (r.stderr ?? "").slice(-2200)].join("\n"));
  }
  return r.stdout.trim();
}
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
try {
  const filename = execute("npm", ["pack", "--ignore-scripts=false", "--silent", "--pack-destination", scratch], root)
    .split("\n").at(-1);
  if (filename !== "durable-systems-state-0.1.0.tgz") throw Error("unexpected archive name");
  const tarball = join(scratch, filename);
  const entries = execute("tar", ["-tzf", tarball], scratch).split("\n").filter(Boolean);
  const explicit = ["package/package.json", "package/README.md", "package/LICENSE"];
  for (const entry of entries) {
    if (!(explicit.includes(entry) || entry.startsWith("package/dist/src/"))) {
      throw Error("Unexpected archive entry: " + entry);
    }
    if (entry.includes("..") || entry.includes(".env") || entry.includes(".git/") ||
        entry.includes("node_modules/") || entry.includes("vendor/")) throw Error("Unsafe tar entry: " + entry);
  }
  for (const entry of [...explicit, "package/dist/src/index.js", "package/dist/src/index.d.ts",
    "package/dist/src/adapters/node-sqlite.js", "package/dist/src/adapters/node-sqlite.d.ts",
    "package/dist/src/stdio-protocol.js", "package/dist/src/stdio-protocol.d.ts",
    "package/dist/src/stdio.js"]) {
    if (!entries.includes(entry)) throw Error("Missing tar member: " + entry);
  }
  const packaged = JSON.parse(execute("tar", ["-xOzf", tarball, "package/package.json"], scratch));
  if (packaged.name !== name || packaged.peerDependencies?.effect !== "3.22.2" ||
      packaged.bin?.["state-stdio"] !== "./dist/src/stdio.js") throw Error("State release manifest mismatch");
  const consumer = join(scratch, "consumer");
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({
    name: "unrelated-state-tarball-consumer", version: "1.0.0", private: true, type: "module",
  }) + "\n");
  execute("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact",
    tarball, "effect@3.22.2", "typescript@5.9.3", "@types/node@22.20.4"], consumer);
  const installed = join(consumer, "node_modules", "@durable-systems", "state");
  if (!existsSync(installed) || lstatSync(installed).isSymbolicLink()) throw Error("not a real tarball install");
  const resolved = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  if (resolved.name !== name || resolved.peerDependencies?.effect !== "3.22.2") {
    throw Error("installed State identity / peer mismatch");
  }
  execute("npm", ["ls", "--depth=0"], consumer);
  writeFileSync(join(consumer, "smoke.mjs"), `
import { Effect } from "effect";
import { semanticDigest, makeMemoryStateStore } from "@durable-systems/state";
import { openNodeSqliteStateStore } from "@durable-systems/state/node-sqlite";
import { STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA, STATE_RUNTIME_BRIDGE_RESPONSE_SCHEMA } from "@durable-systems/state/stdio-protocol";
if (!/^sha256:[0-9a-f]{64}$/.test(semanticDigest({b:2,a:1}))) throw Error("digest");
const store = await Effect.runPromise(makeMemoryStateStore("tarball-test"));
if ((await Effect.runPromise(store.current)) !== null) throw Error("memory");
await Effect.runPromise(store.close);
if (typeof openNodeSqliteStateStore !== "function" ||
  STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA !== "state-runtime.bridge-request/v1" ||
  STATE_RUNTIME_BRIDGE_RESPONSE_SCHEMA !== "state-runtime.bridge-response/v1") throw Error("subpath exports");
`);
  writeFileSync(join(consumer, "smoke.mts"), `
import { semanticDigest, makeMemoryStateStore, type StateRuntimeStore, type SemanticDigest } from "@durable-systems/state";
import { openNodeSqliteStateStore, type NodeSqliteStateStoreOptions } from "@durable-systems/state/node-sqlite";
import { STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA, type StateRuntimeBridgeRequest } from "@durable-systems/state/stdio-protocol";
import { Effect } from "effect";
const d: SemanticDigest = semanticDigest({x:1});
const options: NodeSqliteStateStoreOptions = { projectId: "consumer", path: "consumer.sqlite3" };
const memory: Effect.Effect<StateRuntimeStore, unknown> = makeMemoryStateStore(options.projectId);
const operation: StateRuntimeBridgeRequest = { schema: STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA, operation: "current" };
if (!d || !memory || !operation || typeof openNodeSqliteStateStore !== "function") throw Error("types");
`);
  execute(process.execPath, ["smoke.mjs"], consumer);
  execute(join(consumer, "node_modules/.bin/tsc"), ["--noEmit", "--strict", "--target", "ES2023",
    "--module", "NodeNext", "--moduleResolution", "NodeNext", "--types", "node", "smoke.mts"], consumer);
  const bin = join(consumer, "node_modules", ".bin", "state-stdio");
  if (!existsSync(bin)) throw Error("missing published State CLI");
  const response = JSON.parse(execute(bin, ["--project", "consumer", "--path",
    join(consumer, "state-consumer.sqlite3")], consumer,
    JSON.stringify({schema: "state-runtime.bridge-request/v1", operation: "current"})));
  if (response._tag !== "Ok" || response.value !== null ||
      response.schema !== "state-runtime.bridge-response/v1") throw Error("packaged State CLI refused");
  console.log("PACK " + name + " entries=" + entries.length + " sha256=" + hash(tarball));
  console.log("MANIFEST " + JSON.stringify(entries));
  console.log("PASS: State tarball + Effect peer, ESM root and subpaths, TypeScript declarations, executable SQLite CLI");
  completed = true;
} finally {
  if (completed && process.env.KEEP_RELEASE_CONSUMER !== "1") rmSync(scratch, { recursive: true, force: true });
  else console.error("Retained inspection artifacts:", scratch);
}
