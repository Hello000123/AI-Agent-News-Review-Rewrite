"use client";

import { useEffect, useState } from "react";

import { PasswordSetupForm } from "@/components/auth/password-setup-form";
import { AuthRequestError, validateSetupToken } from "@/lib/client/auth-api";
import type { PasswordDerivation } from "@/lib/shared/auth-contracts";

interface SetupDetails {
  token: string;
  email: string;
  fullName: string;
  expiresAt: number;
  derivation: PasswordDerivation;
}

export function PasswordSetupPage() {
  const [details, setDetails] = useState<SetupDetails | null>(null);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    const parameters = new URLSearchParams(window.location.hash.slice(1));
    const token = parameters.get("token") ?? "";
    window.history.replaceState(null, "", "/setup-password");

    if (!token) {
      window.location.replace("/invalid-setup-link");
      return;
    }

    validateSetupToken(token)
      .then((result) => {
        if (!cancelled) setDetails({ token, ...result });
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof AuthRequestError && error.code === "INVALID_SETUP_TOKEN") {
          window.location.replace("/invalid-setup-link");
          return;
        }
        setErrorMessage(
          error instanceof AuthRequestError
            ? error.message
            : "The setup link could not be checked. Please try again.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (errorMessage) {
    return (
      <div className="auth-alert auth-alert-error" role="alert">
        {errorMessage}
      </div>
    );
  }

  if (!details) {
    return (
      <div className="loading-panel" role="status">
        <span className="spinner spinner-dark" aria-hidden="true" />
        <div>
          <strong>Checking setup link</strong>
          <p>Confirming that this single-use link is valid.</p>
        </div>
      </div>
    );
  }

  return (
    <PasswordSetupForm
      email={details.email}
      token={details.token}
      derivation={details.derivation}
    />
  );
}
