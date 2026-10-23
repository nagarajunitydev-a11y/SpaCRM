package com.qvrix.glowos.nativeapp

import android.app.Application
import androidx.compose.runtime.*
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.core.content.edit
import com.qvrix.glowos.nativeapp.data.*
import com.qvrix.glowos.nativeapp.sync.*
import kotlinx.coroutines.*
import kotlinx.coroutines.tasks.await
import org.json.JSONObject

data class Branch(val id: String, val name: String)

class PilotViewModel(application: Application) : AndroidViewModel(application) {
    val app = application as GlowApplication
    var uid by mutableStateOf<String?>(null); private set
    var branchId by mutableStateOf(""); private set
    var branches by mutableStateOf<List<Branch>>(emptyList()); private set
    var records by mutableStateOf<List<DisplayRecord>>(emptyList()); private set
    var outbox by mutableStateOf<List<OutboxCommand>>(emptyList()); private set
    var message by mutableStateOf(""); private set
    var busy by mutableStateOf(false); private set
    var bill by mutableStateOf(JSONObject()); private set
    var subscription by mutableStateOf<JSONObject?>(null); private set
    private var recordJob: Job? = null
    private var outboxJob: Job? = null
    val repo: LocalRepository get() = app.repository(requireNotNull(uid))

    init { app.activeUid()?.let { account -> launch { activate(account) } } }
    fun launch(action: suspend () -> Unit) = viewModelScope.launch {
        busy = true
        try { action() }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) { message = error.message ?: "Could not complete this action. Existing local data is preserved." }
        finally { busy = false }
    }
    private suspend fun activate(account: String) {
        uid = account
        app.session.edit { putString("uid", account) }
        if (account == "demo") repo.seedDemo()
        reloadBranches()
        outboxJob?.cancel()
        outboxJob = viewModelScope.launch { repo.dao.observeOutbox().collect { outbox = it } }
        SyncWorker.enqueue(app, account)
    }
    private suspend fun reloadBranches() {
        branches = repo.dao.branches().map { metadata ->
            val json = JSONObject(repo.vault.open(metadata.payload, "meta/${metadata.key}"))
            Branch(json.getString("salonId"), json.optJSONObject("branch")?.optString("name") ?: "Branch")
        }
        val selected = app.session.getString("branch/$uid", "")
        branches.firstOrNull { it.id == selected }?.let { selectBranch(it.id) }
            ?: branches.firstOrNull()?.let { selectBranch(it.id) }
    }
    fun demo() = launch { activate("demo"); message = "Offline demo opened. Demo records stay on this device and never upload." }
    fun signIn(email: String, password: String) = launch {
        val auth = app.auth ?: error("Firebase is not configured for this pilot build. Use the offline demo or configure the staging build.")
        val result = auth.signInWithEmailAndPassword(email.trim(), password).await()
        activate(requireNotNull(result.user).uid)
        download()
    }
    fun connect() = launch { download() }
    private suspend fun download() {
        val account = uid ?: error("Sign in first.")
        require(account != "demo") { "The offline demo does not connect to a server." }
        SyncWorker.withAccountLock(account) {
            val localRepo = app.repository(account)
            val api = SyncApi(app.auth ?: error("Firebase is not configured."), account)
            val available = api.branches()
            localRepo.reconcileAuthorisedBranches((0 until available.length()).map { available.getJSONObject(it).getString("id") }.toSet())
            for (index in 0 until available.length()) {
                require(app.activeUid() == account) { "Account changed. Reopen this account to continue." }
                localRepo.applySnapshot(api.snapshot(available.getJSONObject(index).getString("id")))
            }
            if (uid == account) reloadBranches()
        }
        SyncWorker.enqueue(app, account)
        message = "Branch data downloaded. Pending work is queued for sync."
    }
    fun selectBranch(id: String) {
        require(branches.any { it.id == id })
        recordJob?.cancel(); branchId = id
        app.session.edit { putString("branch/$uid", id) }
        records = emptyList()
        recordJob = viewModelScope.launch {
            try {
                bill = repo.billDraft(id)
                subscription = repo.branchMetadata(id)?.optJSONObject("subscription")
                repo.dao.observeRecords(id).collect { rows -> records = rows.map(repo::decode) }
            } catch (error: Exception) { message = "Local records could not be opened. Keep this app installed; recovery is required. ${error.message ?: ""}" }
        }
    }
    fun save(collection: String, entityId: String?, payload: JSONObject, onSaved: () -> Unit) = launch {
        val id = entityId ?: java.util.UUID.randomUUID().toString()
        repo.save(branchId, collection, id, payload)
        SyncWorker.enqueue(app, requireNotNull(uid))
        message = "Saved on this device — Pending Sync"
        onSaved()
    }
    fun syncNow() {
        uid?.let { SyncWorker.enqueue(app, it) }
        message = if (uid == "demo") "Demo records stay on this device. Sign in to a pilot account for cloud sync." else "Sync scheduled. Pending changes remain safe on this device."
    }
    fun retry(id: String) = launch { repo.retry(id); SyncWorker.enqueue(app, requireNotNull(uid)); message = "Retry queued with the original command identity." }
    fun discard(id: String) = launch { repo.discard(id); message = "Server version restored. The original local intent is retained for review." }
    fun saveBill(value: JSONObject) = launch { repo.saveBillDraft(branchId, value); bill = value; message = "Bill draft saved on this device. No invoice or payment has been issued." }
    fun signOut() {
        uid?.let { SyncWorker.cancel(app, it) }
        app.session.edit { remove("uid") }
        app.auth?.signOut()
        recordJob?.cancel(); outboxJob?.cancel()
        uid = null; branchId = ""; branches = emptyList(); records = emptyList(); outbox = emptyList(); bill = JSONObject(); subscription = null
        message = "Signed out. Encrypted pending work is retained for the same account."
    }
}
