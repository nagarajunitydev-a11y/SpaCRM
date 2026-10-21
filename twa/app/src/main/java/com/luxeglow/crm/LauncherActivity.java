package com.luxeglow.crm;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.Dialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.net.URISyntaxException;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/** Thin HTTPS-only container for hosted Qvrix GlowOS. No web CRM assets are bundled. */
public class LauncherActivity extends Activity {
    private static final int FILE_CHOOSER_REQUEST = 41;
    private static final String CACHE_MIGRATION_PREFERENCES = "spacrm_wrapper";
    private static final String CACHE_MIGRATION_KEY = "web_cache_migration_v2";
    /** Schemes handed to other apps: links, contacts, and UPI apps used by the payment sheet. */
    private static final Set<String> EXTERNAL_SCHEMES = new HashSet<>(Arrays.asList(
            "https", "http", "mailto", "tel", "sms", "upi", "tez", "phonepe", "paytmmp", "gpay", "credpay", "bhim"));
    private WebView webView;
    private LoadingScreenView loadingScreen;
    private LinearLayout errorPanel;
    private TextView errorDetail;
    private ValueCallback<Uri[]> pendingFileChooser;
    private Uri homeUri;
    private boolean pageLoadFailed;
    private boolean refreshOnResume;
    private boolean returningFromExternalActivity;
    private PlayBillingBridge billing;
    /** True only while the payment sheet is open; it may open bank / 3-D Secure windows. */
    private boolean checkoutActive;
    private int loadGeneration;
    private final Handler loadHandler = new Handler(Looper.getMainLooper());
    private final Runnable loadTimeout = () -> showError("Loading took too long. Check your connection and retry.");
    private final Runnable contentProbe = this::checkInitialContent;
    private final OnBackInvokedCallback backCallback = this::handleBackNavigation;

