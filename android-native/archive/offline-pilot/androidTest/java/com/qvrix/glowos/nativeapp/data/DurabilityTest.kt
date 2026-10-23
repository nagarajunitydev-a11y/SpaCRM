package com.qvrix.glowos.nativeapp.data

import android.content.Context
import androidx.room.Room
import androidx.room.withTransaction
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class DurabilityTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private fun database(name: String) = Room.databaseBuilder(context, LocalDatabase::class.java, name).build()
    private fun snapshot(rows: JSONArray = JSONArray()) = JSONObject().put("protocolVersion", 1).put("ownerUid", "demo").put("salonId", "demo-branch")
        .put("branch", JSONObject().put("name", "Demo")).put("grant", JSONObject().put("expiresAt", Long.MAX_VALUE).put("allowedCollections", JSONArray()))
        .put("records", rows)

    @Test fun localAcceptanceSurvivesDatabaseReopenAndPendingIntentSurvivesPull() = runBlocking {
        val name = "test-${UUID.randomUUID()}.db"
        val vault = RecordVault("demo")
        var db = database(name)
        try {
            var repo = LocalRepository(db, vault, "demo")
            repo.seedDemo()
            repo.save("demo-branch", "customers", "offline-client", JSONObject().put("name", "Durable Client").put("phone", "+919876543211"))
            val command = repo.dao.pending().single()
            val encrypted = repo.dao.record("demo-branch", "customers", "offline-client")!!
            assertFalse(encrypted.payload.contains("Durable Client"))
            assertFalse(command.payload.contains("Durable Client"))
            db.close()
            db = database(name); repo = LocalRepository(db, vault, "demo")
            assertEquals(command.commandId, repo.dao.pending().single().commandId)
            assertEquals("Durable Client", repo.decode(repo.dao.record("demo-branch", "customers", "offline-client")!!).data.getString("name"))
            repo.applySnapshot(snapshot())
            assertNotNull(repo.dao.record("demo-branch", "customers", "offline-client"))
            assertNotNull(repo.dao.command(command.commandId))
        } finally { db.close(); context.deleteDatabase(name) }
    }

    @Test fun failedTransactionHasNeitherEntityNorOutbox() = runBlocking {
        val name = "test-${UUID.randomUUID()}.db"; val db = database(name)
        try {
            val result = runCatching { db.withTransaction {
                db.dao().putRecord(LocalRecord("branch", "customers", "id", "encrypted", null, "PENDING", 0))
                db.dao().insertCommand(OutboxCommand("command", "branch", "customers", "id", "encrypted", createdAt = 0))
                error("Simulated disk/transaction failure")
            } }
            assertTrue(result.isFailure)
            assertNull(db.dao().record("branch", "customers", "id")); assertTrue(db.dao().pending().isEmpty())
        } finally { db.close(); context.deleteDatabase(name) }
    }

    @Test fun encryptionRejectsWrongAccountPurposeAndTampering() {
        val first = RecordVault("test-${UUID.randomUUID()}")
        val second = RecordVault("test-${UUID.randomUUID()}")
        val cipher = first.seal("private-business-record", "customers/id")
        assertEquals("private-business-record", first.open(cipher, "customers/id"))
        assertTrue(runCatching { first.open(cipher, "customers/other") }.isFailure)
        assertTrue(runCatching { second.open(cipher, "customers/id") }.isFailure)
        val bytes = android.util.Base64.decode(cipher, android.util.Base64.NO_WRAP).apply { this[lastIndex] = (this[lastIndex].toInt() xor 1).toByte() }
        assertTrue(runCatching { first.open(android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP), "customers/id") }.isFailure)
    }

    @Test fun failureAndRetryKeepSameIdentityAndServerAcceptanceIsAtomic() = runBlocking {
        val name = "test-${UUID.randomUUID()}.db"; val db = database(name)
        try {
            val repo = LocalRepository(db, RecordVault("demo"), "demo"); repo.seedDemo()
            repo.save("demo-branch", "customers", "retry-client", JSONObject().put("name", "Retry Client"))
            val command = repo.dao.pending().single()
            repo.transportFailure(command.commandId, "CONNECTION_FAILED", false)
            assertEquals("FAILED", repo.dao.record("demo-branch", "customers", "retry-client")!!.syncState)
            repo.retry(command.commandId)
            assertEquals(command.commandId, repo.dao.pending().single().commandId)
            val result = JSONObject().put("commandId", command.commandId).put("salonId", "demo-branch").put("entityId", "retry-client").put("collection", "customers")
                .put("status", "ACCEPTED").put("data", JSONObject().put("name", "Canonical Client")).put("revision", "revision")
            repo.applyResult(command.commandId, result)
            assertTrue(repo.dao.pending().isEmpty())
            val row = repo.dao.record("demo-branch", "customers", "retry-client")!!
            assertEquals("SYNCED", row.syncState); assertEquals("Canonical Client", repo.decode(row).data.getString("name"))
            assertNotNull(repo.dao.command(command.commandId)!!.serverResult)
        } finally { db.close(); context.deleteDatabase(name) }
    }
}
