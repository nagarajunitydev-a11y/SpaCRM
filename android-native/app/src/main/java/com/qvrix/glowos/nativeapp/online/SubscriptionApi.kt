package com.qvrix.glowos.nativeapp.online

import com.google.firebase.auth.FirebaseAuth
import com.qvrix.glowos.nativeapp.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI

class SubscriptionApi(private val auth: FirebaseAuth) {
    suspend fun call(endpoint: String, body: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        val token = auth.currentUser?.getIdToken(false)?.await()?.token ?: error("Sign in again to continue.")
        val connection = URI("${BuildConfig.API_URL}/api/subscription/$endpoint").toURL().openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false; connection.connectTimeout = 15000; connection.readTimeout = 25000
            connection.requestMethod = "POST"; connection.doOutput = true
            connection.setRequestProperty("Authorization", "Bearer $token"); connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("X-Qvrix-Platform", "android"); connection.setRequestProperty("User-Agent", "QvrixGlowOSAndroid/2 Native")
            connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val status = connection.responseCode
            val text = (if (status in 200..299) connection.inputStream else connection.errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (status == 404) throw CloudFailure("PAYMENT_API_NOT_DEPLOYED", "The subscription payment API is not available on this server (404). Contact support.")
            val result = runCatching { JSONObject(text) }.getOrElse { throw CloudFailure("INVALID_RESPONSE", "The payment server returned an invalid response. Check payment history before trying again.", true) }
            if (status !in 200..299) throw CloudFailure(result.str("code", "PAYMENT_SERVER_ERROR"), result.str("error", "The server rejected this payment request."))
            result
        } catch (error: CloudFailure) { throw error }
        catch (error: Exception) { throw CloudFailure("PAYMENT_UNCONFIRMED", "Payment confirmation is unavailable. Check payment history before starting another purchase.", true) }
        finally { connection.disconnect() }
    }
}
