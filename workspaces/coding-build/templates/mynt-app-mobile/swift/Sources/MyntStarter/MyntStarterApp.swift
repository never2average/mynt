// Runs a journey on a client session from your api (never an app key in the app). The SDK's JourneyRunner
// records the evidence and stores fields; this view only renders steps. Customer input lives in memory only.
import AuthenticationServices
import SwiftUI
import __MYNT_SDK_PACKAGE__

/// Build config: MyntAPIURL / MyntURL / MyntJourneyID in Info.plist (set them from an .xcconfig per build).
enum Config {
    static func value(_ key: String, _ fallback: String) -> String {
        (Bundle.main.object(forInfoDictionaryKey: key) as? String).flatMap { $0.isEmpty ? nil : $0 } ?? fallback
    }
    static let apiURL = value("MyntAPIURL", "http://localhost:8080")
    static let myntURL = value("MyntURL", "http://localhost:8080/v1")
    static let journeyId = value("MyntJourneyID", "default")
}

// The exact text of each document the product requires, as published by the provider. Show it verbatim.
let documentText: [String: String] = [:]

@main
struct MyntStarterApp: App {
    var body: some Scene { WindowGroup { JourneyView() } }
}

/// POST {apiURL}/session: your api mints a client session and returns its client_secret.
func mintSession() async throws -> String {
    var req = URLRequest(url: URL(string: Config.apiURL + "/session")!)
    req.httpMethod = "POST"
    let (data, res) = try await URLSession.shared.data(for: req)
    guard (res as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) == true,
          let secret = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["client_secret"] as? String
    else { throw URLError(.badServerResponse) }
    return secret
}

/// Opens a hosted flow in ASWebAuthenticationSession; resolves with the outcome from myntapp://journey?outcome=...
@MainActor
final class HostedFlow: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { ASPresentationAnchor() }

    func open(_ url: URL) async -> String {
        await withCheckedContinuation { done in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "myntapp") { callback, error in
                guard error == nil, let callback = callback else { return done.resume(returning: "failed") }
                let outcome = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "outcome" }?.value
                done.resume(returning: outcome ?? "completed")
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = true // no cookies left behind
            session.start()
        }
    }
}

struct JourneyView: View {
    @State private var runner: JourneyRunner?
    @State private var fields: [String: String] = [:] // in memory only, never persisted
    @State private var error: String?
    @State private var tick = 0
    private let hosted = HostedFlow()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) { content }.padding(16)
        }
        .task { await start() }
        .id(tick)
    }

    @ViewBuilder private var content: some View {
        if let error = error {
            Text(error).foregroundColor(.red)
        } else if let runner = runner {
            if runner.done || runner.current == nil {
                Text("All done.")
            } else {
                step(runner.current!)
            }
        } else {
            Text("Loading...")
        }
    }

    private func elements(_ step: JSON) -> [JSON] { step["screen"] as? [JSON] ?? [] }

    private func consentText(_ step: JSON) -> String? {
        (step["capture_consent"] as? String).map { "I agree to \($0.replacingOccurrences(of: "_", with: " "))." }
    }

    @ViewBuilder private func step(_ step: JSON) -> some View {
        if let title = step["title"] as? String { Text(title).font(.title2) }
        ForEach(Array(elements(step).enumerated()), id: \.offset) { _, e in
            switch e["type"] as? String {
            case "text": Text(e["text"] as? String ?? "")
            case "disclosure": Text(documentText[e["document"] as? String ?? ""] ?? "")
            case "field": field(e)
            default: EmptyView()
            }
        }
        if let consent = consentText(step) { Text(consent) }
        Button(step["action"] != nil ? "Continue to provider" : consentText(step) != nil ? "I agree" : "Continue") {
            Task { await next(step) }
        }
    }

    @ViewBuilder private func field(_ e: JSON) -> some View {
        let name = e["field"] as? String ?? ""
        let binding = Binding(get: { fields[name] ?? "" }, set: { fields[name] = $0 })
        if (e["capture"] as? String) == "secure_field" {
            SecureField(name, text: binding)
        } else {
            TextField(name, text: binding).autocorrectionDisabled()
        }
    }

    private func start() async {
        guard runner == nil else { return }
        do {
            let client = try MyntClient(clientSecret: try await mintSession(), baseURL: Config.myntURL)
            runner = try await JourneyRunner(client: client, journeyId: Config.journeyId)
        } catch { self.error = "\(error)" }
    }

    private func next(_ step: JSON) async {
        guard let runner = runner else { return }
        do {
            var documents: [String: String] = [:]
            for e in elements(step) where (e["type"] as? String) == "disclosure" {
                if let d = e["document"] as? String { documents[d] = documentText[d] ?? "" }
            }
            let input = StepInput(documents: documents, fields: fields, consentText: consentText(step))
            if let redirect = try await runner.complete(input), let url = URL(string: redirect) {
                let outcome = await hosted.open(url)
                try await runner.complete(StepInput(outcome: outcome))
            }
            fields = [:]
            tick += 1
        } catch { self.error = "\(error)" }
    }
}
