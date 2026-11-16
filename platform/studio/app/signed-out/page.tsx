import type { Metadata } from "next";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = { title: "Signed out" };

// Where signing out lands: a page of its own (no sign-in needed, never a redirect), so signing out
// doesn't sign straight back in. Sign in again starts a new sign-in.
export default function SignedOutPage() {
  return (
    <main className="flex h-full items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Mynt Studio</CardTitle>
          <CardDescription>You&apos;re signed out.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <a href="/api/auth/login" data-sign-in-again>Sign in again</a>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
