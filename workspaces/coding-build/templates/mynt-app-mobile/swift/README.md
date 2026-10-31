# iOS starter (SwiftUI)

One view that runs a Mynt journey on a client session. `python3 scripts/scaffold_app.py <dest> --mobile swift`
puts this in `mobile/`, copies the generated Swift SDK package into `mobile/MyntSDK/` and fills in
`__MYNT_SDK_PACKAGE__` with its module name.

- Point it at your api (the service that holds the app key and answers `POST /session` with a `client_secret`):
  set `MyntAPIURL`, `MyntURL` (Mynt's `/v1`, usually proxied by the api) and `MyntJourneyID` in the app's
  Info.plist, ideally from an `.xcconfig` per build configuration. Never put an app key in the app.
- Build: `swift build` (checks the code on macOS). Run on iOS: `open Package.swift` in Xcode, pick an iOS
  simulator, Run. Register the `myntapp` URL scheme in the app target for hosted-flow returns.
- Secure fields (`capture: "secure_field"`) use `SecureField`. Hosted flows open in
  `ASWebAuthenticationSession` (ephemeral) and come back via `myntapp://journey?outcome=...`.
- Customer input is held in memory only. Put each required document's exact text in `documentText`.
