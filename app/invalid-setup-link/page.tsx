import Link from "next/link";

import { AuthShell } from "@/components/auth/auth-shell";

export const metadata = {
  title: "Invalid setup link | PressReady",
};

export default function InvalidSetupLinkPage() {
  return (
    <AuthShell
      eyebrow="Setup unavailable"
      title="This setup link cannot be used"
      description="The link is invalid, expired, or has already been used. Ask an authorised employee to send a new setup link."
      footer={<Link href="/login">Return to login</Link>}
    >
      <div className="auth-alert auth-alert-error" role="alert">
        Password setup was not changed.
      </div>
    </AuthShell>
  );
}
