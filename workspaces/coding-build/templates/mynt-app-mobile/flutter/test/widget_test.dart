import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mynt_starter/main.dart';

void main() {
  testWidgets('opens on the loading state while the api mints a session', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: JourneyScreen()));
    expect(find.text('Loading...'), findsOneWidget);
  });
}
