package com.demian.fieldguide

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.widget.FrameLayout
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.webkit.WebViewAssetLoader
import com.demian.engine.LinkPolicy

/**
 * A WebView shell around the FieldGuide web app. The web files are bundled in the APK (see the
 * syncWebAssets task in app/build.gradle.kts) and served from a virtual https origin, so the
 * app opens offline and keeps its decks in the WebView's own IndexedDB/localStorage.
 *
 * Everything the browser gives a PWA for free and a bare WebView doesn't is filled in here:
 * file pickers, saving an exported deck, opening outside links in the browser, and Back.
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView

    private var pendingFileChooser: ValueCallback<Array<Uri>>? = null
    private val fileChooserLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            pendingFileChooser?.onReceiveValue(
                WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data),
            )
            pendingFileChooser = null
        }

    private var pendingExport: String? = null
    private val exportLauncher =
        registerForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
            val text = pendingExport
            pendingExport = null
            if (uri == null || text == null) return@registerForActivityResult
            try {
                contentResolver.openOutputStream(uri)!!.use { it.write(text.toByteArray()) }
                toast("Deck exported")
            } catch (e: Exception) {
                toast("Couldn't save the file")
            }
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        val assetLoader = WebViewAssetLoader.Builder()
            .setDomain(LinkPolicy.APP_HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            setBackgroundColor(getColor(R.color.app_background))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            // The asset loader serves the app over https; nothing needs file:// or content://.
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            webViewClient = ShellClient(assetLoader)
            webChromeClient = ShellChromeClient()
            addJavascriptInterface(Bridge(), "FieldGuideAndroid")
        }

        // targetSdk 36 is always edge-to-edge; keep the page clear of the system bars and the
        // keyboard, painting the gaps in the app's background colour. The padding goes on a
        // container because a WebView scrolls its content underneath its own padding.
        val root = FrameLayout(this).apply {
            setBackgroundColor(getColor(R.color.app_background))
            addView(webView)
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or
                    WindowInsetsCompat.Type.displayCutout() or
                    WindowInsetsCompat.Type.ime(),
            )
            view.updatePadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript(
                    "window.fieldGuideHandleBack ? window.fieldGuideHandleBack() : false",
                ) { handled ->
                    if (handled != "true") {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                        isEnabled = true
                    }
                }
            }
        })

        if (savedInstanceState == null) {
            webView.loadUrl(LinkPolicy.START_URL)
        } else {
            webView.restoreState(savedInstanceState)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    private fun openExternally(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (e: ActivityNotFoundException) {
            toast("No app can open this link")
        }
    }

    private fun toast(message: String) =
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()

    private inner class ShellClient(private val assetLoader: WebViewAssetLoader) : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            assetLoader.shouldInterceptRequest(request.url)

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            return when (LinkPolicy.classify(url)) {
                LinkPolicy.Target.IN_APP -> false
                LinkPolicy.Target.EXTERNAL -> {
                    openExternally(url)
                    true
                }
                LinkPolicy.Target.BLOCKED -> true
            }
        }
    }

    private inner class ShellChromeClient : WebChromeClient() {
        // <input type="file">: JSON deck import and card photos.
        override fun onShowFileChooser(
            webView: WebView,
            filePathCallback: ValueCallback<Array<Uri>>,
            fileChooserParams: FileChooserParams,
        ): Boolean {
            pendingFileChooser?.onReceiveValue(null)
            pendingFileChooser = filePathCallback
            return try {
                fileChooserLauncher.launch(fileChooserParams.createIntent())
                true
            } catch (e: ActivityNotFoundException) {
                pendingFileChooser = null
                false
            }
        }

        // target="_blank" links (photo credits, Wikipedia) arrive as new-window requests when
        // multiple windows are off, so they're handled by shouldOverrideUrlLoading above.
    }

    /** Exposed to the page as window.FieldGuideAndroid. Called on a binder thread. */
    private inner class Bridge {
        @JavascriptInterface
        @Suppress("UNUSED_PARAMETER") // the picker is always JSON today; kept for the JS signature
        fun saveTextFile(fileName: String, mimeType: String, text: String) {
            runOnUiThread {
                pendingExport = text
                exportLauncher.launch(fileName)
            }
        }
    }
}
