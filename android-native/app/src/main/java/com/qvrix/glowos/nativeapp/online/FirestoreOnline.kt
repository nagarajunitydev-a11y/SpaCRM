package com.qvrix.glowos.nativeapp.online

import com.google.firebase.auth.FirebaseAuth
import com.qvrix.glowos.nativeapp.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.*

fun JSONObject.str(key: String, fallback: String = ""): String = if (isNull(key)) fallback else optString(key, fallback)
fun JSONObject.num(key: String): Double = optDouble(key, 0.0).takeIf { it.isFinite() } ?: 0.0
fun JSONObject.objects(key: String): List<JSONObject> = optJSONArray(key)?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } } ?: emptyList()
fun JSONObject.copyJson() = JSONObject(toString())
fun json(vararg fields: Pair<String, Any?>) = JSONObject().apply { fields.forEach { (k, v) -> put(k, v ?: JSONObject.NULL) } }
data class CloudDocument(val path: String, val data: JSONObject, val updateTime: String = "") {
    val id get() = path.substringAfterLast('/')
    fun str(key: String, fallback: String = "") = data.str(key, fallback)
    fun num(key: String) = data.num(key)
}
class CloudFailure(val code: String, message: String, val uncertain: Boolean = false) : Exception(message)

object FirestoreCodec {
    fun value(v: Any?): JSONObject = when (v) {
        null, JSONObject.NULL -> json("nullValue" to JSONObject.NULL)
        is Boolean -> json("booleanValue" to v)
        is Int, is Long -> json("integerValue" to v.toString())
        is Number -> json("doubleValue" to v.toDouble())
        is JSONArray -> json("arrayValue" to json("values" to JSONArray((0 until v.length()).map { value(v.get(it)) })))
        is JSONObject -> if (v.has("__firestoreTimestamp")) json("timestampValue" to v.str("__firestoreTimestamp")) else json("mapValue" to json("fields" to fields(v)))
        else -> json("stringValue" to v.toString())
    }
    fun fields(data: JSONObject) = JSONObject().apply { data.keys().forEach { put(it, value(data.get(it))) } }
    fun decode(v: JSONObject): Any = when {
        v.has("nullValue") -> JSONObject.NULL
        v.has("stringValue") -> v.getString("stringValue")
        v.has("integerValue") -> v.getString("integerValue").toLong()
        v.has("doubleValue") -> v.getDouble("doubleValue")
        v.has("booleanValue") -> v.getBoolean("booleanValue")
        v.has("timestampValue") -> json("__firestoreTimestamp" to v.getString("timestampValue"))
        v.has("arrayValue") -> JSONArray().apply { val a = v.getJSONObject("arrayValue").optJSONArray("values") ?: JSONArray(); for (i in 0 until a.length()) put(decode(a.getJSONObject(i))) }
        v.has("mapValue") -> decodeFields(v.getJSONObject("mapValue").optJSONObject("fields") ?: JSONObject())
        else -> throw CloudFailure("UNSUPPORTED_FIELD", "A Firestore field type could not be read safely.")
    }
    fun decodeFields(fields: JSONObject) = JSONObject().apply { fields.keys().forEach { put(it, decode(fields.getJSONObject(it))) } }
    fun document(raw: JSONObject) = CloudDocument(raw.getString("name").substringAfter("/documents/"), decodeFields(raw.optJSONObject("fields") ?: JSONObject()), raw.str("updateTime"))
    fun timestamp(ms: Long) = json("__firestoreTimestamp" to SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(ms)))
    fun millis(value: Any?): Long = when (value) {
        is Number -> value.toLong()
        is JSONObject -> millis(value.str("__firestoreTimestamp"))
        is String -> listOf("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", "yyyy-MM-dd'T'HH:mm:ss'Z'").firstNotNullOfOrNull { format -> runCatching { SimpleDateFormat(format, Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.parse(if (value.length > 24) value.take(23) + "Z" else value)?.time }.getOrNull() } ?: 0L
        else -> 0L
    }
}

/** Direct authenticated online requests. No SDK business cache, database,
 * write-behind queue, reconnect replay, service account or background worker. */
