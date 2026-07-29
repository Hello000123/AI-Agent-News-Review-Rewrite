import Link from "next/link";

import { AccountBar } from "@/components/auth/account-bar";
import { ApprovalDashboard } from "@/components/employee/approval-dashboard";
import { requirePageSession } from "@/lib/server/auth/guards";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Account approvals | PressReady",
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
              <div className="eyebrow">Employee portal</div>
              <h1>Account approvals</h1>
              <p>Review client requests and keep a clear record of every decision.</p>
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
