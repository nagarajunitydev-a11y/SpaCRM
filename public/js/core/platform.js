/**
 * platform.js
 * Platform detection utilities.
 *
 * Detects if the app is running in the Android TWA wrapper by checking
 * for the `platform=android` query parameter added by LauncherActivity.
 */

const ANDROID_TWA_KEY = 'platform';
const ANDROID_TWA_VALUE = 'android';

let cachedIsAndroidTwa = null;

/**
 * Checks if the app is running in the Android TWA wrapper.
 * Reads the `platform=android` query parameter set by the native Android launcher.
 * Caches the result for subsequent calls.
 */
export function isAndroidTwa() {
    if (cachedIsAndroidTwa !== null) return cachedIsAndroidTwa;

    try {
        const params = new URLSearchParams(window.location.search);
        cachedIsAndroidTwa = params.get(ANDROID_TWA_KEY) === ANDROID_TWA_VALUE;
    } catch (e) {
        cachedIsAndroidTwa = false;
    }
    return cachedIsAndroidTwa;
}

/**
 * Clears the cached platform detection (useful for testing).
 */
export function resetPlatformCache() {
    cachedIsAndroidTwa = null;
}

export default {
    isAndroidTwa,
    resetPlatformCache,
};