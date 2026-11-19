plugins {
    alias(libs.plugins.kotlin.jvm)
}

// Pure JVM on purpose. Logic that lives here is testable with `gradle :engine:test` on any
// machine with a JDK — no Android SDK, no emulator, no instrumentation. Push everything that
// does not need an Android API into this module; it is the only code the standard build-check
// can actually run assertions against.
kotlin {
    jvmToolchain(17)
}

dependencies {
    testImplementation(libs.junit)
}
