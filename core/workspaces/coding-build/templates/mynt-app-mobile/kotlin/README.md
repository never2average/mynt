# Android starter (Kotlin, Jetpack Compose)

One screen that runs a Mynt journey on a client session. `python3 scripts/scaffold_app.py <dest> --mobile kotlin`
puts this in `mobile/`, copies the generated Kotlin SDK into `app/src/main/kotlin/` and fills in the
`__MYNT_SDK_PACKAGE__` imports with its package.

- Point it at your api (the service that holds the app key and answers `POST /session` with a `client_secret`):
  set `MYNT_API_URL` and `MYNT_URL` (Mynt's `/v1`, usually proxied by the api) in `gradle.properties`, or pass
  `-PMYNT_API_URL=... -PMYNT_URL=...`. They become `BuildConfig` fields. Never put an app key in the build.
- Build: `gradle wrapper && ./gradlew :app:assembleDebug`. Run: `./gradlew :app:installDebug` on an emulator or device.
- `FLAG_SECURE` on the activity, `allowBackup="false"`, customer input held in memory only.
- Secure fields (`capture: "secure_field"`) are masked. Hosted flows open in Custom Tabs and come back via
  `myntapp://journey?outcome=...`.
- Put each required document's exact text in `DOCUMENT_TEXT` and your journey id in `JOURNEY_ID`.
