import Link from "next/link";
import { redirect } from "next/navigation";

import { AuthShell } from "@/components/auth/auth-shell";
import { LoginForm } from "@/components/auth/login-form";
import { getOptionalPageSession } from "@/lib/server/auth/guards";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Login | PressReady",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string; reason?: string }>;
}) {
  const session = await getOptionalPageSession();
  if (session) redirect(session.user.role === "employee" ? "/employee" : "/");
  const parameters = await searchParams;

  return (
    <AuthShell
      eyebrow="Secure access"
      title="Login to PressReady"
      description="Use the email address and password for your approved account."
      footer={
        <p>
          Need access? <Link href="/request-account">Request an account</Link>
        </p>
      }
    >
      <LoginForm
        returnTo={parameters.returnTo}
        sessionExpired={parameters.reason === "session-expired"}
      />
    </AuthShell>
  );
}
