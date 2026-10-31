# Flutter starter

One screen that runs a Mynt journey on a client session. `python3 scripts/scaffold_app.py <dest> --mobile flutter`
puts this in `mobile/`, copies the generated Dart SDK into `mobile/mynt_sdk/` and fills in
`__MYNT_SDK_PACKAGE__` with its package name.

- Point it at your api (the service that holds the app key and answers `POST /session` with a `client_secret`)
  with build-time defines: `--dart-define=MYNT_API_URL=https://your-api --dart-define=MYNT_URL=https://your-api/v1
  --dart-define=MYNT_JOURNEY_ID=default`. Never put an app key in the app.
- First time: `flutter create --platforms=android,ios .` (adds the platform folders), then `flutter pub get`.
- Run: `flutter run --dart-define=...`. Build: `flutter build apk --dart-define=...` / `flutter build ipa --dart-define=...`.
- Secure fields (`capture: "secure_field"`) use `obscureText`. Hosted flows open with `url_launcher` in
  `LaunchMode.inAppBrowserView`; on return the journey moves on (wire `myntapp://journey?outcome=...` for the real outcome).
- Customer input is held in memory only. Put each required document's exact text in `documentText`.
