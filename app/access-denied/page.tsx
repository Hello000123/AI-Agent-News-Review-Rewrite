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
      description="Your account does not have employee permission to open the Admin Panel."
      footer={<Link href="/">Return to the review workspace</Link>}
    >
      <div className="auth-alert auth-alert-error" role="alert">
        Client accounts cannot access Admin Panel pages or APIs.
      </div>
    </AuthShell>
  );
}
