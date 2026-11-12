import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// Where signing out lands. It doesn't need a sign-in, so signing out doesn't sign straight back in.
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
            <a href="/api/auth/login">Sign in</a>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
