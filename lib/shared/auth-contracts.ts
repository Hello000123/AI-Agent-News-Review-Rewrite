import { z } from "zod";

export const USER_ROLES = ["client", "employee"] as const;
export const USER_STATUSES = ["setup_pending", "active", "disabled"] as const;
export const ACCOUNT_REQUEST_STATUSES = ["pending", "approved", "rejected"] as const;

export type UserRole = (typeof USER_ROLES)[number];
export type UserStatus = (typeof USER_STATUSES)[number];
export type AccountRequestStatus = (typeof ACCOUNT_REQUEST_STATUSES)[number];

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

function requiredSingleLine(label: string, maximum: number) {
  return z
    .string()
    .max(maximum + 64, `${label} is too long.`)
    .refine((value) => !CONTROL_CHARACTERS.test(value), `${label} contains invalid characters.`)
    .transform((value) => value.normalize("NFC").trim().replace(/\s+/gu, " "))
    .pipe(
      z
        .string()
        .min(1, `${label} is required.`)
        .max(maximum, `${label} must be ${maximum} characters or fewer.`),
    );
}

export const emailSchema = z
  .string()
  .trim()
  .max(254, "Email address is too long.")
  .email("Enter a valid email address.")
  .transform((value) => value.toLowerCase());

export const phoneSchema = z
  .string()
  .trim()
  .max(32, "Phone number is too long.")
  .refine(
    (value) => /^\+?[\d\s().-]+$/u.test(value),
    "Enter a valid phone number using digits and standard separators.",
  )
  .refine((value) => {
    const digits = value.replace(/\D/gu, "");
    return digits.length >= 7 && digits.length <= 15;
  }, "Phone number must contain between 7 and 15 digits.")
  .transform((value) => value.replace(/\s+/gu, " ").trim());

export const accountRequestInputSchema = z
  .object({
    fullName: requiredSingleLine("Full name", 120),
    email: emailSchema,
    phone: phoneSchema,
    company: requiredSingleLine("Company or organisation", 160),
    department: requiredSingleLine("Department", 120),
    jobTitle: requiredSingleLine("Job title", 120),
  })
  .strict();

export type AccountRequestInput = z.infer<typeof accountRequestInputSchema>;

export const loginInputSchema = z
  .object({
    email: emailSchema,
    password: z
      .string()
      .min(1, "Password is required.")
      .max(128, "Password must be 128 characters or fewer."),
    returnTo: z.string().max(300).optional(),
  })
  .strict();

export type LoginInput = z.infer<typeof loginInputSchema>;

export const setupTokenInputSchema = z
  .object({
    token: z.string().min(32, "The setup link is invalid.").max(256, "The setup link is invalid."),
  })
  .strict();

export function passwordStrengthMessages(password: string) {
  const messages: string[] = [];
  if (password.length < 12) messages.push("Use at least 12 characters.");
  if (password.length > 128) messages.push("Use no more than 128 characters.");

  const categories = [
    /[a-z]/u.test(password),
    /[A-Z]/u.test(password),
    /\d/u.test(password),
    /[^\p{L}\p{N}\s]/u.test(password),
  ].filter(Boolean).length;

  if (categories < 3) {
    messages.push(
      "Use characters from at least three groups: lowercase, uppercase, numbers, and symbols.",
    );
  }
  if (CONTROL_CHARACTERS.test(password)) {
    messages.push("Password contains an unsupported control character.");
  }
  return messages;
}

export const passwordSetupInputSchema = z
  .object({
    token: setupTokenInputSchema.shape.token,
    newPassword: z.string(),
    confirmPassword: z.string(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.newPassword !== value.confirmPassword) {
      context.addIssue({
        code: "custom",
        path: ["confirmPassword"],
        message: "Passwords do not match.",
      });
    }
    for (const message of passwordStrengthMessages(value.newPassword)) {
      context.addIssue({
        code: "custom",
        path: ["newPassword"],
        message,
      });
    }
  });

export type PasswordSetupInput = z.infer<typeof passwordSetupInputSchema>;

export const accountDecisionInputSchema = z
  .object({
    action: z.enum(["approve", "reject"]),
    rejectionReason: z
      .string()
      .max(1_000, "Rejection reason must be 1,000 characters or fewer.")
      .refine(
        (value) => !CONTROL_CHARACTERS.test(value),
        "Rejection reason contains invalid characters.",
      )
      .transform((value) => value.normalize("NFC").trim())
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === "approve" && value.rejectionReason) {
      context.addIssue({
        code: "custom",
        path: ["rejectionReason"],
        message: "A rejection reason cannot be added to an approval.",
      });
    }
  });

export type AccountDecisionInput = z.infer<typeof accountDecisionInputSchema>;

export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
}

export interface AccountRequestView {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  company: string;
  department: string;
  jobTitle: string;
  status: AccountRequestStatus;
  createdAt: number;
  updatedAt: number;
  decidedAt: number | null;
  rejectionReason: string | null;
  decidedBy: {
    id: string;
    fullName: string;
    email: string;
  } | null;
}

export interface AuthApiErrorBody {
  error: {
    code: string;
    message: string;
    fieldErrors?: Record<string, string[]>;
  };
}

export interface EmailDeliveryView {
  status: "sent" | "preview" | "failed";
  developmentSetupUrl?: string;
}