    @SuppressLint("SetJavaScriptEnabled")
    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        homeUri = withAndroidPlatform(Uri.parse(BuildConfig.SPACRM_PRODUCTION_URL));
        if (!isAllowedUrl(homeUri)) throw new IllegalStateException("SPACRM_PRODUCTION_URL must be HTTPS.");
        configureWindow();
        createContent();
        configureWebView();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCallback);
        }
        // A saved WebView history can contain a previous deployment. Always
        // request the hosted entry point; Firebase and app sessions persist in
        // cookies/DOM storage and are not cleared by this refresh.
        loadHome();
        hideSystemUI();
    }

    private void configureWindow() {
        Window window = getWindow();
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        window.setStatusBarColor(Color.parseColor("#0F0A12"));
        window.setNavigationBarColor(Color.parseColor("#020617"));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) window.getAttributes().layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
    }

    private void createContent() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#020617"));
        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#020617"));
        root.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        loadingScreen = new LoadingScreenView(this);
        root.addView(loadingScreen, new FrameLayout.LayoutParams(-1, -1));
        errorPanel = new LinearLayout(this);
        errorPanel.setBackgroundColor(Color.parseColor("#020617"));
        errorPanel.setOrientation(LinearLayout.VERTICAL);
        errorPanel.setGravity(Gravity.CENTER);
        errorPanel.setPadding(48, 48, 48, 48);
        errorPanel.setVisibility(View.GONE);
        TextView title = new TextView(this);
        title.setText("Unable to load Qvrix GlowOS"); title.setTextColor(Color.WHITE); title.setTextSize(18); title.setGravity(Gravity.CENTER);
        errorDetail = new TextView(this);
        errorDetail.setTextColor(Color.parseColor("#94A3B8")); errorDetail.setTextSize(13); errorDetail.setGravity(Gravity.CENTER); errorDetail.setPadding(0, 16, 0, 24);
        Button retry = new Button(this); retry.setText("Retry"); retry.setOnClickListener(v -> loadHome());
        errorPanel.addView(title); errorPanel.addView(errorDetail); errorPanel.addView(retry);
        root.addView(errorPanel, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true); settings.setDatabaseEnabled(true);
        settings.setUserAgentString(settings.getUserAgentString() + " QvrixGlowOSAndroid/1");
        // The CRM is hosted. Bypass WebView's HTTP cache while retaining DOM
        // storage, cookies and IndexedDB. Legacy PWA shell caches are removed below.
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE); settings.setAllowFileAccess(false); settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW); settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setLoadWithOverviewMode(true); settings.setUseWideViewPort(true); settings.setSupportMultipleWindows(false);
        CookieManager cookies = CookieManager.getInstance(); cookies.setAcceptCookie(true); cookies.setAcceptThirdPartyCookies(webView, true);
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // App links (e.g. upi://) from the payment frame cannot load in a WebView; hand them to the app.
                return (request.isForMainFrame() || !isWebScheme(request.getUrl())) && blockUntrustedNavigation(request.getUrl());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) { return blockUntrustedNavigation(Uri.parse(url)); }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                loadGeneration++;
                pageLoadFailed = false;
                showLoading(); errorPanel.setVisibility(View.GONE);
                loadHandler.removeCallbacks(contentProbe);
                loadHandler.removeCallbacks(loadTimeout);
                loadHandler.postDelayed(loadTimeout, 30000);
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (!pageLoadFailed && isAllowedUrl(Uri.parse(url))) removeLegacyPwaCacheOnce();
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) { if (request.isForMainFrame()) showError("Check your internet connection and try again."); }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) { if (request.isForMainFrame() && response.getStatusCode() >= 400) showError("The Qvrix GlowOS service is temporarily unavailable."); }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, android.net.http.SslError error) { handler.cancel(); showError("A secure connection to Qvrix GlowOS could not be established."); }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                return checkoutActive && openPaymentWindow(resultMsg);
            }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFileChooser != null) pendingFileChooser.onReceiveValue(null);
                pendingFileChooser = callback;
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT); pick.addCategory(Intent.CATEGORY_OPENABLE); pick.setType("*/*");
                pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    returningFromExternalActivity = true;
                    startActivityForResult(Intent.createChooser(pick, "Select file"), FILE_CHOOSER_REQUEST);
                }
                catch (ActivityNotFoundException e) { returningFromExternalActivity = false; pendingFileChooser.onReceiveValue(null); pendingFileChooser = null; }
                return true;
            }
        });
        webView.setDownloadListener((url, userAgent, disposition, mimeType, length) -> download(url, userAgent, disposition, mimeType));
        // Bridge for the web app's own Back-button exit-confirmation flow
        // (core/exitGuard.js): JS cannot close a native Activity on its own,
        // so "Exit" in the confirmation dialog calls this after the user has
        // explicitly agreed to leave. The WebView is locked to a single
        // trusted HTTPS origin (see isAllowedUrl), so exposing this is safe.
        webView.addJavascriptInterface(new ExitBridge(), "AndroidNative");
        // Google Play Billing (user choice) for subscription purchases, only for
        // main-frame scripts from the configured origin.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            billing = new PlayBillingBridge(this, this::setCheckoutActive);
            WebViewCompat.addWebMessageListener(webView, "AndroidBilling", Collections.singleton(originOf(homeUri)), billing);
        }
    }

    private static String originOf(Uri uri) {
        return uri.getScheme() + "://" + uri.getHost() + (uri.getPort() == -1 ? "" : ":" + uri.getPort());
    }

    private static boolean isWebScheme(Uri uri) {
        String scheme = uri.getScheme();
        return "https".equalsIgnoreCase(scheme) || "http".equalsIgnoreCase(scheme);
    }

    /** Pop-up windows are enabled only while checkout is open; otherwise links behave as before. */
    private void setCheckoutActive(boolean active) {
        checkoutActive = active;
        webView.getSettings().setSupportMultipleWindows(active);
        webView.getSettings().setJavaScriptCanOpenWindowsAutomatically(active);
    }

    /** Bank / 3-D Secure / net-banking window opened by the payment sheet, shown full screen. */
    @SuppressLint("SetJavaScriptEnabled")
    private boolean openPaymentWindow(Message resultMsg) {
        WebView popup = new WebView(this);
        WebSettings settings = popup.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true); settings.setSupportMultipleWindows(false);
        settings.setAllowFileAccess(false); settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptThirdPartyCookies(popup, true);
        Dialog dialog = new Dialog(this, android.R.style.Theme_Black_NoTitleBar_Fullscreen);
        dialog.setContentView(popup);
        dialog.setOnDismissListener(d -> popup.destroy());
        popup.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("https".equalsIgnoreCase(uri.getScheme())) return false;
                openExternal(uri);
                return true;
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, android.net.http.SslError error) { handler.cancel(); }
        });
        popup.setWebChromeClient(new WebChromeClient() {
            @Override public void onCloseWindow(WebView window) { dialog.dismiss(); }
        });
        ((WebView.WebViewTransport) resultMsg.obj).setWebView(popup);
        resultMsg.sendToTarget();
        dialog.show();
        return true;
    }

    /** Lets trusted, same-origin JS ask the Activity to close after the user confirms Exit. */
    private final class ExitBridge {
        @JavascriptInterface
        public void cacheMigrationComplete(boolean success) {
            runOnUiThread(() -> {
                if (pageLoadFailed || webView.getUrl() == null || !isAllowedUrl(Uri.parse(webView.getUrl()))) return;
                if (!success) {
                    // Keep the existing retry-on-next-load migration behavior.
                    checkInitialContent();
                    return;
                }
                getSharedPreferences(CACHE_MIGRATION_PREFERENCES, MODE_PRIVATE)
                        .edit().putBoolean(CACHE_MIGRATION_KEY + ":" + homeUri.getHost(), true).apply();
                webView.reload();
            });
        }

        @JavascriptInterface
        public void exitApp() {
            runOnUiThread(LauncherActivity.this::finish);
        }
    }

    private boolean blockUntrustedNavigation(Uri uri) {
        if (isAllowedUrl(uri)) return false;
        // Keep external websites, contact links and payment-app handoffs outside
        // the WebView, which exposes the native exit bridge only to our origin.
        String scheme = uri.getScheme();
        if (scheme != null && (EXTERNAL_SCHEMES.contains(scheme.toLowerCase(Locale.ROOT)) || scheme.equalsIgnoreCase("intent"))) {
            openExternal(uri);
            return true;
        }
        showError("For your security, this app only opens the configured HTTPS Qvrix GlowOS site.");
        return true;
    }

    private void openExternal(Uri uri) {
        Intent intent;
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if ("intent".equals(scheme)) {
            // Payment-app handoff: never allow an explicit component or selector.
            try { intent = Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME); }
            catch (URISyntaxException e) { return; }
            intent.setComponent(null);
            intent.setSelector(null);
        } else if (EXTERNAL_SCHEMES.contains(scheme)) {
            intent = new Intent(Intent.ACTION_VIEW, uri);
        } else {
            return;
        }
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        try {
            returningFromExternalActivity = true;
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            returningFromExternalActivity = false;
            android.widget.Toast.makeText(this, "No app is available to open this link.", android.widget.Toast.LENGTH_SHORT).show();
        }
    }

    private boolean isAllowedUrl(Uri uri) {
        return isSecureUrl(uri) && homeUri != null
            && homeUri.getHost() != null && homeUri.getHost().equalsIgnoreCase(uri.getHost());
    }

    private boolean isSecureUrl(Uri uri) {
        return uri != null && "https".equalsIgnoreCase(uri.getScheme()) && uri.getHost() != null;
    }

    private Uri withAndroidPlatform(Uri configuredUrl) {
        if (configuredUrl == null || "android".equals(configuredUrl.getQueryParameter("platform"))) return configuredUrl;
        return configuredUrl.buildUpon().appendQueryParameter("platform", "android").build();
    }

    /**
     * Removes legacy PWA shell caches once when an existing app is updated to
     * this wrapper. It deliberately does not clear cookies, local/session
     * storage, IndexedDB, Firebase auth, or any CRM data.
     */
    private void removeLegacyPwaCacheOnce() {
        SharedPreferences preferences = getSharedPreferences(CACHE_MIGRATION_PREFERENCES, MODE_PRIVATE);
        if (preferences.getBoolean(CACHE_MIGRATION_KEY + ":" + homeUri.getHost(), false)) {
            checkInitialContent();
            return;
        }
        webView.clearCache(true); // WebView HTTP/resource cache only.
        webView.evaluateJavascript(
                "(async()=>{try{if('serviceWorker' in navigator){"
                        + "const registrations=await navigator.serviceWorker.getRegistrations();"
                        + "await Promise.all(registrations.map((registration)=>registration.unregister()));}}"
                        + "catch(e){console.warn('Qvrix GlowOS service worker migration failed',e);return false;}"
                        + "try{if('caches' in window){const keys=await caches.keys();await Promise.all(keys.map((key)=>caches.delete(key)));}}"
                        + "catch(e){console.warn('Qvrix GlowOS cache migration failed',e);return false;}"
                        + "return true;})().then(ok=>window.AndroidNative.cacheMigrationComplete(ok))",
                null);
    }

    private void showLoading() {
        loadingScreen.animate().cancel();
        loadingScreen.setAlpha(1f);
        loadingScreen.setVisibility(View.VISIBLE);
    }

    /** HTML finishing does not mean the asynchronous Firebase/SPA shell has rendered. */
    private void checkInitialContent() {
        if (pageLoadFailed || isDestroyed() || loadingScreen.getVisibility() != View.VISIBLE) return;
        final int generation = loadGeneration;
        loadHandler.removeCallbacks(contentProbe);
        webView.evaluateJavascript("(()=>{const app=document.getElementById('app');"
                + "return !!(app && app.childElementCount && app.getBoundingClientRect().height>0);})()", result -> {
            if (generation != loadGeneration || pageLoadFailed || isDestroyed()) return;
            if (!"true".equals(result)) {
                loadHandler.postDelayed(contentProbe, 100);
                return;
            }
            // Wait for the rendered DOM to reach the WebView compositor before revealing it.
            webView.postVisualStateCallback(generation, new WebView.VisualStateCallback() {
                @Override public void onComplete(long requestId) {
                    if (generation != loadGeneration || pageLoadFailed || isDestroyed()) return;
                    loadHandler.removeCallbacks(loadTimeout);
                    loadingScreen.animate().alpha(0f).setDuration(180).withEndAction(() -> {
                        if (generation == loadGeneration && !pageLoadFailed) loadingScreen.setVisibility(View.GONE);
                    }).start();
                }
            });
        });
    }

    private boolean isOnline() {
        ConnectivityManager manager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null || manager.getActiveNetwork() == null) return false;
        NetworkCapabilities caps = manager.getNetworkCapabilities(manager.getActiveNetwork());
        return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    private void loadHome() {
        if (!isOnline()) { showError("You appear to be offline. Connect to the internet and retry."); return; }
        errorPanel.setVisibility(View.GONE); showLoading(); webView.loadUrl(homeUri.toString());
    }

    private void showError(String message) {
        pageLoadFailed = true;
        loadHandler.removeCallbacks(loadTimeout);
        loadHandler.removeCallbacks(contentProbe);
        loadingScreen.animate().cancel();
        loadingScreen.setVisibility(View.GONE); errorDetail.setText(message); errorPanel.setVisibility(View.VISIBLE);
    }

    private void download(String url, String userAgent, String disposition, String mimeType) {
        Uri uri = Uri.parse(url);
        if (!isSecureUrl(uri)) { showError("Downloads must use a secure HTTPS connection."); return; }
        DownloadManager.Request request = new DownloadManager.Request(uri);
        request.setMimeType(mimeType); request.addRequestHeader("User-Agent", userAgent);
        String cookies = CookieManager.getInstance().getCookie(url);
        if (cookies != null) request.addRequestHeader("Cookie", cookies);
        request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, android.webkit.URLUtil.guessFileName(url, disposition, mimeType));
        ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(request);
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQUEST && pendingFileChooser != null) {
            pendingFileChooser.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data)); pendingFileChooser = null;
        }
    }

    private void handleBackNavigation() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else finish();
    }

    @Override
    @SuppressLint("GestureBackNavigation") // Android 12 and earlier use this fallback.
    public void onBackPressed() { handleBackNavigation(); }
    @Override protected void onSaveInstanceState(Bundle outState) { webView.saveState(outState); super.onSaveInstanceState(outState); }
    @Override protected void onPause() { CookieManager.getInstance().flush(); webView.onPause(); super.onPause(); }
    @Override protected void onStop() { super.onStop(); refreshOnResume = true; }
    @Override protected void onResume() {
        super.onResume(); webView.onResume(); hideSystemUI();
        if (refreshOnResume && !returningFromExternalActivity && pendingFileChooser == null
                && !pageLoadFailed && isOnline()) {
            // The web app refreshes only at an idle landing screen; forms,
            // checkout, uploads and navigation elsewhere are left intact.
            webView.evaluateJavascript("window.dispatchEvent(new Event('qvrix:foreground'))", null);
        }
        refreshOnResume = false;
        returningFromExternalActivity = false;
    }
    @Override protected void onDestroy() {
        loadHandler.removeCallbacks(loadTimeout);
        loadHandler.removeCallbacks(contentProbe);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
        }
        if (pendingFileChooser != null) pendingFileChooser.onReceiveValue(null);
        if (billing != null) billing.destroy();
        if (webView != null) webView.destroy();
        super.onDestroy();
    }

    @SuppressLint("NewApi") private void hideSystemUI() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) { controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars()); controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE); }
        } else getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }
}
