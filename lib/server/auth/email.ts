import {
  getApprovalNotificationEmail,
  getEmailDeliveryMode,
  getEmailProviderConfig,
} from "@/lib/server/auth/config";
import type {
  AccountListUserView,
  AccountRequestView,
} from "@/lib/shared/auth-contracts";

interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  messageType: "new_request" | "approved_setup" | "rejected" | "client_removed";
  sensitiveUrl?: string;
}

export interface EmailDeliveryResult {
  status: "sent" | "preview" | "failed";
  providerMessageId?: string;
  errorCode?: string;
  developmentSetupUrl?: string;
}

function diagnosticText(value: unknown) {
  return typeof value === "string" ? value.slice(0, 240) : undefined;
}

function logEmailDeliveryFailure(messageType: EmailMessage["messageType"], error: unknown) {
  const cause =
    error instanceof Error && "cause" in error && error.cause instanceof Error
      ? error.cause
      : undefined;
  console.error("[auth-email] Delivery failed.", {
    messageType,
    errorType: error instanceof Error ? error.name : typeof error,
    errorCode:
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code.slice(0, 80)
        : undefined,
    errorMessage: error instanceof Error ? diagnosticText(error.message) : undefined,
    causeType: cause?.name,
    causeCode:
      cause && "code" in cause && typeof cause.code === "string"
        ? cause.code.slice(0, 80)
        : undefined,
    causeMessage: diagnosticText(cause?.message),
  });
}

function escapeHtml(value: string) {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#039;");
}

function detailRows(request: AccountRequestView) {
  return [
    ["Full name", request.fullName],
    ["Email", request.email],
    ["Phone", request.phone],
    ["Company or organisation", request.company || "Not provided"],
    ["Department", request.department || "Not provided"],
    ["Job title", request.jobTitle || "Not provided"],
    ["Message to administrator", request.adminMessage || "No message provided"],
  ] as const;
}

export function newAccountRequestEmail(
  request: AccountRequestView,
  publicAppUrl: string,
): EmailMessage {
  const approvalUrl = `${publicAppUrl}/employee/requests/${encodeURIComponent(request.id)}`;
  const rows = detailRows(request);
  const textDetails = rows.map(([label, value]) => `${label}: ${value}`).join("\n");
  const htmlDetails = rows
    .map(
      ([label, value]) =>
        `<tr><th align="left">${escapeHtml(label)}</th><td>${escapeHtml(value).replace(/\n/gu, "<br>")}</td></tr>`,
    )
    .join("");

  return {
    to: getApprovalNotificationEmail(),
    subject: `New account request from ${request.fullName}`,
    messageType: "new_request",
    text:
      `A new PressReady account request is awaiting review.\n\n${textDetails}\n\n` +
      `Review request: ${approvalUrl}`,
    html:
      `<p>A new PressReady account request is awaiting review.</p>` +
      `<table cellpadding="6" cellspacing="0">${htmlDetails}</table>` +
      `<p><a href="${escapeHtml(approvalUrl)}">Review this account request</a></p>`,
  };
}

export function approvedAccountEmail(
  request: AccountRequestView,
  setupUrl: string,
  expiresAt: number,
): EmailMessage {
  const expiry = new Date(expiresAt * 1_000).toISOString();
  return {
    to: request.email,
    subject: "Your PressReady account has been approved",
    messageType: "approved_setup",
    sensitiveUrl: setupUrl,
    text:
      `Hello ${request.fullName},\n\n` +
      "Your PressReady account request has been approved. Create your password using this " +
      `single-use link before ${expiry}:\n\n${setupUrl}\n\n` +
      "If you did not request this account, do not use the link and contact the organisation.",
    html:
      `<p>Hello ${escapeHtml(request.fullName)},</p>` +
      "<p>Your PressReady account request has been approved.</p>" +
      `<p><a href="${escapeHtml(setupUrl)}">Create your password</a></p>` +
      `<p>This single-use link expires at ${escapeHtml(expiry)}.</p>` +
      "<p>If you did not request this account, do not use the link and contact the organisation.</p>",
  };
}

export function rejectedAccountEmail(
  request: AccountRequestView,
  rejectionReason?: string,
): EmailMessage {
  const reasonText = rejectionReason
    ? `\n\nReason provided: ${rejectionReason}`
    : "";
  const reasonHtml = rejectionReason
    ? `<p><strong>Reason provided:</strong> ${escapeHtml(rejectionReason)}</p>`
    : "";
  return {
    to: request.email,
    subject: "Update on your PressReady account request",
    messageType: "rejected",
    text:
      `Hello ${request.fullName},\n\n` +
      `Your PressReady account request was not approved.${reasonText}\n\n` +
      "Contact the organisation if you believe this decision was made in error.",
    html:
      `<p>Hello ${escapeHtml(request.fullName)},</p>` +
      "<p>Your PressReady account request was not approved.</p>" +
      reasonHtml +
      "<p>Contact the organisation if you believe this decision was made in error.</p>",
  };
}

export function removedClientAccountEmail(
  client: AccountListUserView,
  removalMessage: string,
): EmailMessage {
  return {
    to: client.email,
    subject: "Your PressReady account has been removed",
    messageType: "client_removed",
    text:
      `Hello ${client.fullName},\n\n` +
      "Your PressReady account has been removed and access has been revoked.\n\n" +
      `Message from the administrator:\n${removalMessage}\n\n` +
      "Contact the organisation if you need further assistance.",
    html:
      `<p>Hello ${escapeHtml(client.fullName)},</p>` +
      "<p>Your PressReady account has been removed and access has been revoked.</p>" +
      "<p><strong>Message from the administrator:</strong></p>" +
      `<p>${escapeHtml(removalMessage).replace(/\n/gu, "<br>")}</p>` +
      "<p>Contact the organisation if you need further assistance.</p>",
  };
}

export async function deliverEmail(message: EmailMessage): Promise<EmailDeliveryResult> {
  try {
    const mode = getEmailDeliveryMode();
    if (mode === "preview") {
      return {
        status: "preview",
        ...(message.sensitiveUrl ? { developmentSetupUrl: message.sensitiveUrl } : {}),
      };
    }

    const provider = getEmailProviderConfig();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const authorizationValue = provider.authScheme
        ? `${provider.authScheme} ${provider.apiKey}`
        : provider.apiKey;
      const response = await fetch(provider.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [provider.authHeader]: authorizationValue,
        },
        body: JSON.stringify({
          from: `${provider.senderName} <${provider.senderAddress}>`,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
          tags: [
            {
              name: "message_type",
              value: message.messageType,
            },
          ],
        }),
        // Workerd does not implement redirect: "error". Manual mode preserves the
        // same security property: redirects are never followed with the provider key.
        redirect: "manual",
        signal: controller.signal,
      });
      if (!response.ok) {
        return { status: "failed", errorCode: `HTTP_${response.status}` };
      }

      let providerMessageId: string | undefined;
      try {
        const body = (await response.json()) as { id?: unknown; messageId?: unknown };
        const candidate = body.id ?? body.messageId;
        if (typeof candidate === "string") providerMessageId = candidate.slice(0, 200);
      } catch {
        // A successful provider response does not need to include JSON.
      }
      return { status: "sent", providerMessageId };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    logEmailDeliveryFailure(message.messageType, error);
    const errorCode =
      error instanceof DOMException && error.name === "AbortError"
        ? "TIMEOUT"
        : error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code.slice(0, 80)
          : "DELIVERY_FAILED";
    return { status: "failed", errorCode };
  }
}
