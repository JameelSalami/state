package dev.state

import androidx.sqlite.SQLiteConnection
import androidx.sqlite.SQLiteDriver
import androidx.sqlite.SQLiteStatement
import androidx.sqlite.execSQL
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okio.ByteString.Companion.encodeUtf8

data class StateRecordRow(
    val digest: String,
    val id: String,
    val kind: String,
    val canonicalJson: String,
)

data class StateMapEntryRow(
    val id: String,
    val kind: String,
    val recordDigest: String,
)

data class StateMapRow(
    val digest: String,
    val generation: Long,
    val parentDigest: String?,
    val compiler: String,
    val sourceDigest: String,
    val canonicalJson: String,
    val entries: List<StateMapEntryRow>,
)

data class StatePointer(
    val generation: Long,
    val mapDigest: String,
)

class StateRuntimeSqlite(
    private val projectId: String,
    driver: SQLiteDriver,
    path: String,
) : AutoCloseable {
    private val connection: SQLiteConnection = driver.open(path)

    private data class MapBinding(
        val generation: Long,
        val parentDigest: String?,
        val canonicalJson: String,
        val entries: List<StateMapEntryRow>,
    )

    private data class CanonicalRecord(
        val id: String,
        val kind: String,
    )

    private data class CanonicalMap(
        val generation: Long,
        val parentDigest: String?,
        val compiler: String,
        val sourceDigest: String,
        val entries: List<StateMapEntryRow>,
    )

    init {
        require(projectId.isNotBlank()) { "projectId must be non-empty" }
        connection.execSQL("PRAGMA journal_mode=WAL")
        connection.execSQL("PRAGMA synchronous=FULL")
        connection.execSQL("PRAGMA foreign_keys=ON")
        connection.execSQL(
            """
            CREATE TABLE IF NOT EXISTS state_records (
              project TEXT NOT NULL,
              digest TEXT NOT NULL,
              id TEXT NOT NULL,
              kind TEXT NOT NULL,
              canonical_json TEXT NOT NULL,
              PRIMARY KEY(project, digest)
            ) STRICT
            """.trimIndent()
        )
        connection.execSQL(
            """
            CREATE TABLE IF NOT EXISTS state_maps (
              project TEXT NOT NULL,
              digest TEXT NOT NULL,
              generation INTEGER NOT NULL,
              parent_digest TEXT,
              compiler TEXT NOT NULL,
              source_digest TEXT NOT NULL,
              canonical_json TEXT NOT NULL,
              PRIMARY KEY(project, digest)
            ) STRICT
            """.trimIndent()
        )
        connection.execSQL(
            """
            CREATE TABLE IF NOT EXISTS state_map_entries (
              project TEXT NOT NULL,
              map_digest TEXT NOT NULL,
              id TEXT NOT NULL,
              kind TEXT NOT NULL,
              record_digest TEXT NOT NULL,
              PRIMARY KEY(project, map_digest, id)
            ) STRICT
            """.trimIndent()
        )
        connection.execSQL(
            """
            CREATE TABLE IF NOT EXISTS state_current (
              project TEXT PRIMARY KEY,
              generation INTEGER NOT NULL,
              map_digest TEXT NOT NULL
            ) STRICT
            """.trimIndent()
        )
    }

    fun putRecord(record: StateRecordRow) {
        writeRecord(record)
    }

    fun getRecord(digest: String): StateRecordRow? =
        connection.prepare(
            "SELECT id,kind,canonical_json FROM state_records WHERE project=? AND digest=?"
        ).use { statement ->
            statement.bindText(1, projectId)
            statement.bindText(2, digest)
            if (!statement.step()) return@use null
            val row = StateRecordRow(
                digest = digest,
                id = statement.getText(0),
                kind = statement.getText(1),
                canonicalJson = statement.getText(2),
            )
            validateRecordRow(row)
            row
        }

    fun putMap(map: StateMapRow) {
        transaction { writeMap(map) }
    }

    fun commit(
        expected: StatePointer?,
        records: List<StateRecordRow>,
        map: StateMapRow,
    ): Boolean = transaction {
        val observed = current()
        if (observed != expected) return@transaction false
        for (record in records) writeRecord(record)
        writeMap(map)
        val next = StatePointer(map.generation, map.digest)
        verifyAdvance(expected, next)
        verifyEntries(next.mapDigest)
        writeCurrent(next)
        true
    }

    fun current(): StatePointer? =
        connection.prepare(
            "SELECT generation,map_digest FROM state_current WHERE project=?"
        ).use { statement ->
            statement.bindText(1, projectId)
            if (!statement.step()) null
            else StatePointer(
                generation = statement.getLong(0),
                mapDigest = statement.getText(1),
            )
        }

    fun getCurrentEntry(id: String): StateRecordRow? {
        val pointer = current() ?: return null
        val binding = verifyPointerBinding(pointer, "current")
        val entry = binding.entries.firstOrNull { it.id == id } ?: return null
        val record = checkNotNull(getRecord(entry.recordDigest)) {
            "$id: record missing"
        }
        check(record.id == id && record.kind == entry.kind) {
            "$id: record identity mismatch"
        }
        return record
    }

    fun getLatestEntry(id: String): StateRecordRow? {
        val seen = mutableSetOf<String>()
        var pointer = current()
        while (pointer != null) {
            check(seen.add(pointer.mapDigest)) {
                "StateMap history cycle detected"
            }
            val binding = verifyPointerBinding(pointer, "history")
            val entry = binding.entries.firstOrNull { it.id == id }
            if (entry != null) {
                val record = checkNotNull(getRecord(entry.recordDigest)) {
                    "$id: record missing"
                }
                check(record.id == id && record.kind == entry.kind) {
                    "$id: record identity mismatch"
                }
                return record
            }
            pointer =
                if (binding.generation == 0L) {
                    check(binding.parentDigest == null) {
                        "generation 0 StateMap must have null parent"
                    }
                    null
                } else {
                    StatePointer(
                        generation = binding.generation - 1,
                        mapDigest = checkNotNull(binding.parentDigest) {
                            "non-zero StateMap generation is missing its parent"
                        },
                    )
                }
        }
        return null
    }

    fun compareAndSwapCurrent(
        expected: StatePointer?,
        next: StatePointer,
    ): Boolean = transaction {
        val observed = current()
        if (observed != expected) return@transaction false
        verifyAdvance(expected, next)
        verifyEntries(next.mapDigest)
        writeCurrent(next)
        true
    }

    fun history(limit: Int = 100): List<StatePointer> {
        require(limit in 1..1000) { "history limit must be 1..1000" }
        val result = mutableListOf<StatePointer>()
        var pointer = current()
        while (pointer != null && result.size < limit) {
            result += pointer
            val map = verifyPointerBinding(pointer, "history")
            pointer =
                if (map.generation == 0L) {
                    check(map.parentDigest == null) {
                        "generation 0 StateMap must have null parent"
                    }
                    null
                } else {
                    StatePointer(
                        generation = map.generation - 1,
                        mapDigest = checkNotNull(map.parentDigest) {
                            "non-zero StateMap generation is missing its parent"
                        },
                    )
                }
        }
        return result
    }

    fun verify(): StatePointer {
        val pointer = checkNotNull(current()) {
            "StateMap current pointer is missing"
        }
        verifyPointerBinding(pointer, "current")
        verifyEntries(pointer.mapDigest)
        return pointer
    }

    fun verifyHistory(): StatePointer {
        val head = checkNotNull(current()) {
            "StateMap current pointer is missing"
        }
        val seen = mutableSetOf<String>()
        var pointer: StatePointer? = head
        while (pointer != null) {
            check(seen.add(pointer.mapDigest)) {
                "StateMap history cycle detected"
            }
            val map = verifyPointerBinding(pointer, "history")
            verifyEntries(pointer.mapDigest)
            pointer =
                if (map.generation == 0L) {
                    check(map.parentDigest == null) {
                        "generation 0 StateMap must have null parent"
                    }
                    null
                } else {
                    StatePointer(
                        generation = map.generation - 1,
                        mapDigest = checkNotNull(map.parentDigest) {
                            "non-zero StateMap generation is missing its parent"
                        },
                    )
                }
        }
        return head
    }

    fun verifyStorage() {
        verifySqlite()
    }

    override fun close() {
        connection.close()
    }

    private fun validateRecordRow(record: StateRecordRow): CanonicalRecord {
        check(record.digest == digest(record.canonicalJson)) {
            "record digest does not match canonical bytes"
        }
        val canonical = decodeCanonicalRecord(record.canonicalJson)
        check(record.id == canonical.id && record.kind == canonical.kind) {
            "record metadata does not match canonical bytes"
        }
        return canonical
    }

    private fun writeRecord(record: StateRecordRow) {
        val canonical = validateRecordRow(record)
        connection.prepare(
            "SELECT id,kind,canonical_json FROM state_records WHERE project=? AND digest=?"
        ).use { statement ->
            statement.bindText(1, projectId)
            statement.bindText(2, record.digest)
            if (statement.step()) {
                check(statement.getText(2) == record.canonicalJson) {
                    "content-addressed record collision"
                }
                check(
                    statement.getText(0) == canonical.id &&
                        statement.getText(1) == canonical.kind
                ) {
                    "stored record metadata does not match canonical bytes"
                }
                return
            }
        }
        connection.prepare(
            "INSERT INTO state_records(project,digest,id,kind,canonical_json) VALUES(?,?,?,?,?)"
        ).use { statement ->
            statement.bindText(1, projectId)
            statement.bindText(2, record.digest)
            statement.bindText(3, canonical.id)
            statement.bindText(4, canonical.kind)
            statement.bindText(5, record.canonicalJson)
            statement.step()
        }
    }

    private fun writeMap(map: StateMapRow) {
        check(map.digest == digest(map.canonicalJson)) {
            "StateMap digest does not match canonical bytes"
        }
        val canonical = decodeCanonicalMap(map.canonicalJson)
        check(
            map.generation == canonical.generation &&
                map.parentDigest == canonical.parentDigest &&
                map.compiler == canonical.compiler &&
                map.sourceDigest == canonical.sourceDigest &&
                normalizedEntries(map.entries) == canonical.entries
        ) {
            "StateMap metadata/entries do not match canonical bytes"
        }

        connection.prepare(
            "SELECT generation,parent_digest,compiler,source_digest,canonical_json FROM state_maps WHERE project=? AND digest=?"
        ).use { statement ->
            statement.bindText(1, projectId)
            statement.bindText(2, map.digest)
            if (statement.step()) {
                check(statement.getText(4) == map.canonicalJson) {
                    "content-addressed StateMap collision"
                }
                check(
                    statement.getLong(0) == canonical.generation &&
                        nullableText(statement, 1) == canonical.parentDigest &&
                        statement.getText(2) == canonical.compiler &&
                        statement.getText(3) == canonical.sourceDigest
                ) {
                    "stored StateMap metadata does not match canonical bytes"
                }
            } else {
                connection.prepare(
                    "INSERT INTO state_maps(project,digest,generation,parent_digest,compiler,source_digest,canonical_json) VALUES(?,?,?,?,?,?,?)"
                ).use { insert ->
                    insert.bindText(1, projectId)
                    insert.bindText(2, map.digest)
                    insert.bindLong(3, canonical.generation)
                    if (canonical.parentDigest == null) insert.bindNull(4)
                    else insert.bindText(4, canonical.parentDigest)
                    insert.bindText(5, canonical.compiler)
                    insert.bindText(6, canonical.sourceDigest)
                    insert.bindText(7, map.canonicalJson)
                    insert.step()
                }
            }
        }

        for (entry in canonical.entries) {
            connection.prepare(
                "INSERT OR IGNORE INTO state_map_entries(project,map_digest,id,kind,record_digest) VALUES(?,?,?,?,?)"
            ).use { statement ->
                statement.bindText(1, projectId)
                statement.bindText(2, map.digest)
                statement.bindText(3, entry.id)
                statement.bindText(4, entry.kind)
                statement.bindText(5, entry.recordDigest)
                statement.step()
            }
        }
        check(normalizedEntries(readEntries(map.digest)) == canonical.entries) {
            "stored StateMap entries do not match canonical bytes"
        }
    }

    private fun verifyAdvance(
        expected: StatePointer?,
        next: StatePointer,
    ) {
        val nextMap = verifyPointerBinding(next, "next")
        if (expected == null) {
            check(next.generation == 0L && nextMap.parentDigest == null) {
                "ordinary empty-store advancement must install generation 0 with null parent"
            }
        } else {
            verifyPointerBinding(expected, "expected")
            check(next.generation == expected.generation + 1) {
                "ordinary advancement must increase generation by exactly one"
            }
            check(nextMap.parentDigest == expected.mapDigest) {
                "ordinary advancement StateMap parent must equal expected current map"
            }
        }
    }

    private fun mapBinding(digest: String): MapBinding? =
        connection.prepare(
            "SELECT generation,parent_digest,compiler,source_digest,canonical_json FROM state_maps WHERE project=? AND digest=?"
        ).use { statement ->
            statement.bindText(1, projectId)
            statement.bindText(2, digest)
            if (!statement.step()) return@use null
            val canonicalJson = statement.getText(4)
            val canonical = decodeCanonicalMap(canonicalJson)
            check(
                statement.getLong(0) == canonical.generation &&
                    nullableText(statement, 1) == canonical.parentDigest &&
                    statement.getText(2) == canonical.compiler &&
                    statement.getText(3) == canonical.sourceDigest
            ) {
                "stored StateMap metadata does not match canonical bytes"
            }
            MapBinding(
                generation = canonical.generation,
                parentDigest = canonical.parentDigest,
                canonicalJson = canonicalJson,
                entries = canonical.entries,
            )
        }

    private fun verifyPointerBinding(
        pointer: StatePointer,
        label: String,
    ): MapBinding {
        val map = checkNotNull(mapBinding(pointer.mapDigest)) {
            "$label pointer references missing StateMap"
        }
        check(map.generation == pointer.generation) {
            "$label pointer/StateMap generation mismatch"
        }
        check(digest(map.canonicalJson) == pointer.mapDigest) {
            "$label StateMap digest mismatch"
        }
        return map
    }

    private fun verifyEntries(mapDigest: String) {
        val map = checkNotNull(mapBinding(mapDigest)) {
            "StateMap missing during entry verification"
        }
        check(normalizedEntries(readEntries(mapDigest)) == map.entries) {
            "StateMap entry index does not match canonical bytes"
        }
        for (entry in map.entries) {
            val record = checkNotNull(getRecord(entry.recordDigest)) {
                "${entry.id}: record missing"
            }
            check(record.id == entry.id && record.kind == entry.kind) {
                "${entry.id}: record identity mismatch"
            }
        }
    }

    private fun readEntries(mapDigest: String): List<StateMapEntryRow> {
        val entries = mutableListOf<StateMapEntryRow>()
        connection.prepare(
            "SELECT id,kind,record_digest FROM state_map_entries WHERE project=? AND map_digest=? ORDER BY id"
        ).use { statement ->
            statement.bindText(1, projectId)
            statement.bindText(2, mapDigest)
            while (statement.step()) {
                entries += StateMapEntryRow(
                    id = statement.getText(0),
                    kind = statement.getText(1),
                    recordDigest = statement.getText(2),
                )
            }
        }
        return entries
    }

    private fun decodeCanonicalRecord(text: String): CanonicalRecord {
        val value = parseObject(text, "record")
        exactKeys(value, setOf("schema", "project", "id", "kind", "value"), "record")
        check(requiredString(value, "schema", "record") == RECORD_SCHEMA) {
            "unsupported canonical record schema"
        }
        check(requiredString(value, "project", "record") == projectId) {
            "canonical record belongs to another project"
        }
        return CanonicalRecord(
            id = requiredNonEmptyString(value, "id", "record"),
            kind = requiredNonEmptyString(value, "kind", "record"),
        )
    }

    private fun decodeCanonicalMap(text: String): CanonicalMap {
        val value = parseObject(text, "StateMap")
        exactKeys(
            value,
            setOf(
                "schema",
                "project",
                "generation",
                "parent",
                "compiler",
                "sourceDigest",
                "entries",
            ),
            "StateMap",
        )
        check(requiredString(value, "schema", "StateMap") == MAP_SCHEMA) {
            "unsupported canonical StateMap schema"
        }
        check(requiredString(value, "project", "StateMap") == projectId) {
            "canonical StateMap belongs to another project"
        }

        val generation = value.getValue("generation").jsonPrimitive.content.toLongOrNull()
        check(
            generation != null &&
                generation >= 0 &&
                generation <= JS_SAFE_INTEGER_MAX
        ) {
            "canonical StateMap generation must be a safe non-negative integer"
        }

        val parentElement = value.getValue("parent")
        val parent = if (parentElement === JsonNull) {
            null
        } else {
            parentElement.jsonPrimitive.content.also {
                checkDigest(it, "StateMap.parent")
            }
        }
        val compiler = requiredNonEmptyString(value, "compiler", "StateMap")
        val sourceDigest = requiredString(value, "sourceDigest", "StateMap").also {
            checkDigest(it, "StateMap.sourceDigest")
        }

        val entriesObject = value.getValue("entries").jsonObject
        val entries = entriesObject.entries.map { (id, rawEntry) ->
            check(id.isNotBlank()) { "canonical StateMap entry id must be non-empty" }
            val entry = rawEntry.jsonObject
            exactKeys(entry, setOf("kind", "record"), "StateMap.entries.$id")
            val recordDigest = requiredString(entry, "record", "StateMap.entries.$id")
            checkDigest(recordDigest, "StateMap.entries.$id.record")
            StateMapEntryRow(
                id = id,
                kind = requiredNonEmptyString(entry, "kind", "StateMap.entries.$id"),
                recordDigest = recordDigest,
            )
        }

        return CanonicalMap(
            generation = generation,
            parentDigest = parent,
            compiler = compiler,
            sourceDigest = sourceDigest,
            entries = normalizedEntries(entries),
        )
    }

    private fun parseObject(text: String, label: String): JsonObject =
        try {
            Json.parseToJsonElement(text).jsonObject
        } catch (cause: Throwable) {
            error("$label canonical JSON is invalid: ${cause.message ?: cause::class.simpleName}")
        }

    private fun exactKeys(
        value: JsonObject,
        expected: Set<String>,
        label: String,
    ) {
        check(value.keys == expected) {
            "$label canonical JSON has unexpected or missing fields"
        }
    }

    private fun requiredString(
        value: JsonObject,
        key: String,
        label: String,
    ): String =
        value[key]?.jsonPrimitive?.content
            ?: error("$label.$key is required")

    private fun requiredNonEmptyString(
        value: JsonObject,
        key: String,
        label: String,
    ): String =
        requiredString(value, key, label).also {
            check(it.isNotBlank()) { "$label.$key must be non-empty" }
        }

    private fun normalizedEntries(
        entries: List<StateMapEntryRow>,
    ): List<StateMapEntryRow> =
        entries.sortedBy { it.id }.also {
            check(it.map(StateMapEntryRow::id).distinct().size == it.size) {
                "StateMap entry ids must be unique"
            }
        }

    private fun checkDigest(value: String, label: String) {
        check(DIGEST_REGEX.matches(value)) {
            "$label must be sha256:<lowercase-hex>"
        }
    }

    private fun nullableText(statement: SQLiteStatement, index: Int): String? =
        if (statement.isNull(index)) null else statement.getText(index)

    private fun verifySqlite() {
        connection.prepare("PRAGMA integrity_check").use { statement ->
            check(statement.step() && statement.getText(0) == "ok") {
                "SQLite integrity_check failed"
            }
        }
    }

    private fun writeCurrent(pointer: StatePointer) {
        connection.prepare(
            """
            INSERT INTO state_current(project,generation,map_digest) VALUES(?,?,?)
            ON CONFLICT(project) DO UPDATE SET
              generation=excluded.generation,
              map_digest=excluded.map_digest
            """.trimIndent()
        ).use { statement ->
            statement.bindText(1, projectId)
            statement.bindLong(2, pointer.generation)
            statement.bindText(3, pointer.mapDigest)
            statement.step()
        }
    }

    private fun <T> transaction(block: () -> T): T {
        connection.execSQL("BEGIN IMMEDIATE TRANSACTION")
        try {
            val value = block()
            connection.execSQL("COMMIT")
            return value
        } catch (cause: Throwable) {
            runCatching { connection.execSQL("ROLLBACK") }
            throw cause
        }
    }

    private fun digest(text: String): String =
        "sha256:" + text.encodeUtf8().sha256().hex()

    private companion object {
        const val RECORD_SCHEMA = "state-runtime.record/v1"
        const val MAP_SCHEMA = "state-runtime.statemap/v1"
        const val JS_SAFE_INTEGER_MAX = 9_007_199_254_740_991L
        val DIGEST_REGEX = Regex("^sha256:[0-9a-f]{64}$")
    }
}
