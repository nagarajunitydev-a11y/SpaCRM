package com.qvrix.glowos.nativeapp.sync

import android.content.Context
import androidx.work.*
import com.qvrix.glowos.nativeapp.GlowApplication
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.TimeUnit

class SyncWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val uid = inputData.getString("uid") ?: return Result.failure()
        val app = applicationContext as GlowApplication
        if (uid == "demo" || app.activeUid() != uid) return Result.success()
        val auth = app.auth ?: return Result.failure()
        return withAccountLock(uid) {
            val repo = app.repository(uid)
            val api = SyncApi(auth, uid)
            try {
                // Full bounded consistent snapshots deliberately include legacy web
                // writes/deletions until every writer participates in a change feed.
                val branches = api.branches()
                repo.reconcileAuthorisedBranches((0 until branches.length()).map { branches.getJSONObject(it).getString("id") }.toSet())
                var retry = false
                for (index in 0 until branches.length()) {
                    if (app.activeUid() != uid) return@withAccountLock Result.success()
                    try { repo.applySnapshot(api.snapshot(branches.getJSONObject(index).getString("id"))) }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (error: ApiFailure) {
                        if (error.status in listOf(401, 426)) {
                            for (pending in repo.dao.pending()) repo.transportFailure(pending.commandId, error.code, true)
                            return@withAccountLock Result.failure(workDataOf("code" to error.code))
                        }
                        if (error.status in listOf(408, 429) || error.status >= 500) retry = true
                        // A branch-specific denial/size failure must not starve
                        // pending commands belonging to other authorised branches.
                    }
                }
                for (command in repo.dao.pending()) {
                    if (app.activeUid() != uid) return@withAccountLock Result.success()
                    try { repo.applyResult(command.commandId, api.push(repo.commandJson(command))) }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (error: Exception) {
                        val apiError = error as? ApiFailure
                        val transient = apiError == null || apiError.status in listOf(408, 429) || apiError.status >= 500
                        repo.transportFailure(command.commandId, apiError?.code ?: "CONNECTION_FAILED", !transient)
                        if (transient) retry = true
                        if (apiError?.status in listOf(401, 403, 426)) break
                    }
                }
                if (retry) Result.retry() else Result.success()
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) {
                val apiError = error as? ApiFailure
                val terminal = apiError?.status in listOf(401, 403, 413, 426)
                for (pending in repo.dao.pending()) repo.transportFailure(pending.commandId, apiError?.code ?: "CONNECTION_FAILED", terminal)
                if (terminal) Result.failure(workDataOf("code" to apiError?.code)) else Result.retry()
            }
        }
    }
    companion object {
        private val locks = mutableMapOf<String, Mutex>()
        suspend fun <T> withAccountLock(uid: String, action: suspend () -> T): T =
            synchronized(locks) { locks.getOrPut(uid) { Mutex() } }.withLock { action() }
        private val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        fun enqueue(context: Context, uid: String) {
            if (uid == "demo") return
            val work = OneTimeWorkRequestBuilder<SyncWorker>().setInputData(workDataOf("uid" to uid)).setConstraints(constraints)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).addTag("account/$uid").build()
            WorkManager.getInstance(context).enqueueUniqueWork("sync/$uid", ExistingWorkPolicy.APPEND_OR_REPLACE, work)
            val periodic = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES).setInputData(workDataOf("uid" to uid))
                .setConstraints(constraints).addTag("account/$uid").build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork("reconcile/$uid", ExistingPeriodicWorkPolicy.KEEP, periodic)
        }
        fun cancel(context: Context, uid: String) { WorkManager.getInstance(context).cancelAllWorkByTag("account/$uid") }
    }
}