class FirestoreOnline(private val auth: FirebaseAuth) {
    private val root = "projects/${BuildConfig.FIREBASE_PROJECT_ID}/databases/(default)"
    private val origin = if (BuildConfig.DEBUG && BuildConfig.EMULATOR_HOST.isNotBlank()) "http://${BuildConfig.EMULATOR_HOST}:8085/v1/" else "https://firestore.googleapis.com/v1/"
    fun full(path: String) = "$root/documents/$path"
    private suspend fun token() = auth.currentUser?.getIdToken(false)?.await()?.token ?: throw CloudFailure("AUTH_REQUIRED", "Sign in to continue.")
    suspend fun request(suffix: String, method: String = "GET", body: JSONObject? = null, mutation: Boolean = false): String = withContext(Dispatchers.IO) {
        val bearer = token()
        val connection = URI(origin + root + suffix).toURL().openConnection() as HttpURLConnection
        var dispatched = false
        try {
            connection.instanceFollowRedirects = false; connection.connectTimeout = 12000; connection.readTimeout = 20000
            connection.requestMethod = method; connection.setRequestProperty("Authorization", "Bearer $bearer")
            connection.setRequestProperty("Content-Type", "application/json")
            if (body != null) { connection.doOutput = true; dispatched = mutation; connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) } }
            val status = connection.responseCode
            val text = (if (status in 200..299) connection.inputStream else connection.errorStream)?.bufferedReader()?.use { it.readText() } ?: "{}"
            if (status !in 200..299) {
                val error = runCatching { JSONObject(text).optJSONObject("error") }.getOrNull()
                throw CloudFailure(error?.str("status") ?: "HTTP_$status", error?.str("message") ?: "The server rejected this request.")
            }
            text
        } catch (error: CloudFailure) { throw error }
        catch (error: Exception) { throw CloudFailure(if (dispatched) "OUTCOME_UNCONFIRMED" else "CONNECTION_FAILED", if (dispatched) "Confirmation was interrupted. Refresh and check the record before submitting again." else "Could not reach Firebase. Check your internet connection and retry.", dispatched) }
        finally { connection.disconnect() }
    }
    suspend fun get(path: String): CloudDocument? = try { FirestoreCodec.document(JSONObject(request("/documents/$path"))) } catch (e: CloudFailure) { if (e.code == "NOT_FOUND") null else throw e }
    suspend fun list(path: String): List<CloudDocument> {
        val result = mutableListOf<CloudDocument>(); var next = ""
        do {
            val data = JSONObject(request("/documents/$path?pageSize=300" + if (next.isBlank()) "" else "&pageToken=${URLEncoder.encode(next, "UTF-8")}"))
            result += data.objects("documents").map(FirestoreCodec::document); next = data.str("nextPageToken")
        } while (next.isNotBlank())
        return result
    }
    suspend fun query(collection: String, field: String? = null, value: String? = null, parent: String = "", transaction: String? = null): List<CloudDocument> {
        val query = json("from" to JSONArray().put(json("collectionId" to collection)))
        if (field != null) query.put("where", json("fieldFilter" to json("field" to json("fieldPath" to field), "op" to "EQUAL", "value" to FirestoreCodec.value(value))))
        val body = json("structuredQuery" to query); if (transaction != null) body.put("transaction", transaction)
        val response = JSONArray(request("/documents${if (parent.isBlank()) "" else "/$parent"}:runQuery", "POST", body))
        return (0 until response.length()).mapNotNull { response.getJSONObject(it).optJSONObject("document")?.let(FirestoreCodec::document) }
    }
    suspend fun group(collection: String): List<CloudDocument> {
        val rows = JSONArray(request("/documents:runQuery", "POST", json("structuredQuery" to json("from" to JSONArray().put(json("collectionId" to collection, "allDescendants" to true))))))
        return (0 until rows.length()).mapNotNull { rows.getJSONObject(it).optJSONObject("document")?.let(FirestoreCodec::document) }
    }
    inner class Transaction(val id: String) {
        private var writing = false
        val writes = JSONArray()
        suspend fun get(path: String): CloudDocument? {
            check(!writing) { "All transaction reads must happen before writes." }
            val rows = JSONArray(request("/documents:batchGet", "POST", json("documents" to JSONArray().put(full(path)), "transaction" to id)))
            return (0 until rows.length()).firstNotNullOfOrNull { rows.getJSONObject(it).optJSONObject("found")?.let(FirestoreCodec::document) }
        }
        suspend fun query(collection: String, field: String? = null, value: String? = null, parent: String = ""): List<CloudDocument> { check(!writing); return this@FirestoreOnline.query(collection, field, value, parent, id) }
        fun set(path: String, data: JSONObject, merge: Boolean = true) {
            writing = true; val write = json("update" to json("name" to full(path), "fields" to FirestoreCodec.fields(data)))
            if (merge) write.put("updateMask", json("fieldPaths" to JSONArray(data.keys().asSequence().toList())))
            writes.put(write)
        }
        fun delete(path: String) { writing = true; writes.put(json("delete" to full(path))) }
        fun create(path: String, data: JSONObject) {
            writing = true
            writes.put(json("update" to json("name" to full(path), "fields" to FirestoreCodec.fields(data)), "currentDocument" to json("exists" to false)))
        }
    }
    suspend fun <T> atomic(work: suspend Transaction.() -> T): T {
        val transaction = Transaction(JSONObject(request("/documents:beginTransaction", "POST", json("options" to json("readWrite" to JSONObject())))).getString("transaction"))
        try {
            val result = transaction.work()
            if (transaction.writes.length() > 0) request("/documents:commit", "POST", json("writes" to transaction.writes, "transaction" to transaction.id), true)
            else request("/documents:rollback", "POST", json("transaction" to transaction.id))
            return result
        } catch (e: Exception) { if (e !is CloudFailure || !e.uncertain) runCatching { request("/documents:rollback", "POST", json("transaction" to transaction.id)) }; throw e }
    }
    suspend fun save(path: String, data: JSONObject, expected: String? = null, createOnly: Boolean = false) = atomic {
        val old = get(path)
        if (createOnly) check(old == null) { "This record already exists. Refresh before retrying." }
        if (expected != null) check(old?.updateTime == expected) { "This record changed. Refresh and review before saving." }
        set(path, data)
    }
    suspend fun delete(doc: CloudDocument) = atomic { val fresh = get(doc.path); check(fresh?.updateTime == doc.updateTime) { "This record changed. Refresh before deleting." }; delete(doc.path) }
}
