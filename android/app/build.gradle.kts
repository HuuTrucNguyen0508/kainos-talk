import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.ksp)
    alias(libs.plugins.room)
    alias(libs.plugins.roborazzi)
}

// Release signing comes from android/signing.properties (git-ignored) or KAINOS_SIGNING_*
// environment variables: storeFile, storePassword, keyAlias, keyPassword. Without them a
// release build is unsigned; with only some of them it fails, so it never ships a wrong key.
val signingFile = Properties().apply {
    rootProject.file("signing.properties").takeIf { it.isFile }?.inputStream()?.use(::load)
}
val signingValues = listOf("storeFile", "storePassword", "keyAlias", "keyPassword").associateWith { key ->
    providers.environmentVariable("KAINOS_SIGNING_" + key.uppercase()).orNull ?: signingFile.getProperty(key)
}
val missingSigning = signingValues.filterValues { it == null }.keys
if (missingSigning.isNotEmpty() && missingSigning.size < signingValues.size) {
    throw GradleException("Release signing is missing $missingSigning (android/signing.properties or KAINOS_SIGNING_*)")
}

android {
    namespace = "app.kainos.talk"
    // Current AndroidX releases require compiling against 37; runtime behaviour follows targetSdk.
    compileSdk = 37

    defaultConfig {
        applicationId = "app.kainos.talk"
        minSdk = 33
        targetSdk = 36
        versionCode = 3
        versionName = "0.3.0"
        testInstrumentationRunner = "app.kainos.talk.KainosTestRunner"
    }

    if (missingSigning.isEmpty()) {
        signingConfigs.create("release") {
            storeFile = file(signingValues.getValue("storeFile")!!)
            storePassword = signingValues.getValue("storePassword")
            keyAlias = signingValues.getValue("keyAlias")
            keyPassword = signingValues.getValue("keyPassword")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            all {
                // Robolectric draws Compose with the real renderer, so screenshots show shadows and fonts.
                it.systemProperty("robolectric.pixelCopyRenderMode", "hardware")
                it.maxHeapSize = "2g"
            }
        }
    }

    lint {
        abortOnError = true
        checkDependencies = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_17
    }
}

room {
    schemaDirectory("$projectDir/schemas")
}

// Screenshots of setup and Connect to PC, light, dark and 200% font, recorded by
// `./gradlew :app:recordRoborazziDebug` and checked by `:app:verifyRoborazziDebug`.
roborazzi {
    outputDir.set(file("src/test/screenshots"))
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.compose.ui.tooling.preview)
    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)
    implementation(libs.room.runtime)
    ksp(libs.room.compiler)
    implementation(libs.kotlinx.coroutines.android)

    testImplementation(libs.junit)
    // org.json is part of Android; plain JVM unit tests need the real library.
    testImplementation(libs.json)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)

    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.kotlinx.coroutines.test)
    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.ui.test.junit4)
    // ui-test-junit4 brings Espresso 3.5, which fails on Android 17 (InputManager.getInstance is gone).
    androidTestImplementation(libs.espresso.core)
}

