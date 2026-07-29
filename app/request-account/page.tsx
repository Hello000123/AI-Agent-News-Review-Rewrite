import Link from "next/link";

import { AccountRequestForm } from "@/components/auth/account-request-form";
import { AuthShell } from "@/components/auth/auth-shell";

export const metadata = {
  title: "Request an account | PressReady",
};

export default function RequestAccountPage() {
  return (
    <AuthShell
      eyebrow="Client access"
      title="Request an account"
      description="Submit your work details for employee review. You will create a password only after your request is approved."
      wide
      footer={
        <p>
          Already approved? <Link href="/login">Go to login</Link>
        </p>
      }
    >
      <AccountRequestForm />
    </AuthShell>
  );
}
