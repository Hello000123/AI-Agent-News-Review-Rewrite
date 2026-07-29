import Link from "next/link";
import { notFound } from "next/navigation";

import { AccountBar } from "@/components/auth/account-bar";
import { EmployeeRequestDetails } from "@/components/employee/request-details";
import { getDatabase } from "@/lib/server/auth/database";
import { requirePageSession } from "@/lib/server/auth/guards";
import { getAccountRequestById } from "@/lib/server/auth/repository";

export const dynamic = "force-dynamic";

export default async function EmployeeRequestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requirePageSession(`/employee/requests/${id}`, ["employee"]);
  const request = await getAccountRequestById(getDatabase(), id);
  if (!request) notFound();

  return (
    <>
      <AccountBar user={session.user} />
      <main className="employee-page">
        <div className="employee-shell">
          <Link className="employee-back-link" href="/employee">
            ← Back to account approvals
          </Link>
          <EmployeeRequestDetails initialRequest={request} />
        </div>
      </main>
    </>
  );
}
