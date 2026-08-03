import type {
  AccountDecisionInput,
  AccountListUserView,
  AccountRequestInput,
  AccountRequestView,
  AccountRoleSummary,
  AuthApiErrorBody,
  AuthenticatedUser,
  ClientRemovalAuditView,
  ClientRemovalInput,
  EmailDeliveryView,
  LoginInput,
  PasswordDerivation,
  PasswordSetupFormInput,
} from "@/lib/shared/auth-contracts";
import { derivePasswordProof } from "@/lib/client/password-proof";

const CSRF_COOKIE_NAME = "pressready_csrf";

export class AuthRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly fieldErrors?: Record<string, string[]>,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "AuthRequestError";
  }
}

export function getCsrfToken() {
  if (typeof document === "undefined") return "";
  for (const part of document.cookie.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName !== CSRF_COOKIE_NAME) continue;
    try {
      return decodeURIComponent(rawValue.join("="));
    } catch {
      return "";
    }
  }
  return "";
}

export function csrfHeaders(): Record<string, string> {
  const token = getCsrfToken();
  return token ? { "X-CSRF-Token": token } : {};
}

async function requestJson<T>(
  endpoint: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(endpoint, {
    ...init,
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...init.headers,
    },
  });

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AuthRequestError(
      "INVALID_SERVER_RESPONSE",
      "The server returned an unreadable response.",
      undefined,
      response.status,
    );
  }

  if (!response.ok) {
    const errorBody = body as Partial<AuthApiErrorBody>;
    const error = errorBody.error;
    throw new AuthRequestError(
      error?.code || "REQUEST_FAILED",
      error?.message || "The request failed. Please try again.",
      error?.fieldErrors,
      response.status,
    );
  }
  return body as T;
}

function postJson<T>(endpoint: string, body: unknown, includeCsrf = false) {
  return requestJson<T>(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(includeCsrf ? csrfHeaders() : {}),
    },
    body: JSON.stringify(body),
  });
}

export function submitAccountRequest(
  input: AccountRequestInput,
  attachment?: File | null,
) {
  if (attachment) {
    const formData = new FormData();
    for (const [key, value] of Object.entries(input)) {
      formData.set(key, value ?? "");
    }
    formData.set("attachment", attachment);
    return requestJson<{
      requestId: string;
      status: "pending";
      message: string;
      notificationStatus: "sent" | "preview" | "failed";
    }>("/api/account-requests", {
      method: "POST",
      body: formData,
    });
  }
  return postJson<{
    requestId: string;
    status: "pending";
    message: string;
    notificationStatus: "sent" | "preview" | "failed";
  }>("/api/account-requests", input);
}

export async function login(input: LoginInput) {
  const challenge = await postJson<{ derivation: PasswordDerivation }>(
    "/api/auth/login/challenge",
    { email: input.email },
  );
  const passwordProof = await derivePasswordProof(
    input.password,
    challenge.derivation,
  );
  return postJson<{
    user: AuthenticatedUser;
    redirectTo: string;
  }>("/api/auth/login", { ...input, passwordProof });
}

export async function setupPassword(
  input: PasswordSetupFormInput,
  derivation: PasswordDerivation,
) {
  const passwordProof = await derivePasswordProof(
    input.newPassword,
    derivation,
  );
  return postJson<{
    user: AuthenticatedUser;
    redirectTo: string;
  }>("/api/auth/setup-password", {
    ...input,
    passwordSalt: derivation.salt,
    passwordProof,
  });
}

export function validateSetupToken(token: string) {
  return postJson<{
    email: string;
    fullName: string;
    expiresAt: number;
    derivation: PasswordDerivation;
  }>("/api/auth/setup-password/validate", { token });
}

export function logout() {
  return postJson<{ redirectTo: string }>("/api/auth/logout", {}, true);
}

export function listEmployeeAccountRequests(status?: string) {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  return requestJson<{ requests: AccountRequestView[]; summary: AccountRoleSummary }>(
    `/api/employee/account-requests${query}`,
    { method: "GET" },
  );
}

export function getEmployeeAccountRequest(id: string) {
  return requestJson<{ request: AccountRequestView }>(
    `/api/employee/account-requests/${encodeURIComponent(id)}`,
    { method: "GET" },
  );
}

export function decideAccountRequest(id: string, input: AccountDecisionInput) {
  return requestJson<{
    request: AccountRequestView;
    emailDelivery: EmailDeliveryView;
  }>(`/api/employee/account-requests/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...csrfHeaders(),
    },
    body: JSON.stringify(input),
  });
}

export function resendSetupEmail(id: string) {
  return postJson<{
    request: AccountRequestView;
    emailDelivery: EmailDeliveryView;
  }>(
    `/api/employee/account-requests/${encodeURIComponent(id)}/resend-setup`,
    {},
    true,
  );
}

export function listEmployeeAccounts(role: "client" | "employee") {
  return requestJson<{
    accounts: AccountListUserView[];
    summary: AccountRoleSummary;
  }>(`/api/employee/accounts?role=${encodeURIComponent(role)}`, {
    method: "GET",
  });
}

export function removeClientAccount(id: string, input: ClientRemovalInput) {
  return postJson<{
    removedAccount: AccountListUserView;
    audit: ClientRemovalAuditView;
    emailDelivery: EmailDeliveryView;
  }>(
    `/api/employee/accounts/${encodeURIComponent(id)}/remove`,
    input,
    true,
  );
}
