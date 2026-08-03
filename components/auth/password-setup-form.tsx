"use client";

import { useState } from "react";

import { PasswordInput } from "@/components/auth/password-input";
import { AuthRequestError, setupPassword } from "@/lib/client/auth-api";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordSetupFormInputSchema,
  passwordValidationMessages,
  type PasswordDerivation,
} from "@/lib/shared/auth-contracts";

function fieldIssues(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}) {
  const result: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "form");
    result[field] ??= [];
    result[field].push(issue.message);
  }
  return result;
}

export function PasswordSetupForm({
  email,
  token,
  derivation,
}: {
  email: string;
  token: string;
  derivation: PasswordDerivation;
}) {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const validationMessages = passwordValidationMessages(newPassword);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setFormError("");
    const parsed = passwordSetupFormInputSchema.safeParse({
      token,
      newPassword,
      confirmPassword,
    });
    if (!parsed.success) {
      setErrors(fieldIssues(parsed.error));
      return;
    }

    setSubmitting(true);
    setErrors({});
    try {
      const result = await setupPassword(parsed.data, derivation);
      window.location.replace(result.redirectTo);
    } catch (error) {
      if (error instanceof AuthRequestError) {
        if (error.code === "INVALID_SETUP_TOKEN") {
          window.location.replace("/invalid-setup-link");
          return;
        }
        setErrors(error.fieldErrors ?? {});
        setFormError(error.message);
      } else {
        setFormError("The password could not be saved. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit} noValidate>
      <div className="auth-field">
        <label htmlFor="setup-email">Email address</label>
        <input id="setup-email" type="email" value={email} readOnly aria-readonly="true" />
      </div>
      <div className="auth-field">
        <label htmlFor="new-password">New password</label>
        <PasswordInput
          id="new-password"
          autoComplete="new-password"
          value={newPassword}
          disabled={submitting}
          maxLength={PASSWORD_MAX_LENGTH + 1}
          aria-invalid={Boolean(errors.newPassword?.length)}
          aria-describedby="password-requirements new-password-error"
          onChange={(event) => {
            setNewPassword(event.target.value);
            setErrors((current) => ({ ...current, newPassword: [] }));
          }}
        />
        <div id="password-requirements" className="password-requirements">
          <strong>Password requirements</strong>
          <ul>
            <li
              className={
                newPassword.length >= PASSWORD_MIN_LENGTH &&
                newPassword.length <= PASSWORD_MAX_LENGTH
                  ? "requirement-met"
                  : ""
              }
            >
              More than 8 and fewer than 64 characters
            </li>
            <li
              className={
                newPassword &&
                !validationMessages.some((message) =>
                  message.includes("English keyboard"),
                )
                  ? "requirement-met"
                  : ""
              }
            >
              English keyboard characters
            </li>
          </ul>
        </div>
        {errors.newPassword?.length ? (
          <p id="new-password-error" className="auth-field-error" role="alert">
            {errors.newPassword[0]}
          </p>
        ) : null}
      </div>
      <div className="auth-field">
        <label htmlFor="confirm-password">Confirm password</label>
        <PasswordInput
          id="confirm-password"
          autoComplete="new-password"
          value={confirmPassword}
          disabled={submitting}
          maxLength={PASSWORD_MAX_LENGTH + 1}
          aria-invalid={Boolean(errors.confirmPassword?.length)}
          aria-describedby="confirm-password-error"
          onChange={(event) => {
            setConfirmPassword(event.target.value);
            setErrors((current) => ({ ...current, confirmPassword: [] }));
          }}
        />
        {errors.confirmPassword?.length ? (
          <p id="confirm-password-error" className="auth-field-error" role="alert">
            {errors.confirmPassword[0]}
          </p>
        ) : null}
      </div>
      {formError ? (
        <div className="auth-alert auth-alert-error" role="alert">
          {formError}
        </div>
      ) : null}
      <button className="button button-primary auth-submit" type="submit" disabled={submitting}>
        {submitting ? (
          <>
            <span className="spinner" aria-hidden="true" />
            Creating password
          </>
        ) : (
          "Create password and continue"
        )}
      </button>
    </form>
  );
}
