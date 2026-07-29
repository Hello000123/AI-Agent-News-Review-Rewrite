import { describe, expect, it } from "vitest";

import {
  approvedAccountEmail,
  newAccountRequestEmail,
  rejectedAccountEmail,
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
  status: "pending",
  createdAt: 1,
  updatedAt: 1,
  decidedAt: null,
  rejectionReason: null,
  decidedBy: null,
};

describe("authentication email templates", () => {
  it("escapes applicant and rejection values in HTML templates", () => {
    const notification = newAccountRequestEmail(request, "https://app.example");
    expect(notification.html).toContain(
      "Applicant &lt;script&gt;alert(1)&lt;/script&gt;",
    );
    expect(notification.html).toContain("News &amp; Media");
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
});
