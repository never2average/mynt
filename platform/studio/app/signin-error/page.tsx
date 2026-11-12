import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// Where a failed sign-in lands (it doesn't need one, so a failure can't loop back to sign-in).
const REASONS: Record<string, string> = {
  denied: "Sign-in was cancelled.",
  state: "Sign-in took too long. Please try again.",
  session: "Sign-in took too long. Please try again.",
  exchange: "Mynt couldn't finish signing you in. Please try again.",
  start: "Couldn't reach Mynt to sign in. Please try again in a moment.",
  code: "Sign-in didn't complete. Please try again.",
};

export default async function SignInErrorPage({ searchParams }: { searchParams: Promise<{ auth_error?: string }> }) {
  const { auth_error } = await searchParams;
  return (
    <main className="flex h-full items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Mynt Studio</CardTitle>
          <CardDescription role="alert">{REASONS[auth_error ?? ""] ?? "Sign-in failed. Please try again."}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <a href="/api/auth/login">Sign in again</a>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
