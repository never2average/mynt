plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "app.mynt.starter"
    compileSdk = 34
    defaultConfig {
        applicationId = "app.mynt.starter"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
        // Only URLs go in the build; the app key stays on your api server.
        buildConfigField("String", "API_URL", "\"" + project.property("MYNT_API_URL") + "\"")
        buildConfigField("String", "MYNT_URL", "\"" + project.property("MYNT_URL") + "\"")
        buildConfigField("String", "JOURNEY_ID", "\"default\"")
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.09.00"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.browser:browser:1.8.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}
