// Runs a journey on a client session from your api (never an app key in the app). The SDK's JourneyRunner
// records the evidence and stores fields; this screen only renders steps. Customer input lives in memory only.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';
import 'package:__MYNT_SDK_PACKAGE__/__MYNT_SDK_PACKAGE__.dart';

// Build config: flutter run --dart-define=MYNT_API_URL=... --dart-define=MYNT_URL=...
const apiUrl = String.fromEnvironment('MYNT_API_URL', defaultValue: 'http://10.0.2.2:8080');
const myntUrl = String.fromEnvironment('MYNT_URL', defaultValue: 'http://10.0.2.2:8080/v1');
const journeyId = String.fromEnvironment('MYNT_JOURNEY_ID', defaultValue: 'default');

// The exact text of each document the product requires, as published by the provider. Show it verbatim.
const documentText = <String, String>{};

void main() => runApp(const MaterialApp(home: JourneyScreen()));

/// POST {apiUrl}/session: your api mints a client session and returns its client_secret.
Future<String> mintSession() async {
  final res = await http.post(Uri.parse('$apiUrl/session'));
  if (res.statusCode < 200 || res.statusCode > 299) throw Exception("Couldn't start a session");
  return (jsonDecode(res.body) as Map<String, dynamic>)['client_secret'] as String;
}

class JourneyScreen extends StatefulWidget {
  const JourneyScreen({super.key});
  @override
  State<JourneyScreen> createState() => _JourneyScreenState();
}

class _JourneyScreenState extends State<JourneyScreen> with WidgetsBindingObserver {
  JourneyRunner? runner;
  final fields = <String, String>{}; // in memory only, never persisted
  String? error;
  bool awaitingHosted = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    () async {
      final client = MyntClient(clientSecret: await mintSession(), baseUrl: myntUrl);
      final r = await JourneyRunner.start(client, journeyId);
      setState(() => runner = r);
    }().catchError((Object e) => setState(() => error = '$e'));
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  // Back from the in-app browser: the provider's outcome reaches your api by webhook; here the journey
  // just moves on. Wire your myntapp://journey?outcome=... deep link to pass the real outcome instead.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && awaitingHosted) {
      awaitingHosted = false;
      _run(() => runner!.complete(const StepInput(outcome: 'completed')));
    }
  }

  void _run(Future<void> Function() block) {
    block().then((_) => setState(fields.clear)).catchError((Object e) => setState(() => error = '$e'));
  }

  @override
  Widget build(BuildContext context) {
    final r = runner;
    final Widget body;
    if (error != null) {
      body = Text(error!, style: const TextStyle(color: Colors.red));
    } else if (r == null) {
      body = const Text('Loading...');
    } else if (r.done || r.current == null) {
      body = const Text('All done.');
    } else {
      body = _step(r, r.current!);
    }
    return Scaffold(body: SafeArea(child: SingleChildScrollView(padding: const EdgeInsets.all(16), child: body)));
  }

  Widget _step(JourneyRunner r, Map<String, dynamic> step) {
    final elements = (step['screen'] as List<dynamic>? ?? const []).cast<Map<String, dynamic>>();
    final purpose = step['capture_consent'] as String?;
    final consent = purpose == null ? null : 'I agree to ${purpose.replaceAll('_', ' ')}.';
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (step['title'] is String) Text(step['title'] as String, style: Theme.of(context).textTheme.titleLarge),
      for (final e in elements)
        switch (e['type']) {
          'text' => Text(e['text'] as String? ?? ''),
          'disclosure' => Text(documentText[e['document']] ?? ''),
          'field' => TextField(
              key: ValueKey('${step['id']}/${e['field']}'),
              decoration: InputDecoration(labelText: e['field'] as String),
              obscureText: e['capture'] == 'secure_field',
              enableSuggestions: false,
              autocorrect: false,
              onChanged: (v) => fields[e['field'] as String] = v,
            ),
          _ => const SizedBox.shrink(),
        },
      if (consent != null) Text(consent),
      const SizedBox(height: 12),
      FilledButton(
        onPressed: () => _run(() async {
          final documents = {
            for (final e in elements.where((e) => e['type'] == 'disclosure')) e['document'] as String: documentText[e['document']] ?? '',
          };
          final redirect = await r.complete(StepInput(documents: documents, fields: Map<String, Object>.from(fields), consentText: consent));
          if (redirect != null) {
            awaitingHosted = true;
            await launchUrl(Uri.parse(redirect), mode: LaunchMode.inAppBrowserView);
          }
        }),
        child: Text(step.containsKey('action') ? 'Continue to provider' : consent != null ? 'I agree' : 'Continue'),
      ),
    ]);
  }
}
