package com.qvrix.glowos.nativeapp.data

import android.os.SystemClock
import androidx.room.withTransaction
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

data class DisplayRecord(val record: LocalRecord, val data: JSONObject)

class LocalRepository(val db: LocalDatabase, val vault: RecordVault, val uid: String) {
    val dao = db.dao()
    fun decode(record: LocalRecord) = DisplayRecord(record, JSONObject(vault.open(record.payload, record.key)))
    fun commandJson(command: OutboxCommand) = JSONObject(vault.open(command.payload, "command/${command.commandId}"))
    fun resultJson(command: OutboxCommand): JSONObject? = command.serverResult?.let { JSONObject(vault.open(it, "result/${command.commandId}")) }
    private suspend fun metadata(key: String) = dao.metadata(key)?.let { JSONObject(vault.open(it.payload, "meta/$key")) }
    suspend fun branchMetadata(salonId: String) = metadata("branch/$salonId")
    private suspend fun putMetadata(key: String, data: JSONObject) = dao.putMetadata(LocalMetadata(key, vault.seal(data.toString(), "meta/$key")))

    suspend fun save(salonId: String, collection: String, entityId: String = UUID.randomUUID().toString(), payload: JSONObject) {
        require(collection in listOf("customers", "services", "staff", "attendance")) { "This workflow is not enabled for the pilot." }
        db.withTransaction {
            val meta = branchMetadata(salonId) ?: error("Connect once to download this branch.")
            val grant = meta.getJSONObject("grant")
            val wall = System.currentTimeMillis()
            val elapsed = SystemClock.elapsedRealtime() - meta.getLong("localElapsed")
            val drift = kotlin.math.abs((wall - meta.getLong("localWall")) - elapsed)
            val trustedNow = meta.optLong("serverTime") + elapsed
            require(uid == "demo" || (elapsed >= 0 && drift < 300000 && trustedNow < grant.getLong("expiresAt") && grant.getJSONArray("allowedCollections").let { a -> (0 until a.length()).any { a.getString(it) == collection } })) { "Reconnect to refresh this branch's offline access. Your existing work is safe." }
            require(dao.unresolved(salonId, collection, entityId) == null) { "This record already has unsynchronised work. Resolve it before editing again." }
            val old = dao.record(salonId, collection, entityId)
            val commandId = UUID.randomUUID().toString()
            val command = JSONObject().put("protocolVersion", 1).put("commandId", commandId).put("salonId", salonId)
                .put("collection", collection).put("entityId", entityId).put("baseRevision", old?.revision ?: JSONObject.NULL).put("payload", payload)
            val merged = old?.let { decode(it).data } ?: JSONObject()
            payload.keys().forEach { key -> merged.put(key, payload.get(key)) }
            val record = LocalRecord(salonId, collection, entityId, "", old?.revision, "PENDING", wall)
            dao.putRecord(record.copy(payload = vault.seal(merged.toString(), record.key)))
            dao.insertCommand(OutboxCommand(commandId, salonId, collection, entityId, vault.seal(command.toString(), "command/$commandId"), createdAt = wall))
        }
    }

    suspend fun applySnapshot(snapshot: JSONObject) = db.withTransaction {
        require(snapshot.getString("ownerUid") == uid && snapshot.getInt("protocolVersion") == 1)
        val salonId = snapshot.getString("salonId")
        val rows = snapshot.getJSONArray("records")
        val seen = mutableSetOf<String>()
        for (index in 0 until rows.length()) {
            val row = rows.getJSONObject(index)
            val collection = row.getString("collection"); val entityId = row.getString("entityId")
            val record = LocalRecord(salonId, collection, entityId, "", row.getString("revision"), "SYNCED", System.currentTimeMillis())
            seen.add(record.key)
            // Always retain canonical state separately while preserving local intent.
            putMetadata("server/${record.key}", row)
            if (dao.unresolved(salonId, collection, entityId) == null) dao.putRecord(record.copy(payload = vault.seal(row.getJSONObject("data").toString(), record.key)))
        }
        for (old in dao.records(salonId)) if (old.key !in seen) {
            putMetadata("server/${old.key}", JSONObject().put("data", JSONObject.NULL).put("revision", JSONObject.NULL))
            if (dao.unresolved(salonId, old.collection, old.entityId) == null) dao.removeRecord(salonId, old.collection, old.entityId)
        }
        snapshot.put("localWall", System.currentTimeMillis()).put("localElapsed", SystemClock.elapsedRealtime())
        // Business records are stored once above; avoid duplicating the whole dataset.
        val meta = JSONObject(snapshot.toString()).apply { remove("records") }
        putMetadata("branch/$salonId", meta)
    }

