"use client";

import { useState } from "react";

import { PasswordInput } from "@/components/auth/password-input";
import { AuthRequestError, login } from "@/lib/client/auth-api";
import {
  loginInputSchema,
  PASSWORD_MAX_LENGTH,
} from "@/lib/shared/auth-contracts";

export function LoginForm({
  returnTo,
  sessionExpired = false,
}: {
  returnTo?: string;
  sessionExpired?: boolean;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setErrorMessage("");
    const parsed = loginInputSchema.safeParse({ email, password, returnTo });
    if (!parsed.success) {
      setErrorMessage(
        parsed.error.issues[0]?.message || "Enter a valid email address and password.",
      );
      return;
    }

    setSubmitting(true);
    try {
      const result = await login(parsed.data);
      window.location.replace(result.redirectTo);
    } catch (error) {
      setErrorMessage(
        error instanceof AuthRequestError
          ? error.message
          : "Unable to sign in. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit} noValidate>
      {sessionExpired ? (
        <div className="auth-alert" role="status">
          Your session ended. Sign in again to continue.
        </div>
      ) : null}
      <div className="auth-field">
        <label htmlFor="login-email">Email address</label>
        <input
          id="login-email"
          type="email"
          autoComplete="username"
          value={email}
          disabled={submitting}
          required
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <div className="auth-field">
        <label htmlFor="login-password">Password</label>
        <PasswordInput
          id="login-password"
          autoComplete="current-password"
          value={password}
          disabled={submitting}
          required
          maxLength={PASSWORD_MAX_LENGTH + 1}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      {errorMessage ? (
        <div className="auth-alert auth-alert-error" role="alert">
          {errorMessage}
        </div>
      ) : null}
      <button className="button button-primary auth-submit" type="submit" disabled={submitting}>
        {submitting ? (
          <>
            <span className="spinner" aria-hidden="true" />
            Signing in
          </>
        ) : (
          "Login"
        )}
      </button>
    </form>
  );
}
