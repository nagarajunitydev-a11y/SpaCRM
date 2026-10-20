package com.luxeglow.crm;

import android.annotation.SuppressLint;
import android.app.Activity;
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
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Thin HTTPS-only container for hosted Qvrix GlowOS. No web CRM assets are bundled. */
public class LauncherActivity extends Activity {
    private static final int FILE_CHOOSER_REQUEST = 41;
    private static final String CACHE_MIGRATION_PREFERENCES = "spacrm_wrapper";
    private static final String CACHE_MIGRATION_KEY = "web_cache_migration_v2";
    private WebView webView;
    private ImageView loadingScreen;
    private LinearLayout errorPanel;
    private TextView errorDetail;
    private ValueCallback<Uri[]> pendingFileChooser;
    private Uri homeUri;
    private boolean pageLoadFailed;
    private boolean refreshOnResume;
    private boolean returningFromExternalActivity;
    private final Handler loadHandler = new Handler(Looper.getMainLooper());
    private final Runnable loadTimeout = () -> showError("Loading took too long. Check your connection and retry.");
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
        root.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        loadingScreen = new ImageView(this);
        loadingScreen.setImageResource(R.drawable.loading_screen);
        // Keep the supplied artwork and lettering intact on different screens.
        loadingScreen.setScaleType(ImageView.ScaleType.FIT_CENTER);
        loadingScreen.setBackgroundColor(Color.parseColor("#020617"));
        loadingScreen.setContentDescription(getString(R.string.loading_screen_description));
        loadingScreen.setClickable(true);
        root.addView(loadingScreen, new FrameLayout.LayoutParams(-1, -1));
        errorPanel = new LinearLayout(this);
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
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return request.isForMainFrame() && blockUntrustedNavigation(request.getUrl()); }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) { return blockUntrustedNavigation(Uri.parse(url)); }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                pageLoadFailed = false;
                loadingScreen.setVisibility(View.VISIBLE); errorPanel.setVisibility(View.GONE);
                loadHandler.removeCallbacks(loadTimeout);
                loadHandler.postDelayed(loadTimeout, 30000);
            }
            @Override public void onPageFinished(WebView view, String url) {
                loadHandler.removeCallbacks(loadTimeout);
                loadingScreen.setVisibility(View.GONE);
                if (!pageLoadFailed && isAllowedUrl(Uri.parse(url))) removeLegacyPwaCacheOnce();
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) { if (request.isForMainFrame()) showError("Check your internet connection and try again."); }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) { if (request.isForMainFrame() && response.getStatusCode() >= 400) showError("The Qvrix GlowOS service is temporarily unavailable."); }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, android.net.http.SslError error) { handler.cancel(); showError("A secure connection to Qvrix GlowOS could not be established."); }
        });
        webView.setWebChromeClient(new WebChromeClient() {
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
    }

    /** Lets trusted, same-origin JS ask the Activity to close after the user confirms Exit. */
    private final class ExitBridge {
        @JavascriptInterface
        public void cacheMigrationComplete(boolean success) {
            if (!success) return; // Retry on the next successful page load.
            runOnUiThread(() -> {
                if (pageLoadFailed || webView.getUrl() == null || !isAllowedUrl(Uri.parse(webView.getUrl()))) return;
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
        if (scheme != null && (scheme.equalsIgnoreCase("https") || scheme.equalsIgnoreCase("http")
                || scheme.equalsIgnoreCase("mailto") || scheme.equalsIgnoreCase("tel")
                || scheme.equalsIgnoreCase("sms") || scheme.equalsIgnoreCase("upi"))) {
            try {
                returningFromExternalActivity = true;
                startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
            } catch (ActivityNotFoundException e) {
                returningFromExternalActivity = false;
                android.widget.Toast.makeText(this, "No app is available to open this link.", android.widget.Toast.LENGTH_SHORT).show();
            }
            return true;
        }
        showError("For your security, this app only opens the configured HTTPS Qvrix GlowOS site.");
        return true;
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
        if (preferences.getBoolean(CACHE_MIGRATION_KEY + ":" + homeUri.getHost(), false)) return;
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

    private boolean isOnline() {
        ConnectivityManager manager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null || manager.getActiveNetwork() == null) return false;
        NetworkCapabilities caps = manager.getNetworkCapabilities(manager.getActiveNetwork());
        return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    private void loadHome() {
        if (!isOnline()) { showError("You appear to be offline. Connect to the internet and retry."); return; }
        errorPanel.setVisibility(View.GONE); loadingScreen.setVisibility(View.VISIBLE); webView.loadUrl(homeUri.toString());
    }

    private void showError(String message) {
        pageLoadFailed = true;
        loadHandler.removeCallbacks(loadTimeout);
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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
        }
        if (pendingFileChooser != null) pendingFileChooser.onReceiveValue(null);
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