    suspend fun applyResult(commandId: String, result: JSONObject) = db.withTransaction {
        val command = dao.command(commandId) ?: error("Missing local command")
        require(result.getString("commandId") == command.commandId && result.getString("salonId") == command.salonId && result.getString("entityId") == command.entityId && result.getString("collection") == command.collection)
        val status = result.getString("status")
        require(status in listOf("ACCEPTED", "CONFLICT", "REJECTED"))
        dao.putCommand(command.copy(status = status, serverResult = vault.seal(result.toString(), "result/$commandId"), errorCode = result.optString("code").ifBlank { null }))
        val old = dao.record(command.salonId, command.collection, command.entityId) ?: error("Missing local record")
        if (status == "ACCEPTED") {
            putMetadata("server/${old.key}", JSONObject().put("data", result.getJSONObject("data")).put("revision", result.getString("revision")))
            dao.putRecord(old.copy(payload = vault.seal(result.getJSONObject("data").toString(), old.key), revision = result.getString("revision"), syncState = "SYNCED"))
        } else dao.putRecord(old.copy(syncState = "FAILED"))
    }

    suspend fun transportFailure(commandId: String, code: String, terminal: Boolean) = db.withTransaction {
        val command = dao.command(commandId) ?: return@withTransaction
        dao.putCommand(command.copy(attempts = command.attempts + 1, errorCode = code, status = if (terminal) "BLOCKED" else "PENDING"))
        dao.record(command.salonId, command.collection, command.entityId)?.let { dao.putRecord(it.copy(syncState = "FAILED")) }
    }

    suspend fun retry(commandId: String) = db.withTransaction {
        val command = dao.command(commandId) ?: return@withTransaction
        require(command.status in listOf("PENDING", "BLOCKED")) { "A conflict needs review before resubmission." }
        dao.putCommand(command.copy(status = "PENDING", errorCode = null))
        dao.record(command.salonId, command.collection, command.entityId)?.let { dao.putRecord(it.copy(syncState = "PENDING")) }
    }

    // Explicitly discard optimistic projection, keeping its encrypted intent for audit.
    // Review the latest server record before choosing; no automatic overwrite.
    suspend fun discard(commandId: String) = db.withTransaction {
        val command = dao.command(commandId) ?: return@withTransaction
        require(command.status in listOf("CONFLICT", "REJECTED")) { "Reconnect before discarding an operation with an unknown outcome." }
        val key = "${command.salonId}/${command.collection}/${command.entityId}"
        val result = resultJson(command)
        val canonical = if (result?.has("serverData") == true) result.optJSONObject("serverData") else metadata("server/$key")?.optJSONObject("data")
        val rev = if (result?.has("serverRevision") == true) result.optString("serverRevision").takeUnless { it == "null" } else metadata("server/$key")?.optString("revision")
        dao.putCommand(command.copy(status = "DISCARDED"))
        if (canonical == null) dao.removeRecord(command.salonId, command.collection, command.entityId)
        else dao.putRecord(LocalRecord(command.salonId, command.collection, command.entityId, vault.seal(canonical.toString(), key), rev, "SYNCED", System.currentTimeMillis()))
    }

    suspend fun saveBillDraft(salonId: String, draft: JSONObject) = putMetadata("bill/$salonId", draft)
    suspend fun billDraft(salonId: String) = metadata("bill/$salonId") ?: JSONObject()

    suspend fun reconcileAuthorisedBranches(ids: Set<String>) = db.withTransaction {
        for (entry in dao.branches()) {
            val value = JSONObject(vault.open(entry.payload, "meta/${entry.key}"))
            if (value.getString("salonId") !in ids) {
                value.getJSONObject("grant").put("allowedCollections", JSONArray()).put("expiresAt", 0)
                value.put("accessRevoked", true)
                putMetadata(entry.key, value)
            }
        }
    }

    suspend fun seedDemo() {
        if (branchMetadata("demo-branch") != null) return
        val rows = JSONArray()
        listOf(
            Triple("customers", "demo-customer", JSONObject().put("name", "Demo Client").put("phone", "+919876543210").put("rewardPoints", 100).put("walletBalance", 0)),
            Triple("services", "demo-service", JSONObject().put("name", "Haircut").put("price", 400).put("duration", 30)),
            Triple("staff", "demo-staff", JSONObject().put("name", "Demo Stylist").put("role", "Stylist"))
        ).forEach { (collection, entityId, data) -> rows.put(JSONObject().put("collection", collection).put("entityId", entityId).put("data", data).put("revision", "demo")) }
        applySnapshot(JSONObject().put("protocolVersion", 1).put("ownerUid", "demo").put("salonId", "demo-branch")
            .put("branch", JSONObject().put("name", "Offline Demo"))
            .put("grant", JSONObject().put("expiresAt", Long.MAX_VALUE).put("allowedCollections", JSONArray(listOf("customers", "services", "staff", "attendance"))))
            .put("records", rows))
    }
}
