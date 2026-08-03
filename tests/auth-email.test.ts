import { afterEach, describe, expect, it, vi } from "vitest";

import {
  approvedAccountEmail,
  deliverEmail,
  newAccountRequestEmail,
  rejectedAccountEmail,
  removedClientAccountEmail,
} from "@/lib/server/auth/email";
import type { AccountRequestView } from "@/lib/shared/auth-contracts";

const request: AccountRequestView = {
  id: "request-1",
  fullName: "Applicant <script>alert(1)</script>",
  email: "applicant@example.test",
  phone: "+852 2345 6789",
  company: "News & Media",
  department: "Editorial",
  jobTitle: "Editor",
  adminMessage: "Please review <img src=x onerror=\"alert(1)\">\nSecond line",
  attachment: null,
  status: "pending",
  createdAt: 1,
  updatedAt: 1,
  decidedAt: null,
  rejectionReason: null,
  decidedBy: null,
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("authentication email templates", () => {
  it("escapes applicant and rejection values in HTML templates", () => {
    const notification = newAccountRequestEmail(request, "https://app.example");
    expect(notification.html).toContain(
      "Applicant &lt;script&gt;alert(1)&lt;/script&gt;",
    );
    expect(notification.html).toContain("News &amp; Media");
    expect(notification.html).toContain(
      "Please review &lt;img src=x onerror=&quot;alert(1)&quot;&gt;<br>Second line",
    );
    expect(notification.html).not.toContain("<script>");

    const rejected = rejectedAccountEmail(
      request,
      'Not verified <img src=x onerror="alert(1)">',
    );
    expect(rejected.html).toContain(
      "Not verified &lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
    expect(rejected.html).not.toContain("<img");
  });

  it("uses clear fallbacks when optional applicant details are empty", () => {
    const notification = newAccountRequestEmail(
      {
        ...request,
        company: null,
        department: null,
        jobTitle: null,
        adminMessage: null,
      },
      "https://app.example",
    );
    expect(notification.text).toContain("Company or organisation: Not provided");
    expect(notification.text).toContain("Department: Not provided");
    expect(notification.text).toContain("Job title: Not provided");
    expect(notification.text).toContain(
      "Message to administrator: No message provided",
    );
  });

  it("places password setup only in the approved applicant template", () => {
    const setupUrl =
      "https://app.example/setup-password#token=development-token-value";
    const approved = approvedAccountEmail(request, setupUrl, 2_000_000_000);
    expect(approved.to).toBe(request.email);
    expect(approved.text).toContain(setupUrl);
    expect(approved.html).toContain(setupUrl);
    expect(newAccountRequestEmail(request, "https://app.example").text).not.toContain(
      "setup-password",
    );
  });

  it("includes the sanitized administrator message in the client-removal email", () => {
    const removal = removedClientAccountEmail(
      {
        id: "client-1",
        fullName: "Client <Person>",
        email: "client@example.test",
        role: "client",
      status: "active",
      createdAt: 1,
      reviewRequestCount: 0,
      rewriteRequestCount: 0,
      },
      'Access ended <img src=x onerror="alert(1)">\nContact the administrator.',
    );

    expect(removal.to).toBe("client@example.test");
    expect(removal.messageType).toBe("client_removed");
    expect(removal.text).toContain(
      "Access ended <img src=x onerror=\"alert(1)\">\nContact the administrator.",
    );
    expect(removal.html).toContain("Client &lt;Person&gt;");
    expect(removal.html).toContain(
      "Access ended &lt;img src=x onerror=&quot;alert(1)&quot;&gt;<br>Contact the administrator.",
    );
    expect(removal.html).not.toContain("<img");
    expect(removal.text).not.toContain("password");
    expect(removal.text).not.toContain("session");
  });

  it("sends a Resend-compatible HTTP payload", async () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("ACCOUNT_APPROVAL_NOTIFICATION_EMAIL", "jimmy.zhang@931smd.com");
    vi.stubEnv("EMAIL_DELIVERY_MODE", "http");
    vi.stubEnv("EMAIL_PROVIDER_API_URL", "https://api.resend.com/emails");
    vi.stubEnv("EMAIL_PROVIDER_API_KEY", "resend-test-key");
    vi.stubEnv("EMAIL_PROVIDER_AUTH_HEADER", "Authorization");
    vi.stubEnv("EMAIL_PROVIDER_AUTH_SCHEME", "Bearer");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "onboarding@resend.dev");
    vi.stubEnv("EMAIL_FROM_NAME", "931SMD-Testing");

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "resend-message-id" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const message = newAccountRequestEmail(request, "https://app.example");
    const result = await deliverEmail(message);

    expect(result).toEqual({
      status: "sent",
      providerMessageId: "resend-message-id",
    });
    expect(fetchMock).toHaveBeenCalledOnce();

    const [endpoint, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe("https://api.resend.com/emails");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer resend-test-key",
      },
      redirect: "manual",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      from: "931SMD-Testing <onboarding@resend.dev>",
      to: ["jimmy.zhang@931smd.com"],
      subject: message.subject,
      text: message.text,
      html: message.html,
      tags: [
        {
          name: "message_type",
          value: "new_request",
        },
      ],
    });
  });
});
