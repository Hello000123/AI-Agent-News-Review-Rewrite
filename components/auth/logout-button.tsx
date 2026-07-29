"use client";

import { useState } from "react";

import { AuthRequestError, logout } from "@/lib/client/auth-api";
import { clearRewriteSession } from "@/lib/client/rewrite-session";

export function LogoutButton() {
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  async function handleLogout() {
    if (submitting) return;
    setSubmitting(true);
    setErrorMessage("");
    try {
      const result = await logout();
      clearRewriteSession();
      window.location.replace(result.redirectTo);
    } catch (error) {
      if (error instanceof AuthRequestError && error.status === 401) {
        clearRewriteSession();
        window.location.replace("/login");
        return;
      }
      setErrorMessage("Logout failed. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <div className="logout-control">
      <button
        className="button button-quiet account-logout"
        type="button"
        disabled={submitting}
        onClick={handleLogout}
      >
        {submitting ? "Logging out…" : "Logout"}
      </button>
      {errorMessage ? <span role="alert">{errorMessage}</span> : null}
    </div>
  );
}
