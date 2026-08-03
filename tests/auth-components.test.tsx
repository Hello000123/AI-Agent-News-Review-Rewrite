// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountRequestForm } from "@/components/auth/account-request-form";
import { LoginForm } from "@/components/auth/login-form";
import { PasswordSetupForm } from "@/components/auth/password-setup-form";
import { ApprovalDashboard } from "@/components/employee/approval-dashboard";
import { EmployeeRequestDetails } from "@/components/employee/request-details";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  listEmployeeAccountRequests: vi.fn(),
  listEmployeeAccounts: vi.fn(),
  removeClientAccount: vi.fn(),
  submitAccountRequest: vi.fn(),
  decideAccountRequest: vi.fn(),
  resendSetupEmail: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));

vi.mock("@/lib/client/auth-api", () => ({
  AuthRequestError: class AuthRequestError extends Error {
    code = "TEST_ERROR";
    fieldErrors = undefined;
  },
  login: vi.fn(),
  setupPassword: vi.fn(),
  submitAccountRequest: mocks.submitAccountRequest,
  listEmployeeAccountRequests: mocks.listEmployeeAccountRequests,
  listEmployeeAccounts: mocks.listEmployeeAccounts,
  removeClientAccount: mocks.removeClientAccount,
  decideAccountRequest: mocks.decideAccountRequest,
  resendSetupEmail: mocks.resendSetupEmail,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("password visibility controls", () => {
  it("keeps the login password hidden by default and preserves it while toggling", async () => {
    const user = userEvent.setup();
    render(<LoginForm />);
    const password = screen.getByLabelText("Password") as HTMLInputElement;

    expect(password.type).toBe("password");
    await user.type(password, "Keep-This-Password-42!");
    const toggle = screen.getByRole("button", { name: "Show password" });
    toggle.focus();
    await user.keyboard("{Enter}");

    expect(password.type).toBe("text");
    expect(password.value).toBe("Keep-This-Password-42!");
    expect(
      screen.getByRole("button", { name: "Hide password" }).getAttribute("aria-pressed"),
    ).toBe("true");

    await user.click(screen.getByRole("button", { name: "Hide password" }));
    expect(password.type).toBe("password");
    expect(password.value).toBe("Keep-This-Password-42!");
  });

  it("provides independent controls for new and confirm password fields", async () => {
    const user = userEvent.setup();
    render(
      <PasswordSetupForm
        email="applicant@example.test"
        token="a-valid-looking-setup-token-that-is-long-enough"
        derivation={{
          algorithm: "scrypt",
          salt: "AAAAAAAAAAAAAAAAAAAAAA",
          cost: 32_768,
          blockSize: 8,
          parallelization: 3,
          keyLength: 32,
        }}
      />,
    );
    const newPassword = screen.getByLabelText("New password") as HTMLInputElement;
    const confirmation = screen.getByLabelText("Confirm password") as HTMLInputElement;
    await user.type(newPassword, "New-Password-For-Test-42!");
    await user.type(confirmation, "New-Password-For-Test-42!");

    const toggles = screen.getAllByRole("button", { name: "Show password" });
    await user.click(toggles[0]);
    expect(newPassword.type).toBe("text");
    expect(confirmation.type).toBe("password");
    expect(newPassword.value).toBe("New-Password-For-Test-42!");
    expect(confirmation.value).toBe("New-Password-For-Test-42!");
  });
});

describe("account request and employee summary UI", () => {
  it("marks organisation fields optional and counts the administrator message", async () => {
    const user = userEvent.setup();
    render(<AccountRequestForm />);

    expect((screen.getByLabelText(/Full name/u) as HTMLInputElement).required).toBe(true);
    expect(
      (screen.getByLabelText("Company or organisation name") as HTMLInputElement).required,
    ).toBe(false);
    expect((screen.getByLabelText("Department") as HTMLInputElement).required).toBe(false);
    expect((screen.getByLabelText("Job title") as HTMLInputElement).required).toBe(false);

    const message = screen.getByLabelText("Message to administrator");
    await user.type(message, "Review context");
    expect(screen.getByText("14 / 1,000")).toBeTruthy();
    expect(message).toHaveProperty("maxLength", 1_000);
    expect(screen.queryByText(/verification code/iu)).toBeNull();
    expect(screen.queryByRole("button", { name: /resend verification/iu })).toBeNull();
  });

  it("validates and displays an optional supporting document", async () => {
    const user = userEvent.setup();
    render(<AccountRequestForm />);
    const input = document.querySelector("#account-attachment") as HTMLInputElement;

    fireEvent.change(input, {
      target: {
        files: [
          new File(["not supported"], "notes.txt", { type: "text/plain" }),
        ],
      },
    });
    expect(await screen.findByText(/Unsupported file format/u)).toBeTruthy();
    expect(screen.queryByText("notes.txt")).toBeNull();

    const documentFile = new File(["document"], "application.pdf", {
      type: "application/pdf",
    });
    fireEvent.change(input, { target: { files: [documentFile] } });
    expect(screen.getByText("application.pdf")).toBeTruthy();
    expect(screen.getByText("Ready to upload")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.queryByText("application.pdf")).toBeNull();
  });

  it("renders separate employee and client role totals", async () => {
    mocks.listEmployeeAccountRequests.mockResolvedValue({
      requests: [],
      summary: { employeeAccounts: 4, clientAccounts: 7 },
    });
    render(<ApprovalDashboard />);

    expect(await screen.findByText("Employee accounts")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.getByText("Client accounts")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
  });

  it("shows separate account tabs and requires two-step confirmation to remove a client", async () => {
    const user = userEvent.setup();
    mocks.listEmployeeAccountRequests.mockResolvedValue({
      requests: [],
      summary: { employeeAccounts: 1, clientAccounts: 1 },
    });
    mocks.listEmployeeAccounts.mockResolvedValue({
      accounts: [
        {
          id: "client-1",
          email: "client@example.test",
          fullName: "Client Person",
          role: "client",
          status: "active",
          createdAt: 1,
          reviewRequestCount: 12,
          rewriteRequestCount: 34,
        },
      ],
      summary: { employeeAccounts: 1, clientAccounts: 1 },
    });
    mocks.removeClientAccount.mockResolvedValue({
      removedAccount: {
        id: "client-1",
        email: "client@example.test",
        fullName: "Client Person",
        role: "client",
        status: "active",
        createdAt: 1,
      },
      audit: {},
      emailDelivery: { status: "preview" },
    });

    render(<ApprovalDashboard />);
    expect(await screen.findByRole("tab", { name: "Account Approval" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Client Accounts" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Employee Accounts" })).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "Client Accounts" }));
    expect(await screen.findByText("Client Person")).toBeTruthy();
    expect(screen.getByText("client@example.test")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("34")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove account" }));

    expect(screen.getByRole("dialog").textContent).toContain(
      "This will revoke the client's access",
    );
    await user.click(screen.getByRole("button", { name: "Review removal" }));
    expect(
      screen.getByText("Enter a removal message before continuing."),
    ).toBeTruthy();
    expect(mocks.removeClientAccount).not.toHaveBeenCalled();

    await user.type(
      screen.getByLabelText("Removal reason or message"),
      "Access is no longer required.",
    );
    await user.click(screen.getByRole("button", { name: "Review removal" }));
    expect(
      screen.getByRole("heading", { name: "Confirm account removal" }),
    ).toBeTruthy();
    expect(mocks.removeClientAccount).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Final confirm removal" }),
    );
    expect(mocks.removeClientAccount).toHaveBeenCalledWith("client-1", {
      message: "Access is no longer required.",
    });
    expect(
      await screen.findByText(/Email preview mode recorded the notification/iu),
    ).toBeTruthy();
  });

  it("cancels client removal without calling the API", async () => {
    const user = userEvent.setup();
    mocks.listEmployeeAccountRequests.mockResolvedValue({
      requests: [],
      summary: { employeeAccounts: 1, clientAccounts: 1 },
    });
    mocks.listEmployeeAccounts.mockResolvedValue({
      accounts: [
        {
          id: "client-cancel",
          email: "cancel@example.test",
          fullName: "Cancel Client",
          role: "client",
          status: "active",
          createdAt: 1,
        },
      ],
      summary: { employeeAccounts: 1, clientAccounts: 1 },
    });
    render(<ApprovalDashboard />);
    await user.click(await screen.findByRole("tab", { name: "Client Accounts" }));
    await user.click(await screen.findByRole("button", { name: "Remove account" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.removeClientAccount).not.toHaveBeenCalled();
  });

  it("shows employee names and emails without an employee-removal action", async () => {
    const user = userEvent.setup();
    mocks.listEmployeeAccountRequests.mockResolvedValue({
      requests: [],
      summary: { employeeAccounts: 1, clientAccounts: 0 },
    });
    mocks.listEmployeeAccounts.mockResolvedValue({
      accounts: [
        {
          id: "employee-1",
          email: "employee@example.test",
          fullName: "Employee Person",
          role: "employee",
          status: "active",
          createdAt: 1,
        },
      ],
      summary: { employeeAccounts: 1, clientAccounts: 0 },
    });

    render(<ApprovalDashboard />);
    await user.click(
      await screen.findByRole("tab", { name: "Employee Accounts" }),
    );
    expect(await screen.findByText("Employee Person")).toBeTruthy();
    expect(screen.getByText("employee@example.test")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Remove account" }),
    ).toBeNull();
  });

  it("renders employee timestamps in a fixed Hong Kong time zone", () => {
    render(
      <EmployeeRequestDetails
        initialRequest={{
          id: "request-time-zone",
          fullName: "Time Zone Applicant",
          email: "timezone@example.test",
          phone: "+852 2345 6789",
          company: null,
          department: null,
          jobTitle: null,
          adminMessage: null,
          attachment: null,
          status: "pending",
          createdAt: Date.UTC(2026, 0, 1, 0, 0) / 1_000,
          updatedAt: Date.UTC(2026, 0, 1, 0, 0) / 1_000,
          decidedAt: null,
          rejectionReason: null,
          decidedBy: null,
        }}
      />,
    );

    expect(screen.getAllByText("1 Jan 2026, 8:00 am")).toHaveLength(2);
  });
});
