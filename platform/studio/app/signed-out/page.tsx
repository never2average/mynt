import type { Metadata } from "next";

import { MyntLogo } from "@/components/brand/mynt-logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = { title: "Signed out" };

// Where signing out lands. It doesn't need a sign-in, so signing out doesn't sign straight back in.
export default function SignedOutPage() {
  return (
    <main className="flex h-full flex-col items-center justify-center gap-6 p-4">
      <MyntLogo size={32} />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Mynt Studio</CardTitle>
          <CardDescription>You&apos;re signed out.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <a href="/api/auth/login">Sign in</a>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
