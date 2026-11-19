pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "FieldGuide"

include(":engine")

// The :app module requires the Android SDK. Skip it in headless environments (CI steps that
// only run JVM tests, dev containers) so `gradle :engine:test` works anywhere with a JDK.
//
// The trap this creates: a CI job that forgets to install the Android SDK degrades silently to
// an engine-only build — green, and proving nothing. Both standard workflows install the SDK
// for exactly this reason. Don't remove that step.
val hasAndroidSdk = System.getenv("ANDROID_HOME") != null ||
    file("local.properties").let { it.exists() && it.readText().contains("sdk.dir") }
if (hasAndroidSdk) {
    include(":app")
} else {
    logger.lifecycle("Android SDK not found — skipping :app (engine-only build).")
}
