"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  AuthRequestError,
  submitAccountRequest,
} from "@/lib/client/auth-api";
import {
  accountRequestInputSchema,
  type AccountRequestInput,
} from "@/lib/shared/auth-contracts";

type FieldName = keyof AccountRequestInput;

const INITIAL_VALUES: AccountRequestInput = {
  fullName: "",
  email: "",
  phone: "",
  company: "",
  department: "",
  jobTitle: "",
};

const FIELDS: Array<{
  name: FieldName;
  label: string;
  type?: "email" | "tel" | "text";
  autoComplete: string;
}> = [
  { name: "fullName", label: "Full name", autoComplete: "name" },
  { name: "email", label: "Email address", type: "email", autoComplete: "email" },
  { name: "phone", label: "Phone number", type: "tel", autoComplete: "tel" },
  {
    name: "company",
    label: "Company or organisation name",
    autoComplete: "organization",
  },
  {
    name: "department",
    label: "Department",
    autoComplete: "organization-title",
  },
  { name: "jobTitle", label: "Job title", autoComplete: "organization-title" },
];

function issuesByField(error: {
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

export function AccountRequestForm() {
  const router = useRouter();
  const [values, setValues] = useState<AccountRequestInput>(INITIAL_VALUES);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setFormError("");
    const parsed = accountRequestInputSchema.safeParse(values);
    if (!parsed.success) {
      setFieldErrors(issuesByField(parsed.error));
      return;
    }

    setSubmitting(true);
    setFieldErrors({});
    try {
      await submitAccountRequest(parsed.data);
      router.replace("/request-submitted");
    } catch (error) {
      if (error instanceof AuthRequestError) {
        setFieldErrors(error.fieldErrors ?? {});
        setFormError(error.message);
      } else {
        setFormError("The request could not be submitted. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit} noValidate>
      <div className="auth-field-grid">
        {FIELDS.map((field) => {
          const errorId = `${field.name}-error`;
          const errors = fieldErrors[field.name];
          return (
            <div className={field.name === "company" ? "auth-field auth-field-wide" : "auth-field"} key={field.name}>
              <label htmlFor={field.name}>
                {field.label} <span aria-hidden="true">*</span>
              </label>
              <input
                id={field.name}
                name={field.name}
                type={field.type ?? "text"}
                autoComplete={field.autoComplete}
                value={values[field.name]}
                aria-invalid={Boolean(errors?.length)}
                aria-describedby={errors?.length ? errorId : undefined}
                disabled={submitting}
                required
                onChange={(event) => {
                  setValues((current) => ({
                    ...current,
                    [field.name]: event.target.value,
                  }));
                  setFieldErrors((current) => {
                    const next = { ...current };
                    delete next[field.name];
                    return next;
                  });
                }}
              />
              {errors?.length ? (
                <p id={errorId} className="auth-field-error" role="alert">
                  {errors[0]}
                </p>
              ) : null}
            </div>
          );
        })}
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
            Submitting request
          </>
        ) : (
          "Request an account"
        )}
      </button>
    </form>
  );
}
