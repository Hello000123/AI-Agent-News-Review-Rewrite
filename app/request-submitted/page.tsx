import Link from "next/link";

import { AuthShell } from "@/components/auth/auth-shell";

export const metadata = {
  title: "Request submitted | PressReady",
};

export default function RequestSubmittedPage() {
  return (
    <AuthShell
      eyebrow="Request received"
      title="Your account request is pending"
      description="An authorised employee has been notified. If your request is approved, you will receive a single-use link to create your password."
      footer={<Link href="/login">Return to login</Link>}
    >
      <div className="auth-success-panel" role="status">
        <span aria-hidden="true">✓</span>
        <div>
          <strong>No password is needed yet</strong>
          <p>Check your email after the approval team reviews your request.</p>
        </div>
      </div>
    </AuthShell>
  );
}
