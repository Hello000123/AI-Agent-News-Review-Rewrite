import Link from "next/link";

import { AccountBar } from "@/components/auth/account-bar";
import { ApprovalDashboard } from "@/components/employee/approval-dashboard";
import { requirePageSession } from "@/lib/server/auth/guards";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Admin Panel | PressReady",
};

export default async function EmployeeApprovalPage() {
  const session = await requirePageSession("/employee", ["employee"]);
  return (
    <>
      <AccountBar user={session.user} />
      <main className="employee-page">
        <div className="employee-shell">
          <div className="employee-page-heading">
            <div>
              <div className="eyebrow">Administration</div>
              <h1>Admin Panel</h1>
              <p>Review applications and manage client and employee account records.</p>
            </div>
            <Link className="button button-secondary" href="/">
              Review workspace
            </Link>
          </div>
          <ApprovalDashboard />
        </div>
      </main>
    </>
  );
}
