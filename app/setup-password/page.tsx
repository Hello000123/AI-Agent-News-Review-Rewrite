import { AuthShell } from "@/components/auth/auth-shell";
import { PasswordSetupPage } from "@/components/auth/password-setup-page";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Create your password | PressReady",
};

export default function SetupPasswordPage() {
  return (
    <AuthShell
      eyebrow="Account approved"
      title="Create your password"
      description="Choose a strong password. The setup link is single-use and will be invalidated immediately after completion."
    >
      <PasswordSetupPage />
    </AuthShell>
  );
}
