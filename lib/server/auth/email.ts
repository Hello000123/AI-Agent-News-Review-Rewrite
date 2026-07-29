import {
  getApprovalNotificationEmail,
  getEmailDeliveryMode,
  getEmailProviderConfig,
} from "@/lib/server/auth/config";
import type { AccountRequestView } from "@/lib/shared/auth-contracts";

interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  messageType: "new_request" | "approved_setup" | "rejected";
  sensitiveUrl?: string;
}

export interface EmailDeliveryResult {
  status: "sent" | "preview" | "failed";
  providerMessageId?: string;
  errorCode?: string;
  developmentSetupUrl?: string;
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
    ["Company or organisation", request.company],
    ["Department", request.department],
    ["Job title", request.jobTitle],
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
        `<tr><th align="left">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`,
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
          from: {
            email: provider.senderAddress,
            name: provider.senderName,
          },
          to: [{ email: message.to }],
          subject: message.subject,
          text: message.text,
          html: message.html,
          metadata: { messageType: message.messageType },
        }),
        redirect: "error",
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
    const errorCode =
      error instanceof DOMException && error.name === "AbortError"
        ? "TIMEOUT"
        : error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code.slice(0, 80)
          : "DELIVERY_FAILED";
    return { status: "failed", errorCode };
  }
}
