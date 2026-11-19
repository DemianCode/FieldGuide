plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

// The Android app is a thin WebView shell around the same static files GitHub Pages serves.
// They are copied from the repo root into a generated assets directory at build time, so the
// web app stays the single source of truth and nothing is duplicated in git. Add a path here
// if the web app grows a new top-level file or folder it loads at runtime.
abstract class SyncWebAssets : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val webFiles: ConfigurableFileCollection

    @get:Internal
    abstract val webRoot: DirectoryProperty

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @get:Inject
    abstract val fs: FileSystemOperations

    @TaskAction
    fun sync() {
        val root = webRoot.get().asFile
        fs.sync {
            from(root) { include(WEB_PATHS) }
            into(outputDir.get().asFile.resolve("web"))
        }
    }

    companion object {
        val WEB_PATHS = listOf(
            "index.html", "styles.css", "manifest.json",
            "js/**", "data/**", "icons/**",
        )
    }
}

val syncWebAssets = tasks.register<SyncWebAssets>("syncWebAssets") {
    val root = rootProject.layout.projectDirectory
    webRoot.set(root)
    webFiles.from(root.asFileTree.matching { include(SyncWebAssets.WEB_PATHS) })
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(syncWebAssets, SyncWebAssets::outputDir)
    }
}

// Release signing comes from the environment so no key material is ever committed.
// CI populates these from repository secrets (see .github/workflows/build-apk.yml).
// Treat the keystore as permanent: Android only installs an update over an existing app when
// the signing key is identical, so a lost or regenerated key means uninstalling (and losing
// any local data) before the next update can land.
val keystorePath: String? = System.getenv("ANDROID_KEYSTORE_FILE")?.takeIf { it.isNotBlank() }

// Every published build must be a *distinct, increasing* version, for two independent reasons:
// an update checker decides "an update is available" by comparing version strings, and Android
// only installs over an existing app when versionCode goes up. A hardcoded versionCode = 1
// makes both impossible, so CI passes its run number in here. Local builds leave the env var
// unset and get 1 / "<base>-dev", which never collides with a published build.
val baseVersionName: String = (findProperty("appVersionName") as String?) ?: "0.1.0"
val buildNumber: Int? = System.getenv("ANDROID_BUILD_NUMBER")?.toIntOrNull()?.takeIf { it > 0 }

android {
    namespace = "com.demian.fieldguide"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.demian.fieldguide"
        minSdk = 29
        targetSdk = 36
        versionCode = buildNumber ?: 1
        versionName = if (buildNumber != null) "$baseVersionName.$buildNumber" else "$baseVersionName-dev"
    }

    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Without a keystore AGP emits app-release-unsigned.apk, which Android refuses to
            // install. The release workflow's apksigner check fails the build rather than
            // publishing one, so this cannot silently regress.
            if (keystorePath != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation(project(":engine"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity)
    implementation(libs.androidx.webkit)
}
