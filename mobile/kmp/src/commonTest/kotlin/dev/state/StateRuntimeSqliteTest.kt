package dev.state

import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import okio.ByteString.Companion.encodeUtf8
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class StateRuntimeSqliteTest {
    @Test
    fun bundledDriverImplementsProjectScopedStateMapContract() {
        val store = StateRuntimeSqlite(
            projectId = "assistant",
            driver = BundledSQLiteDriver(),
            path = ":memory:",
        )

        val recordJson =
            """{"id":"conversation:1","kind":"conversation","project":"assistant","schema":"state-runtime.record/v1","value":{"text":"hello"}}"""
        val record = StateRecordRow(
            digest = digest(recordJson),
            id = "conversation:1",
            kind = "conversation",
            canonicalJson = recordJson,
        )
        store.putRecord(record)
        assertEquals(record, store.getRecord(record.digest))

        val sourceDigest = "sha256:" + "a".repeat(64)
        val mapJson =
            """{"compiler":"assistant-state/v1","entries":{"conversation:1":{"kind":"conversation","record":"${record.digest}"}},"generation":0,"parent":null,"project":"assistant","schema":"state-runtime.statemap/v1","sourceDigest":"$sourceDigest"}"""
        val map = StateMapRow(
            digest = digest(mapJson),
            generation = 0,
            parentDigest = null,
            compiler = "assistant-state/v1",
            sourceDigest = sourceDigest,
            canonicalJson = mapJson,
            entries = listOf(
                StateMapEntryRow(
                    id = "conversation:1",
                    kind = "conversation",
                    recordDigest = record.digest,
                )
            ),
        )
        store.putMap(map)

        val pointer = StatePointer(0, map.digest)
        assertTrue(store.compareAndSwapCurrent(null, pointer))
        assertFalse(store.compareAndSwapCurrent(null, pointer))
        assertEquals(pointer, store.current())
        assertEquals(pointer, store.verify())
        assertEquals(pointer, store.verifyHistory())
        assertEquals(listOf(pointer), store.history())
        assertEquals(record, store.getCurrentEntry("conversation:1"))
        assertNull(store.getCurrentEntry("not-current"))
        assertNotNull(store.getRecord(record.digest))
        store.close()
    }

    @Test
    fun ordinaryAdvancementRequiresOneGenerationAndExactParent() {
        val store = StateRuntimeSqlite(
            projectId = "assistant",
            driver = BundledSQLiteDriver(),
            path = ":memory:",
        )

        val sourceDigest = "sha256:" + "a".repeat(64)
        val map0Json =
            """{"compiler":"assistant-state/v1","entries":{},"generation":0,"parent":null,"project":"assistant","schema":"state-runtime.statemap/v1","sourceDigest":"$sourceDigest"}"""
        val map0 = StateMapRow(
            digest = digest(map0Json),
            generation = 0,
            parentDigest = null,
            compiler = "assistant-state/v1",
            sourceDigest = sourceDigest,
            canonicalJson = map0Json,
            entries = emptyList(),
        )
        store.putMap(map0)
        val pointer0 = StatePointer(0, map0.digest)
        assertTrue(store.compareAndSwapCurrent(null, pointer0))

        val skipJson =
            """{"compiler":"assistant-state/v1","entries":{},"generation":2,"parent":"${map0.digest}","project":"assistant","schema":"state-runtime.statemap/v1","sourceDigest":"$sourceDigest"}"""
        val skip = StateMapRow(
            digest = digest(skipJson),
            generation = 2,
            parentDigest = map0.digest,
            compiler = "assistant-state/v1",
            sourceDigest = sourceDigest,
            canonicalJson = skipJson,
            entries = emptyList(),
        )
        store.putMap(skip)
        assertFailsWith<IllegalStateException> {
            store.compareAndSwapCurrent(pointer0, StatePointer(2, skip.digest))
        }
        assertEquals(pointer0, store.current())

        val unrelatedJson =
            """{"compiler":"assistant-state/v1","entries":{},"generation":1,"parent":null,"project":"assistant","schema":"state-runtime.statemap/v1","sourceDigest":"$sourceDigest"}"""
        val unrelated = StateMapRow(
            digest = digest(unrelatedJson),
            generation = 1,
            parentDigest = null,
            compiler = "assistant-state/v1",
            sourceDigest = sourceDigest,
            canonicalJson = unrelatedJson,
            entries = emptyList(),
        )
        store.putMap(unrelated)
        assertFailsWith<IllegalStateException> {
            store.compareAndSwapCurrent(pointer0, StatePointer(1, unrelated.digest))
        }
        assertEquals(pointer0, store.current())

        val map1Json =
            """{"compiler":"assistant-state/v1","entries":{},"generation":1,"parent":"${map0.digest}","project":"assistant","schema":"state-runtime.statemap/v1","sourceDigest":"$sourceDigest"}"""
        val map1 = StateMapRow(
            digest = digest(map1Json),
            generation = 1,
            parentDigest = map0.digest,
            compiler = "assistant-state/v1",
            sourceDigest = sourceDigest,
            canonicalJson = map1Json,
            entries = emptyList(),
        )
        store.putMap(map1)
        val pointer1 = StatePointer(1, map1.digest)
        assertTrue(store.compareAndSwapCurrent(pointer0, pointer1))
        assertEquals(pointer1, store.current())
        assertEquals(pointer1, store.verifyHistory())
        store.close()
    }



    @Test
    fun canonicalBytesOwnDenormalizedMetadataAndEntries() {
        val store = StateRuntimeSqlite(
            projectId = "assistant",
            driver = BundledSQLiteDriver(),
            path = ":memory:",
        )

        val recordJson =
            """{"id":"canonical","kind":"conversation","project":"assistant","schema":"state-runtime.record/v1","value":{"text":"hello"}}"""
        assertFailsWith<IllegalStateException> {
            store.putRecord(
                StateRecordRow(
                    digest = digest(recordJson),
                    id = "forged",
                    kind = "conversation",
                    canonicalJson = recordJson,
                )
            )
        }

        val sourceDigest = "sha256:" + "a".repeat(64)
        val mapJson =
            """{"compiler":"assistant-state/v1","entries":{},"generation":0,"parent":null,"project":"assistant","schema":"state-runtime.statemap/v1","sourceDigest":"$sourceDigest"}"""
        assertFailsWith<IllegalStateException> {
            store.putMap(
                StateMapRow(
                    digest = digest(mapJson),
                    generation = 0,
                    parentDigest = null,
                    compiler = "assistant-state/v1",
                    sourceDigest = sourceDigest,
                    canonicalJson = mapJson,
                    entries = listOf(
                        StateMapEntryRow(
                            id = "forged",
                            kind = "conversation",
                            recordDigest = "sha256:" + "b".repeat(64),
                        )
                    ),
                )
            )
        }
        store.close()
    }

    @Test
    fun atomicCommitPublishesNothingOnConflict() {
        val store = StateRuntimeSqlite(
            projectId = "assistant",
            driver = BundledSQLiteDriver(),
            path = ":memory:",
        )
        val sourceDigest = "sha256:" + "a".repeat(64)
        val record0Json =
            """{"id":"r0","kind":"kind","project":"assistant","schema":"state-runtime.record/v1","value":{"v":0}}"""
        val record0 = StateRecordRow(
            digest = digest(record0Json),
            id = "r0",
            kind = "kind",
            canonicalJson = record0Json,
        )
        val map0Json =
            """{"compiler":"commit/v1","entries":{"r0":{"kind":"kind","record":"${record0.digest}"}},"generation":0,"parent":null,"project":"assistant","schema":"state-runtime.statemap/v1","sourceDigest":"$sourceDigest"}"""
        val map0 = StateMapRow(
            digest = digest(map0Json),
            generation = 0,
            parentDigest = null,
            compiler = "commit/v1",
            sourceDigest = sourceDigest,
            canonicalJson = map0Json,
            entries = listOf(StateMapEntryRow("r0", "kind", record0.digest)),
        )
        assertTrue(store.commit(null, listOf(record0), map0))
        val pointer0 = StatePointer(0, map0.digest)

        val ghostJson =
            """{"id":"ghost","kind":"kind","project":"assistant","schema":"state-runtime.record/v1","value":{"v":1}}"""
        val ghost = StateRecordRow(
            digest = digest(ghostJson),
            id = "ghost",
            kind = "kind",
            canonicalJson = ghostJson,
        )
        val map1Json =
            """{"compiler":"commit/v1","entries":{"ghost":{"kind":"kind","record":"${ghost.digest}"}},"generation":1,"parent":"${map0.digest}","project":"assistant","schema":"state-runtime.statemap/v1","sourceDigest":"$sourceDigest"}"""
        val map1 = StateMapRow(
            digest = digest(map1Json),
            generation = 1,
            parentDigest = map0.digest,
            compiler = "commit/v1",
            sourceDigest = sourceDigest,
            canonicalJson = map1Json,
            entries = listOf(StateMapEntryRow("ghost", "kind", ghost.digest)),
        )
        assertFalse(store.commit(null, listOf(ghost), map1))
        assertEquals(pointer0, store.current())
        assertNull(store.getRecord(ghost.digest))
        store.verifyStorage()
        store.close()
    }


    @Test
    fun latestEntryWalksReachableHistoryWithoutChangingCurrentSemantics() {
        val store = StateRuntimeSqlite(
            projectId = "assistant",
            driver = BundledSQLiteDriver(),
            path = ":memory:",
        )
        val sourceDigest = "sha256:" + "a".repeat(64)
        val recordJson =
            """{"id":"old","kind":"kind","project":"assistant","schema":"state-runtime.record/v1","value":{"v":0}}"""
        val record = StateRecordRow(
            digest = digest(recordJson),
            id = "old",
            kind = "kind",
            canonicalJson = recordJson,
        )
        val map0Json =
            """{"compiler":"latest/v1","entries":{"old":{"kind":"kind","record":"${record.digest}"}},"generation":0,"parent":null,"project":"assistant","schema":"state-runtime.statemap/v1","sourceDigest":"$sourceDigest"}"""
        val map0 = StateMapRow(
            digest = digest(map0Json),
            generation = 0,
            parentDigest = null,
            compiler = "latest/v1",
            sourceDigest = sourceDigest,
            canonicalJson = map0Json,
            entries = listOf(StateMapEntryRow("old", "kind", record.digest)),
        )
        assertTrue(store.commit(null, listOf(record), map0))
        val pointer0 = StatePointer(0, map0.digest)

        val map1Json =
            """{"compiler":"latest/v1","entries":{},"generation":1,"parent":"${map0.digest}","project":"assistant","schema":"state-runtime.statemap/v1","sourceDigest":"$sourceDigest"}"""
        val map1 = StateMapRow(
            digest = digest(map1Json),
            generation = 1,
            parentDigest = map0.digest,
            compiler = "latest/v1",
            sourceDigest = sourceDigest,
            canonicalJson = map1Json,
            entries = emptyList(),
        )
        assertTrue(store.commit(pointer0, emptyList(), map1))
        assertNull(store.getCurrentEntry("old"))
        assertEquals(record, store.getLatestEntry("old"))
        store.close()
    }

    private fun digest(text: String): String =
        "sha256:" + text.encodeUtf8().sha256().hex()
}
