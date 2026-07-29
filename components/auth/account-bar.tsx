import Link from "next/link";

import { LogoutButton } from "@/components/auth/logout-button";
import type { AuthenticatedUser } from "@/lib/shared/auth-contracts";

export function AccountBar({ user }: { user: AuthenticatedUser }) {
  return (
    <header className="account-bar">
      <Link className="account-brand" href="/">
        PressReady
      </Link>
      <nav aria-label="Account navigation">
        {user.role === "employee" ? (
          <Link className="account-link" href="/employee">
            Approval portal
          </Link>
        ) : null}
        <div className="account-identity">
          <strong>{user.fullName}</strong>
          <span>{user.email}</span>
        </div>
        <LogoutButton />
      </nav>
    </header>
  );
}
