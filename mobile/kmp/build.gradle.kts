plugins {
    kotlin("multiplatform") version "2.4.20"
}

kotlin {
    jvm()
    iosArm64()
    iosSimulatorArm64()

    sourceSets {
        commonMain.dependencies {
            implementation("androidx.sqlite:sqlite:2.7.1")
            implementation("androidx.sqlite:sqlite-bundled:2.7.1")
            implementation("com.squareup.okio:okio:3.18.2")
            implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
        }
    }
}
