package com.qvrix.glowos.nativeapp.data

import androidx.room.*
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "records", primaryKeys = ["salonId", "collection", "entityId"])
data class LocalRecord(
    val salonId: String, val collection: String, val entityId: String,
    val payload: String, val revision: String?, val syncState: String,
    val updatedAt: Long,
) {
    val key: String get() = "$salonId/$collection/$entityId"
}

@Entity(tableName = "outbox", indices = [Index(value = ["salonId", "collection", "entityId"]), Index(value = ["status", "createdAt"])])
data class OutboxCommand(
    @PrimaryKey val commandId: String, val salonId: String, val collection: String,
    val entityId: String, val payload: String, val status: String = "PENDING",
    val attempts: Int = 0, val createdAt: Long, val errorCode: String? = null,
    val serverResult: String? = null,
)

@Entity(tableName = "metadata")
data class LocalMetadata(@PrimaryKey val key: String, val payload: String)

@Dao
interface LocalDao {
    @Query("SELECT * FROM records WHERE salonId = :salonId ORDER BY collection, updatedAt DESC")
    fun observeRecords(salonId: String): Flow<List<LocalRecord>>
    @Query("SELECT * FROM outbox WHERE status NOT IN ('ACCEPTED', 'SUPERSEDED', 'DISCARDED') ORDER BY createdAt")
    fun observeOutbox(): Flow<List<OutboxCommand>>
    @Query("SELECT * FROM outbox WHERE status = 'PENDING' ORDER BY createdAt, commandId")
    suspend fun pending(): List<OutboxCommand>
    @Query("SELECT * FROM outbox WHERE commandId = :id")
    suspend fun command(id: String): OutboxCommand?
    @Query("SELECT * FROM outbox WHERE salonId = :salonId AND collection = :collection AND entityId = :entityId AND status NOT IN ('ACCEPTED', 'SUPERSEDED', 'DISCARDED') LIMIT 1")
    suspend fun unresolved(salonId: String, collection: String, entityId: String): OutboxCommand?
    @Query("SELECT * FROM records WHERE salonId = :salonId AND collection = :collection AND entityId = :entityId")
    suspend fun record(salonId: String, collection: String, entityId: String): LocalRecord?
    @Query("SELECT * FROM records WHERE salonId = :salonId")
    suspend fun records(salonId: String): List<LocalRecord>
    @Upsert suspend fun putRecord(record: LocalRecord)
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertCommand(command: OutboxCommand)
    @Upsert suspend fun putCommand(command: OutboxCommand)
    @Query("DELETE FROM records WHERE salonId = :salonId AND collection = :collection AND entityId = :entityId")
    suspend fun removeRecord(salonId: String, collection: String, entityId: String)
    @Query("SELECT * FROM metadata WHERE `key` = :key")
    suspend fun metadata(key: String): LocalMetadata?
    @Query("SELECT * FROM metadata WHERE `key` LIKE 'branch/%'")
    suspend fun branches(): List<LocalMetadata>
    @Upsert suspend fun putMetadata(value: LocalMetadata)
}

@Database(entities = [LocalRecord::class, OutboxCommand::class, LocalMetadata::class], version = 1, exportSchema = true)
abstract class LocalDatabase : RoomDatabase() { abstract fun dao(): LocalDao }
