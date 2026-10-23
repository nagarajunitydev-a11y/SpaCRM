package com.qvrix.glowos.nativeapp.sync

import com.qvrix.glowos.nativeapp.BuildConfig
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLEncoder

class ApiFailure(val status: Int, val code: String, message: String) : Exception(message)

class SyncApi(private val auth: FirebaseAuth, private val expectedUid: String) {
    private suspend fun request(path: String, body: JSONObject? = null): JSONObject {
        val user = auth.currentUser?.takeIf { it.uid == expectedUid } ?: throw ApiFailure(401, "AUTH_REQUIRED", "Sign in again to sync this account.")
        suspend fun send(forceRefresh: Boolean): JSONObject {
            val token = try { user.getIdToken(forceRefresh).await().token }
            catch (error: FirebaseAuthException) { throw ApiFailure(401, "AUTH_REQUIRED", "Sign in again to synchronise this account.") }
                ?: throw ApiFailure(401, "AUTH_REQUIRED", "Sign in again.")
            return withContext(Dispatchers.IO) {
                val connection = URI(BuildConfig.API_URL + "/api/sync/" + path).toURL().openConnection() as HttpURLConnection
                try {
                    connection.instanceFollowRedirects = false
                    connection.connectTimeout = 15000; connection.readTimeout = 20000
                    connection.setRequestProperty("Authorization", "Bearer $token")
                    connection.setRequestProperty("Accept", "application/json")
                    if (body != null) {
                        connection.requestMethod = "POST"; connection.doOutput = true
                        connection.setRequestProperty("Content-Type", "application/json")
                        connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
                    }
                    val status = connection.responseCode
                    val raw = (if (status in 200..299) connection.inputStream else connection.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
                    val result = runCatching { JSONObject(raw) }.getOrElse { throw ApiFailure(status, "INVALID_RESPONSE", "The sync server returned an invalid response.") }
                    if (status !in 200..299) throw ApiFailure(status, result.optString("code", "HTTP_$status"), result.optString("error", "Could not synchronise."))
                    result
                } finally { connection.disconnect() }
            }
        }
        return try { send(false) } catch (error: ApiFailure) { if (error.status == 401) send(true) else throw error }
    }
    suspend fun branches() = request("branches").getJSONArray("branches")
    suspend fun snapshot(salonId: String) = request("snapshot?salonId=${URLEncoder.encode(salonId, "UTF-8")}")
    suspend fun push(command: JSONObject) = request("push", command)
}
