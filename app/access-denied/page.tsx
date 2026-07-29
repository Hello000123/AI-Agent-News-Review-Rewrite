import Link from "next/link";

import { AuthShell } from "@/components/auth/auth-shell";

export const metadata = {
  title: "Access denied | PressReady",
};

export default function AccessDeniedPage() {
  return (
    <AuthShell
      eyebrow="Restricted area"
      title="Access denied"
      description="Your account does not have employee permission to open the account approval portal."
      footer={<Link href="/">Return to the review workspace</Link>}
    >
      <div className="auth-alert auth-alert-error" role="alert">
        Client accounts cannot access employee pages or approval APIs.
      </div>
    </AuthShell>
  );
}
