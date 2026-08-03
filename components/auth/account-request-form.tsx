"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import {
  AuthRequestError,
  submitAccountRequest,
} from "@/lib/client/auth-api";
import {
  ADMIN_MESSAGE_MAX_LENGTH,
  accountRequestInputSchema,
} from "@/lib/shared/auth-contracts";
import {
  FILE_UPLOAD_ACCEPT,
  SUPPORTED_UPLOAD_HELP,
  validateUploadMetadata,
} from "@/lib/shared/file-upload";

interface AccountRequestDraft {
  fullName: string;
  email: string;
  phone: string;
  company: string;
  department: string;
  jobTitle: string;
  adminMessage: string;
}

type FieldName = Exclude<keyof AccountRequestDraft, "adminMessage">;

const INITIAL_VALUES: AccountRequestDraft = {
  fullName: "",
  email: "",
  phone: "",
  company: "",
  department: "",
  jobTitle: "",
  adminMessage: "",
};

const FIELDS: Array<{
  name: FieldName;
  label: string;
  type?: "email" | "tel" | "text";
  autoComplete: string;
  required: boolean;
}> = [
  { name: "fullName", label: "Full name", autoComplete: "name", required: true },
  {
    name: "email",
    label: "Email address",
    type: "email",
    autoComplete: "email",
    required: true,
  },
  {
    name: "phone",
    label: "Phone number",
    type: "tel",
    autoComplete: "tel",
    required: true,
  },
  {
    name: "company",
    label: "Company or organisation name",
    autoComplete: "organization",
    required: false,
  },
  {
    name: "department",
    label: "Department",
    autoComplete: "organization-title",
    required: false,
  },
  {
    name: "jobTitle",
    label: "Job title",
    autoComplete: "organization-title",
    required: false,
  },
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
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const [values, setValues] = useState<AccountRequestDraft>(INITIAL_VALUES);
  const [attachment, setAttachment] = useState<File | null>(null);
  const [attachmentError, setAttachmentError] = useState("");
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
    if (attachment) {
      const validation = validateUploadMetadata(attachment);
      if ("error" in validation) {
        setAttachmentError(validation.error);
        return;
      }
    }

    setSubmitting(true);
    setFieldErrors({});
    try {
      await submitAccountRequest(parsed.data, attachment);
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
                {field.label}
                {field.required ? <> <span aria-hidden="true">*</span></> : null}
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
                required={field.required}
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
        <div className="auth-field auth-field-wide">
          <label htmlFor="adminMessage">Message to administrator</label>
          <textarea
            id="adminMessage"
            name="adminMessage"
            value={values.adminMessage}
            maxLength={ADMIN_MESSAGE_MAX_LENGTH}
            aria-invalid={Boolean(fieldErrors.adminMessage?.length)}
            aria-describedby={
              fieldErrors.adminMessage?.length
                ? "admin-message-help admin-message-count adminMessage-error"
                : "admin-message-help admin-message-count"
            }
            disabled={submitting}
            onChange={(event) => {
              setValues((current) => ({
                ...current,
                adminMessage: event.target.value,
              }));
              setFieldErrors((current) => {
                const next = { ...current };
                delete next.adminMessage;
                return next;
              });
            }}
          />
          <div className="auth-field-support">
            <p id="admin-message-help" className="auth-field-help">
              You may provide additional information to help us review your account request.
            </p>
            <span id="admin-message-count" className="auth-character-count" aria-live="polite">
              {values.adminMessage.length.toLocaleString()} /{" "}
              {ADMIN_MESSAGE_MAX_LENGTH.toLocaleString()}
            </span>
          </div>
          {fieldErrors.adminMessage?.length ? (
            <p id="adminMessage-error" className="auth-field-error" role="alert">
              {fieldErrors.adminMessage[0]}
            </p>
          ) : null}
        </div>
        <div className="auth-field auth-field-wide">
          <span className="auth-upload-label">Supporting document (optional)</span>
          <div
            className={`file-upload-zone ${attachmentError ? "file-upload-zone-error" : ""}`}
          >
            <input
              ref={attachmentInputRef}
              id="account-attachment"
              className="visually-hidden-file-input"
              name="attachment"
              type="file"
              accept={FILE_UPLOAD_ACCEPT}
              disabled={submitting}
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                if (!file) return;
                const validation = validateUploadMetadata(file);
                if ("error" in validation) {
                  setAttachment(null);
                  setAttachmentError(validation.error);
                  event.target.value = "";
                  return;
                }
                setAttachment(file);
                setAttachmentError("");
              }}
            />
            <div>
              <strong>Add a supporting file</strong>
              <p>{SUPPORTED_UPLOAD_HELP}</p>
            </div>
            <label className="button button-secondary file-picker-button" htmlFor="account-attachment">
              Choose file
            </label>
          </div>
          {attachment ? (
            <div className="attachment-row" aria-live="polite">
              <div className="attachment-icon" aria-hidden="true">DOC</div>
              <div className="attachment-details">
                <strong>{attachment.name}</strong>
                <span>
                  {attachment.type} · {(attachment.size / 1024).toLocaleString("en-US", {
                    maximumFractionDigits: 1,
                  })} KB
                </span>
                <span className="attachment-status">
                  {submitting ? (
                    <>
                      <span className="spinner" aria-hidden="true" />
                      Uploading securely
                    </>
                  ) : (
                    "Ready to upload"
                  )}
                </span>
              </div>
              <button
                className="button button-quiet attachment-remove"
                type="button"
                disabled={submitting}
                onClick={() => {
                  setAttachment(null);
                  setAttachmentError("");
                  if (attachmentInputRef.current) attachmentInputRef.current.value = "";
                }}
              >
                Remove
              </button>
            </div>
          ) : null}
          {attachmentError ? (
            <p className="auth-field-error" role="alert">
              {attachmentError}
            </p>
          ) : null}
        </div>
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
