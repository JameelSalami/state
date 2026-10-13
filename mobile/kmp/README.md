# State Runtime mobile SQLite

This Kotlin Multiplatform realization implements the same project-scoped transition and integrity
laws used by the Node/memory State Runtime adapters. Canonical JSON bytes are the authenticated
source of truth: every denormalized SQLite column and StateMap-entry index row is checked against
the parsed canonical envelope before state is accepted or reported healthy.

It deliberately uses the low-level AndroidX SQLite KMP driver rather than defining mobile-specific
consumer semantics. The intended production driver is `BundledSQLiteDriver` so Android and iOS use
a consistent SQLite build.

The mobile transition boundary now follows the same ordinary advancement law:

- empty-store CAS is genesis-only (generation 0, null parent);
- existing current state advances exactly one generation;
- the expected pointer must bind its stored StateMap;
- the next pointer must bind its stored StateMap;
- the next StateMap parent must be the expected current map.

`commit(expected, records, map)` atomically publishes immutable rows and current advancement under
the same exact-next law, so a stale expected pointer cannot leak submitted objects. `verify()` remains
current-scope logical verification for compatibility, `verifyHistory()` walks the full reachable
parent chain, `verifyStorage()` performs the explicit SQLite physical-integrity diagnostic, and
`getCurrentEntry(id)` resolves only entries present in the canonical current StateMap, while
`getLatestEntry(id)` resolves the newest reachable historical occurrence without changing current-state semantics.

KMP consumes caller-supplied canonical bytes rather than maintaining an independent platform JSON
canonicalizer. Cross-platform producers must use the shared JCS-compatible byte/digest contract; the
KMP adapter parses those bytes and refuses any parallel metadata or index representation that does not
match them exactly.

Pinned source toolchain:

- Kotlin 2.4.20
- Gradle 9.7
- AndroidX SQLite 2.7.1
- Okio 3.18.2
- kotlinx.serialization JSON 1.11.0

The common/JVM conformance suite is the host-level semantic check. It does not establish Android or
iOS release support by itself.

Platform ship gates remain:

- Android: emulator + physical-device persistence/restart test, database backup/restore test,
  and Macrobenchmark startup/UI evidence.
- iOS: macOS/Xcode build, simulator + physical-device persistence/restart test, Application Support
  placement, file-protection verification, backup/restore, and MetricKit evidence.

Persistent database paths are supplied by the app realization. Android should use its application
database directory and explicit backup rules. iOS should use Application Support with an appropriate
data-protection class. Cache/tmp directories are not valid homes for canonical state.
