"use client";

import { useState } from "react";

import {
  AuthRequestError,
  decideAccountRequest,
  resendSetupEmail,
} from "@/lib/client/auth-api";
import type {
  AccountRequestView,
  EmailDeliveryView,
} from "@/lib/shared/auth-contracts";

function formattedDate(timestamp: number | null) {
  if (!timestamp) return "—";
  return new Intl.DateTimeFormat("en-HK", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Hong_Kong",
  }).format(new Date(timestamp * 1_000));
}

function formattedFileSize(bytes: number) {
  return `${(bytes / 1024 / 1024).toLocaleString("en-US", {
    maximumFractionDigits: 2,
  })} MB`;
}

function DeliveryNotice({ delivery }: { delivery: EmailDeliveryView }) {
  if (delivery.status === "sent") {
    return (
      <div className="auth-alert auth-alert-success" role="status">
        The applicant email was sent successfully.
      </div>
    );
  }
  if (delivery.status === "failed") {
    return (
      <div className="auth-alert auth-alert-error" role="alert">
        The decision was saved, but email delivery failed. Check the provider configuration and
        use “Resend setup email” when applicable.
      </div>
    );
  }
  return (
    <div className="auth-alert" role="status">
      Development email preview mode is active. No external email was sent.
    </div>
  );
}

export function EmployeeRequestDetails({
  initialRequest,
}: {
  initialRequest: AccountRequestView;
}) {
  const [request, setRequest] = useState(initialRequest);
  const [rejectionReason, setRejectionReason] = useState("");
  const [pendingAction, setPendingAction] = useState<"approve" | "reject" | "resend" | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [delivery, setDelivery] = useState<EmailDeliveryView | null>(null);
  const [copyMessage, setCopyMessage] = useState("");

  async function decide(action: "approve" | "reject") {
    if (pendingAction) return;
    setPendingAction(action);
    setErrorMessage("");
    setDelivery(null);
    try {
      const result = await decideAccountRequest(request.id, {
        action,
        ...(action === "reject" && rejectionReason.trim()
          ? { rejectionReason: rejectionReason.trim() }
          : {}),
      });
      setRequest(result.request);
      setDelivery(result.emailDelivery);
    } catch (error) {
      setErrorMessage(
        error instanceof AuthRequestError
          ? error.message
          : "The decision could not be saved. Please try again.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function resend() {
    if (pendingAction) return;
    setPendingAction("resend");
    setErrorMessage("");
    setDelivery(null);
    try {
      const result = await resendSetupEmail(request.id);
      setDelivery(result.emailDelivery);
    } catch (error) {
      setErrorMessage(
        error instanceof AuthRequestError
          ? error.message
          : "The setup email could not be resent.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function copySetupUrl() {
    if (!delivery?.developmentSetupUrl) return;
    try {
      await navigator.clipboard.writeText(delivery.developmentSetupUrl);
      setCopyMessage("Setup link copied.");
    } catch {
      setCopyMessage("Select the link and copy it manually.");
    }
  }

  const details = [
    ["Full name", request.fullName],
    ["Email address", request.email],
    ["Phone number", request.phone],
    ["Company or organisation", request.company || "Not provided"],
    ["Department", request.department || "Not provided"],
    ["Job title", request.jobTitle || "Not provided"],
    ["Submitted", formattedDate(request.createdAt)],
    ["Last updated", formattedDate(request.updatedAt)],
  ];

  return (
    <div className="employee-detail-grid">
      <section className="card employee-detail-card" aria-labelledby="applicant-details">
        <div className="employee-request-title">
          <div>
            <div className="section-kicker">Applicant</div>
            <h1 id="applicant-details">{request.fullName}</h1>
          </div>
          <span className={`status-badge status-${request.status}`}>{request.status}</span>
        </div>
        <dl className="employee-details-list">
          {details.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="employee-admin-message">
          <h2>Message to administrator</h2>
          <p>{request.adminMessage || "No message provided"}</p>
        </div>
        <div className="employee-attachment">
          <h2>Supporting document</h2>
          {request.attachment ? (
            <div className="attachment-row">
              <div className="attachment-icon" aria-hidden="true">DOC</div>
              <div className="attachment-details">
                <strong>{request.attachment.fileName}</strong>
                <span>
                  {request.attachment.mimeType} ·{" "}
                  {formattedFileSize(request.attachment.size)}
                </span>
              </div>
              <div className="employee-attachment-actions">
                <a
                  className="button button-secondary"
                  href={`/api/employee/account-requests/${encodeURIComponent(request.id)}/attachment?mode=view`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View
                </a>
                <a
                  className="button button-quiet"
                  href={`/api/employee/account-requests/${encodeURIComponent(request.id)}/attachment`}
                >
                  Download
                </a>
              </div>
            </div>
          ) : (
            <p>No supporting document provided</p>
          )}
        </div>
      </section>

      <aside className="card employee-decision-card" aria-labelledby="decision-heading">
        <div className="section-kicker">Approval record</div>
        <h2 id="decision-heading">Decision</h2>

        {request.decidedBy ? (
          <dl className="employee-decision-summary">
            <div>
              <dt>Decision</dt>
              <dd className={`status-text-${request.status}`}>{request.status}</dd>
            </div>
            <div>
              <dt>Employee</dt>
              <dd>{request.decidedBy.fullName} ({request.decidedBy.email})</dd>
            </div>
            <div>
              <dt>Decision time</dt>
              <dd>{formattedDate(request.decidedAt)}</dd>
            </div>
            {request.rejectionReason ? (
              <div>
                <dt>Rejection reason</dt>
                <dd>{request.rejectionReason}</dd>
              </div>
            ) : null}
          </dl>
        ) : (
          <div className="employee-decision-form">
            <p>
              Approving creates a client account and a single-use, expiring password setup link.
            </p>
            <button
              className="button button-primary"
              type="button"
              disabled={Boolean(pendingAction)}
              onClick={() => decide("approve")}
            >
              {pendingAction === "approve" ? "Approving…" : "Approve request"}
            </button>
            <label htmlFor="rejection-reason">
              Optional rejection reason
            </label>
            <textarea
              id="rejection-reason"
              value={rejectionReason}
              maxLength={1_000}
              disabled={Boolean(pendingAction)}
              onChange={(event) => setRejectionReason(event.target.value)}
              placeholder="Explain the decision if helpful to the applicant."
            />
            <button
              className="button button-danger"
              type="button"
              disabled={Boolean(pendingAction)}
              onClick={() => decide("reject")}
            >
              {pendingAction === "reject" ? "Rejecting…" : "Reject request"}
            </button>
          </div>
        )}

        {request.status === "approved" ? (
          <button
            className="button button-secondary employee-resend"
            type="button"
            disabled={Boolean(pendingAction)}
            onClick={resend}
          >
            {pendingAction === "resend" ? "Sending…" : "Resend setup email"}
          </button>
        ) : null}

        {delivery ? <DeliveryNotice delivery={delivery} /> : null}

        {delivery?.developmentSetupUrl ? (
          <div className="development-setup-link">
            <strong>Development-only setup link</strong>
            <p>This is visible only because email preview mode is active.</p>
            <input value={delivery.developmentSetupUrl} readOnly aria-label="Development setup link" />
            <button className="button button-quiet" type="button" onClick={copySetupUrl}>
              Copy setup link
            </button>
            {copyMessage ? <span role="status">{copyMessage}</span> : null}
          </div>
        ) : null}

        {errorMessage ? (
          <div className="auth-alert auth-alert-error" role="alert">
            {errorMessage}
          </div>
        ) : null}
      </aside>
    </div>
  );
}
