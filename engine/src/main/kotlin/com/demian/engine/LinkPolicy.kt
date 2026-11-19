package com.demian.engine

import java.net.URI

/**
 * Decides where a URL the web app navigates to should open.
 *
 * The bundled web app is served from [APP_HOST] (androidx.webkit's WebViewAssetLoader), which
 * gives it a real https origin so fetch(), IndexedDB and localStorage behave as on the web.
 * Anything else the user taps — Wikipedia articles, photo credits, licence pages — belongs in
 * the browser, not inside the app's WebView.
 */
object LinkPolicy {
    const val APP_HOST = "appassets.androidplatform.net"
    const val START_URL = "https://$APP_HOST/assets/web/index.html"

    enum class Target { IN_APP, EXTERNAL, BLOCKED }

    fun classify(url: String): Target {
        val uri = try {
            URI(url.trim())
        } catch (_: Exception) {
            return Target.BLOCKED
        }
        return when (uri.scheme?.lowercase()) {
            "https" -> if (uri.host.equals(APP_HOST, ignoreCase = true)) Target.IN_APP else Target.EXTERNAL
            "http", "mailto" -> Target.EXTERNAL
            // javascript:, file:, data:, intent: and the like never navigate the shell.
            else -> Target.BLOCKED
        }
    }
}
