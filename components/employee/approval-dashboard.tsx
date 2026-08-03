"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { ClientRemovalDialog } from "@/components/employee/client-removal-dialog";
import {
  AuthRequestError,
  listEmployeeAccountRequests,
  listEmployeeAccounts,
} from "@/lib/client/auth-api";
import type {
  AccountListUserView,
  AccountRoleSummary,
  AccountRequestStatus,
  AccountRequestView,
  EmailDeliveryView,
} from "@/lib/shared/auth-contracts";

type AdminTab = "approval" | "clients" | "employees";
type Filter = AccountRequestStatus | "all";

const ADMIN_TABS: Array<{ value: AdminTab; label: string }> = [
  { value: "approval", label: "Account Approval" },
  { value: "clients", label: "Client Accounts" },
  { value: "employees", label: "Employee Accounts" },
];

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All requests" },
];

function formattedDate(timestamp: number) {
  return new Intl.DateTimeFormat("en-HK", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Hong_Kong",
  }).format(new Date(timestamp * 1_000));
}

function loadingLabel(tab: AdminTab) {
  if (tab === "approval") return "Loading account requests";
  if (tab === "clients") return "Loading client accounts";
  return "Loading employee accounts";
}

export function ApprovalDashboard() {
  const [activeTab, setActiveTab] = useState<AdminTab>("approval");
  const [filter, setFilter] = useState<Filter>("pending");
  const [requests, setRequests] = useState<AccountRequestView[]>([]);
  const [accounts, setAccounts] = useState<AccountListUserView[]>([]);
  const [summary, setSummary] = useState<AccountRoleSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [notice, setNotice] = useState<{
    kind: "success" | "warning";
    message: string;
  } | null>(null);
  const [clientToRemove, setClientToRemove] =
    useState<AccountListUserView | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const request =
      activeTab === "approval"
        ? listEmployeeAccountRequests(filter === "all" ? undefined : filter)
        : listEmployeeAccounts(activeTab === "clients" ? "client" : "employee");

    request
      .then((result) => {
        if (cancelled) return;
        setSummary(result.summary);
        if ("requests" in result) {
          setRequests(result.requests);
        } else {
          setAccounts(result.accounts);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setErrorMessage(
            error instanceof AuthRequestError
              ? error.message
              : "Admin Panel data could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, filter, refreshVersion]);

  function changeTab(tab: AdminTab) {
    if (tab === activeTab) return;
    setNotice(null);
    setErrorMessage("");
    setAccounts([]);
    setRequests([]);
    setLoading(true);
    setActiveTab(tab);
  }

  function handleRemoved(delivery: EmailDeliveryView) {
    const client = clientToRemove;
    setClientToRemove(null);
    setNotice(
      delivery.status === "failed"
        ? {
            kind: "warning",
            message:
              `${client?.fullName || "The client"} can no longer access PressReady, ` +
              "but the removal email could not be delivered.",
          }
        : {
            kind: "success",
            message:
              delivery.status === "sent"
                ? `${client?.fullName || "The client"} was removed and the notification email was sent.`
                : `${client?.fullName || "The client"} was removed. Email preview mode recorded the notification without sending it externally.`,
          },
    );
    setLoading(true);
    setRefreshVersion((current) => current + 1);
  }

  return (
    <section className="employee-dashboard" aria-busy={loading}>
      <section className="account-summary" aria-labelledby="account-summary-heading">
        <div className="account-summary-heading">
          <div>
            <div className="section-kicker">Accounts</div>
            <h2 id="account-summary-heading">Account summary</h2>
          </div>
          <span>Current active role totals</span>
        </div>
        <div className="account-summary-grid">
          <article className="account-summary-card">
            <span>Employee accounts</span>
            <strong>{summary?.employeeAccounts ?? "—"}</strong>
          </article>
          <article className="account-summary-card">
            <span>Client accounts</span>
            <strong>{summary?.clientAccounts ?? "—"}</strong>
          </article>
        </div>
      </section>

      <div className="admin-tabs" role="tablist" aria-label="Admin Panel sections">
        {ADMIN_TABS.map((tab) => (
          <button
            id={`admin-tab-${tab.value}`}
            className={activeTab === tab.value ? "admin-tab-active" : ""}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.value}
            aria-controls={`admin-panel-${tab.value}`}
            key={tab.value}
            onClick={() => changeTab(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {notice ? (
        <div
          className={`auth-alert ${
            notice.kind === "success"
              ? "auth-alert-success"
              : "auth-alert-error"
          }`}
          role={notice.kind === "success" ? "status" : "alert"}
        >
          {notice.message}
        </div>
      ) : null}

      {loading ? (
        <div className="loading-panel" role="status">
          <span className="spinner spinner-dark" aria-hidden="true" />
          <div>
            <strong>{loadingLabel(activeTab)}</strong>
            <p>Retrieving the latest account records.</p>
          </div>
        </div>
      ) : null}

      {errorMessage ? (
        <div className="auth-alert auth-alert-error" role="alert">
          {errorMessage}
        </div>
      ) : null}

      <section
        id="admin-panel-approval"
        role="tabpanel"
        aria-labelledby="admin-tab-approval"
        hidden={activeTab !== "approval"}
      >
        <div className="employee-filter" aria-label="Filter account requests">
          {FILTERS.map((option) => (
            <button
              type="button"
              className={filter === option.value ? "employee-filter-active" : ""}
              aria-pressed={filter === option.value}
              key={option.value}
              onClick={() => {
                if (filter === option.value) return;
                setLoading(true);
                setErrorMessage("");
                setNotice(null);
                setFilter(option.value);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>

        {!loading && !errorMessage && requests.length === 0 ? (
          <div className="employee-empty">
            <strong>
              No {filter === "all" ? "" : `${filter} `}account requests
            </strong>
            <p>Requests matching this view will appear here.</p>
          </div>
        ) : null}

        {!loading && requests.length > 0 ? (
          <div className="employee-request-list">
            {requests.map((request) => (
              <article className="employee-request-row" key={request.id}>
                <div>
                  <div className="employee-request-title">
                    <h2>{request.fullName}</h2>
                    <span className={`status-badge status-${request.status}`}>
                      {request.status}
                    </span>
                  </div>
                  <p>
                    {[request.company, request.department]
                      .filter(Boolean)
                      .join(" · ") || "Organisation details not provided"}
                  </p>
                  <small>
                    Submitted {formattedDate(request.createdAt)}
                    {request.decidedBy
                      ? ` · ${request.status} by ${request.decidedBy.fullName}`
                      : ""}
                  </small>
                </div>
                <Link
                  className="button button-secondary"
                  href={`/employee/requests/${encodeURIComponent(request.id)}`}
                >
                  View details
                </Link>
              </article>
            ))}
          </div>
        ) : null}
      </section>

      {activeTab !== "approval" ? (
        <section
          id={`admin-panel-${activeTab}`}
          className="admin-account-panel"
          role="tabpanel"
          aria-labelledby={`admin-tab-${activeTab}`}
        >
          {!loading && !errorMessage && accounts.length === 0 ? (
            <div className="employee-empty">
              <strong>
                No {activeTab === "clients" ? "client" : "employee"} accounts
              </strong>
              <p>Accounts with this role will appear here.</p>
            </div>
          ) : null}

          {!loading && accounts.length > 0 ? (
            <div className="admin-account-list">
              {accounts.map((account) => (
                <article className="admin-account-row" key={account.id}>
                  <div>
                    <h2>{account.fullName}</h2>
                    <a href={`mailto:${account.email}`}>{account.email}</a>
                    <span className={`status-badge status-${account.status}`}>
                      {account.status === "setup_pending"
                        ? "Setup pending"
                        : account.status}
                    </span>
                    {activeTab === "clients" ? (
                      <dl className="admin-account-usage" aria-label={`${account.fullName} AI request usage`}>
                        <div>
                          <dt>Review requests</dt>
                          <dd>{(account.reviewRequestCount ?? 0).toLocaleString("en-US")}</dd>
                        </div>
                        <div>
                          <dt>Rewrite requests</dt>
                          <dd>{(account.rewriteRequestCount ?? 0).toLocaleString("en-US")}</dd>
                        </div>
                      </dl>
                    ) : null}
                  </div>
                  {activeTab === "clients" ? (
                    <button
                      className="button button-danger"
                      type="button"
                      onClick={() => {
                        setNotice(null);
                        setClientToRemove(account);
                      }}
                    >
                      Remove account
                    </button>
                  ) : null}
                </article>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {clientToRemove ? (
        <ClientRemovalDialog
          client={clientToRemove}
          onCancel={() => setClientToRemove(null)}
          onRemoved={({ emailDelivery }) => handleRemoved(emailDelivery)}
        />
      ) : null}
    </section>
  );
}
