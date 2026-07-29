"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import {
  AuthRequestError,
  listEmployeeAccountRequests,
} from "@/lib/client/auth-api";
import type {
  AccountRequestStatus,
  AccountRequestView,
} from "@/lib/shared/auth-contracts";

type Filter = AccountRequestStatus | "all";

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
  }).format(new Date(timestamp * 1_000));
}

export function ApprovalDashboard() {
  const [filter, setFilter] = useState<Filter>("pending");
  const [requests, setRequests] = useState<AccountRequestView[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    listEmployeeAccountRequests(filter === "all" ? undefined : filter)
      .then((result) => {
        if (!cancelled) setRequests(result.requests);
      })
      .catch((error) => {
        if (!cancelled) {
          setErrorMessage(
            error instanceof AuthRequestError
              ? error.message
              : "Account requests could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filter]);

  return (
    <section className="employee-dashboard" aria-busy={loading}>
      <div className="employee-filter" aria-label="Filter account requests">
        {FILTERS.map((option) => (
          <button
            type="button"
            className={filter === option.value ? "employee-filter-active" : ""}
            aria-pressed={filter === option.value}
            key={option.value}
            onClick={() => {
              setLoading(true);
              setErrorMessage("");
              setFilter(option.value);
            }}
          >
            {option.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="loading-panel" role="status">
          <span className="spinner spinner-dark" aria-hidden="true" />
          <div>
            <strong>Loading account requests</strong>
            <p>Retrieving the latest approval records.</p>
          </div>
        </div>
      ) : null}

      {errorMessage ? (
        <div className="auth-alert auth-alert-error" role="alert">
          {errorMessage}
        </div>
      ) : null}

      {!loading && !errorMessage && requests.length === 0 ? (
        <div className="employee-empty">
          <strong>No {filter === "all" ? "" : `${filter} `}account requests</strong>
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
                <p>{request.company} · {request.department}</p>
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
  );
}
