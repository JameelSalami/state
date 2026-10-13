# State

> Public npm package: `@durable-systems/state@0.1.0`.
> GitHub: [JameelSalami/state](https://github.com/JameelSalami/state).


State is the shared persistence/materialization substrate for consumer-owned state.

It standardizes:

- content-addressed immutable project-owned records;
- project-owned StateMaps and materialized current state;
- current-pointer compare-and-swap and strict history advancement;
- immutable history and explicit integrity verification scopes;
- portable, content-addressed snapshot/restore;
- narrow atomic persistence + pointer advancement;
- project-private storage-mechanism realizations;
- crash/restart, backup, and rebase behavior.

It does **not** own any consumer's domain schema, semantic admission law, state meaning, retry/recovery
policy, retention policy, distributed scheduling, leases/reservations, or external consequence
authority. Successful persistence establishes persistence and integrity bindings only; it does not
establish domain truth, approval, current external authority, or product consequence.

## Foundation relationship

State, Trace, and Contract are sibling shared foundations: State owns durable state mechanics; Trace owns causal evidence/replay mechanics; Contract owns machine-readable declarations, receipts, conformance, and drift. None of the three acquires another project's domain nouns or execution authority.

## Authority boundary

```text
consumer-owned facts
        ↓
consumer-owned StateMap compiler
        ↓
State
  persistence / integrity /
  atomic advancement / recovery
        ↓
storage mechanism
```

The canonical StateMap remains the authoritative content-addressed materialization. Any adapter index
or lookup acceleration is reconstructable mechanism state, not a second semantic source of truth.

## Transition law

`compareAndSwapCurrent(expected, next)` is the ordinary advancement boundary.

For an empty store, ordinary CAS is genesis-only:

```text
next.generation == 0
nextMap.parent == null
next pointer binds nextMap
project identity is unchanged
```

For an existing current state:

```text
expected is still current
expected pointer binds expectedMap
next.generation == expected.generation + 1
nextMap.parent == expected.map
next pointer binds nextMap
project identity is unchanged
```

An unrelated previously stored StateMap cannot become current through ordinary CAS merely because the
expected pointer is still current.

Validated snapshot restore is deliberately separate. `installVerifiedHistory` is an empty-store,
recovery-only seam that verifies the complete reachable history and all referenced records before
installing a supplied head. This preserves multi-generation snapshot restore without weakening the
ordinary one-generation law.

## Atomic commit

`commit({ expected, records, map })` accepts already consumer-compiled immutable records and a
StateMap, validates content addressing/project/history bindings, and persists the objects plus current
pointer advance atomically.

The consumer still owns StateMap compilation and semantic transition meaning. State owns only
the storage/integrity mechanics. On conflict or validation/corruption failure, neither the pointer nor
the supplied immutable objects are committed by the atomic operation. The lower-level `putRecord`,
`putMap`, and `compareAndSwapCurrent` methods remain available for compatibility.

## Verification semantics

Verification scope is explicit:

- `verify` preserves the original current-scope v1 result shape;
- `verifyCurrent` verifies the current pointer, current StateMap digest/canonical encoding, and every
  record referenced by the current StateMap;
- `verifyHistory` additionally walks the entire reachable parent chain and proves map
  digest/canonical encoding, project identity, generation continuity, parent linkage, referenced
  record existence/digest/canonical encoding, entry `id/kind` binding, and current-pointer/head
  binding;
- `verifyStorage` is the explicit mechanism diagnostic. The Node SQLite realization runs the full
  `PRAGMA integrity_check` there rather than during ordinary logical reads.

The additive `verifyCurrent` and `verifyHistory` results carry an explicit `scope`; legacy `verify`
keeps its original response shape for API/stdio compatibility. Logical state verification and
physical database diagnostics are deliberately separate so consumers do not trigger a whole-database
SQLite scan on each read or transition.

## Current-state access

`getCurrentEntry(id)` resolves a single entry through the canonical current StateMap and verifies the
referenced record identity. A separately stored record that is not present in the canonical current
StateMap cannot be fabricated as current state.

`getLatestEntry(id)` resolves the newest reachable occurrence of an entry across current history
without requiring consumers to understand parent traversal. The Node SQLite mechanism maintains a
transactional latest-entry index bound to the current pointer and verifies indexed results against the
immutable map/record bytes; older databases rebuild that index from verified history when needed. The
memory and KMP realizations may traverse immutable history directly. These are mechanism-level access
optimizations and do not change StateMap v1 or its digest.

## Server/local SQLite

The Node realization uses SQLite WAL, `synchronous=FULL`, transactional pointer CAS, and immutable
content-addressed records/maps. Full SQLite `PRAGMA integrity_check` is available through the explicit
`verifyStorage` maintenance/diagnostic seam.

Ship-oriented evidence includes:

- clean restart persistence;
- unclean SIGKILL/WAL recovery after a committed pointer advance;
- corruption fail-closed;
- project namespace isolation;
- live SQLite online backup;
- portable snapshot restore between memory and SQLite;
- atomic commit rollback on conflicts/invalid commits;
- strict one-generation lineage parity with the memory adapter.

The current Node 22 `node:sqlite` API is still marked experimental by Node. This is a mechanism
limitation, not a semantic dependency; the adapter is replaceable without changing State or
consumer laws.

## Mobile SQLite

`mobile/kmp` contains the common Kotlin Multiplatform realization built on AndroidX SQLite 2.7.1
and `BundledSQLiteDriver`. Its ordinary CAS law matches the Node/memory lineage rule, and it exposes
current versus full-history verification plus canonical current-entry and latest-reachable lookup.

Android and iOS release support still requires platform CI/device evidence. Linux/JVM conformance is
not presented as proof of Apple simulator/device behavior.

## Recovery

`exportStateRuntimeSnapshot` produces a project-bound, content-addressed snapshot containing the
complete reachable StateMap history and records. Export verifies reachable history before emitting the
snapshot. `restoreStateRuntimeSnapshotToEmpty` validates the complete payload before installing the
target current pointer, including record identity, parent completeness, generation continuity, and
head binding. Rejected/tampered restores cannot manufacture a current state.

Snapshot v1 and its payload digest are unchanged. The current export API materializes the normalized
payload. If larger histories require streaming, the intended boundary is an additive iterator/stream
transport over the same snapshot schema and hash semantics rather than a replacement schema.

## Digest compatibility

`StateRecord v1`, `StateMap v1`, pointer v1, snapshot v1, canonical JSON, and their existing digest
fixtures are unchanged. Runtime decoders are strict: schema envelopes and entry objects reject
missing/excess fields, JSON objects must be plain objects, and JCS/I-JSON-incompatible input such as
non-finite numbers, lone surrogates, and Unicode noncharacters fails closed. Snapshot
v1 restore accepts exactly the immutable maps and records reachable from its current pointer;
disconnected payload is rejected. Domain-separated identity can be introduced by future schema
versions without rewriting historical hashes.

## Local history rebase / erasure support

State exposes a Node SQLite replacement mechanism that accepts a consumer-selected, fully
verified sanitized snapshot and atomically replaces the closed active database with a fresh rebased
database.

This is the mechanism needed for product-level delete/forget semantics when a consumer deliberately
excludes selected records from the new snapshot. State never chooses what to forget.

The verified claim is bounded to active logical persistence: the replacement database and its retained
StateMap history no longer contain excluded records. It does not claim forensic wiping of underlying
media and it does not delete separately retained backups; those remain platform/product retention
responsibilities.

## Language-neutral process bridge

`state-stdio` preserves the existing v1 one-request-per-process JSON boundary. Existing
operations such as `put_record`, `put_map`, `current`, `compare_and_swap_current`, `history`,
and `verify` remain compatible; `compare_and_swap_current` now obeys the strict ordinary lineage
law and `verify` retains current-scope semantics.

The bridge returns `Ok` or a typed `Refused` result (`validation`, `read`, `write`, `corrupt`,
`conflict`, or `invalid-request`). No SQL or table concepts cross the boundary.
## Package namespace and independent installation

The npm package identity is **`@durable-systems/state@0.1.0`**. This is
domain-neutral and does not depend on Contract, Trace, Assurance, or an
application-specific domain ontology. `effect@3.22.2` is a required peer.

After authorized publication:

```sh
npm install @durable-systems/state@0.1.0 effect@3.22.2
```

From a standalone source checkout, with no sibling repositories:

```sh
npm ci
npm run check
npm test
npm run build
npm run verify:install
```

`npm run verify:install` runs the actual lifecycle-enabled `npm pack`,
inspects the archive, and installs its tarball into an unrelated consumer.
The consumer checks the ESM root, `@durable-systems/state/node-sqlite`,
`@durable-systems/state/stdio-protocol`, the `state-stdio` executable, and
public TypeScript declarations. The release tarball includes compiled ESM,
types, README and LICENSE, but excludes test files, mobile KMP sources,
private tooling, source Git history and build dependencies.

The portable root API supports the declared Node 20.19+ ESM target; **the
optional Node SQLite adapter and CLI require a Node version providing
`node:sqlite`**, verified here on Node 22. Their experimental SQLite
implementation does not qualify mobile Android/iOS distribution.

Licensed under Apache-2.0; see [LICENSE](LICENSE). Consumers and
redistributors must honor applicable attribution and NOTICE obligations.

## Portable JavaScript core and implementation binding

The root `state` entrypoint is JavaScript-runtime-neutral: canonical identity,
StateMaps, integrity, snapshots, in-memory storage, and adapter selection do not
import Node built-ins. Synchronous SHA-256 uses a pinned audited JavaScript
implementation while preserving the historical wire digests.

Storage adapters are **explicit**. A composition root can inject qualified
implementations and select one with `openStateImplementation`:

```ts
import { Effect } from "effect";
import {
  STATE_STORE_INTERFACE,
  openStateImplementation,
  memoryStateImplementation
} from "@durable-systems/state";
import { nodeSqliteStateImplementation } from "@durable-systems/state/node-sqlite";

const choice = {
  schema: "state.implementation-binding/v1",
  interface: STATE_STORE_INTERFACE,
  projectId: "example",
  driver: "node-sqlite",
  requiredCapabilities: ["atomic-commit", "verified-history"],
  authority: "none"
} as const;
const store = await Effect.runPromise(
  openStateImplementation(choice,
    [memoryStateImplementation, nodeSqliteStateImplementation],
    { path: "./example.sqlite3" })
);
```

To select memory, choose `driver: "memory"` and pass `null` as the
configuration. Unsupported driver IDs, invalid configuration, and missing
capabilities **refuse**, rather than silently falling back or migrating data.
Consumers may supply additional adapters, but must qualify them against
State's storage laws. A PostgreSQL adapter is not included by this package.

For an existing installation, migrate through verified portable snapshots
while writes are fenced and identity/currentness are checked; changing the
driver string is **not** a safe data migration. The Node SQLite adapter is
separate from the portable root and requires compatible `node:sqlite`
support (for unflagged Node use, Node 22.13+). Android/iOS realizations
require their own platform evidence.

## Third-party storage extensions (no State fork required)

`StateRuntimeStore` remains the only state store interface; an adapter can
live in a user-owned project or package. Compose its `id`, `version`,
`requiredChecks`, `capabilities`, `configurationSchemaDigest`, and
`open({projectId,configuration})` through a trusted application.

`STATE_STORE_REQUIRED_CHECKS` defines four non-negotiable base checks:
atomic commit, conflicting current-pointer CAS, verified history and portable
snapshot round-trip. Implementations advertising `durable-restart` must also
require crash-recovery checks. An extension cannot replace those checks with
its own easier checklist.

`describeStateImplementations([adapter])` returns a declarative
`contract.extension-manifest/v1` contribution **without opening the store**.
The host can feed that contribution to
`compileExtensionManifest` / `discoverExtensions` in Contract. It should
then run independently owned conformance checks and use Assurance's
`qualifyExtension` to bind exact check receipts to the manifest. The host
must verify all external evidence before admitting or opening custom code.
Merely declaring the required capabilities does not prove correctness or
constitute permission to open a database.

`openStateImplementation` continues to support explicit manual selection
without any automatic dynamic import or discovery side effect. Its caller
controls when an adapter is opened. Untrusted extensions need application
sandboxing, reviewed installation permissions, and an independent test
environment before the host calls `open`.

Users can swap fresh, empty stores by selecting a different qualified
adapter in their own composition root. Existing durable data requires a
separate migration: fence writes, take a verified portable snapshot, restore
to an empty target, verify identity/history and recovery, obtain current
authorization, and only then atomically switch the consumer-owned binding.
No API here performs that authority-bearing switch automatically.

Contract, State, Trace and Assurance are intentionally independent: using
their extension protocols requires composing each package explicitly at
the user application's boundary, not changing the foundation source.

## Related work, prior art and third-party attribution

The following works establish relevant **prior concepts**; they are not
represented as source-code origins or implemented wire-format standards:

- [SQLite transactions](https://www.sqlite.org/lang_transaction.html):
  atomic database commit/rollback semantics used by the optional Node SQLite
  adapter. State adds its own immutable records, project identity, strict
  generation/CAS law, history verification and portable snapshots.
- [IPLD Data Model](https://ipld.io/docs/data-model/): generic
  content-addressed data and links. State has its own StateRecord/StateMap
  formats and SHA-256 digests; it **does not implement IPLD CIDs or codecs**.
- [Automerge](https://automerge.org/docs/tutorial/): local-first documents
  and conflict-free merge across peers. State enforces explicit current-pointer
  transitions; it **does not provide CRDT merging or synchronization**.
- [RFC 8785, JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785):
  widely published prior art for canonical JSON identities. State has a
  separately frozen canonical encoding and additional rejection rules;
  **general RFC 8785/JCS conformance is not asserted**.

The npm package uses `@noble/hashes@2.4.0` (MIT) as a separate runtime
dependency and `effect@3.22.2` (MIT) as a required peer. Its Android/KMP
source declares AndroidX SQLite dependencies separately; distributing mobile
binaries requires platform-specific attribution and verification. No third-party
library sources are bundled inside the State npm tarball. Rights to the
State source and any inherited NOTICE obligations remain subject to
provenance confirmation before public distribution.


## Opt-in disjoint writes and explicit history checkpointing

`commitDisjointStateChanges(store, { expected, records, deleteIds, compiler,
sourceDigest })` rebases changes to disjoint record IDs onto newer versions,
retrying the original strict whole-store CAS atomically. A conflicting write
to a touched record ID still fails. This is an application-level optimistic
rebase, not physical per-record transactions: each commit still creates a
complete immutable StateMap.

`prepareStateCheckpoint(store)` verifies full history and prepares a
single-generation equivalent of **current materialized state**. It does not
change the live store. A consumer can explicitly authorize the existing
`replaceNodeSqliteDatabaseFromSnapshot` mechanism after stopping live writers,
backing up the original database and retaining any historically important
receipts externally. The new checkpoint has a **different current digest
and history identity**; historical references cannot be silently retained.

The SQLite integration test demonstrates 12 historical StateMaps becoming
one checkpoint StateMap without changing the current logical record.
This is opt-in history discarding, **not** a replacement for persistent
structural sharing or a way to retain all history without paying storage costs.
