import { z } from "zod";

export const USER_ROLES = ["client", "employee"] as const;
export const USER_STATUSES = ["setup_pending", "active", "disabled"] as const;
export const ACCOUNT_REQUEST_STATUSES = ["pending", "approved", "rejected"] as const;

export type UserRole = (typeof USER_ROLES)[number];
export type UserStatus = (typeof USER_STATUSES)[number];
export type AccountRequestStatus = (typeof ACCOUNT_REQUEST_STATUSES)[number];

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const MULTILINE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const ENGLISH_KEYBOARD_CHARACTERS = /^[\u0020-\u007e]+$/u;
export const ADMIN_MESSAGE_MAX_LENGTH = 1_000;
export const CLIENT_REMOVAL_MESSAGE_MAX_LENGTH = 1_000;
export const PASSWORD_MIN_LENGTH = 9;
export const PASSWORD_MAX_LENGTH = 63;
export const PASSWORD_PROOF_BYTES = 32;
export const PASSWORD_SALT_BYTES = 16;
export const SCRYPT_COST = 32_768;
export const SCRYPT_BLOCK_SIZE = 8;
export const SCRYPT_PARALLELIZATION = 3;

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

function optionalSingleLine(label: string, maximum: number) {
  return z
    .string()
    .max(maximum + 64, `${label} is too long.`)
    .refine((value) => !CONTROL_CHARACTERS.test(value), `${label} contains invalid characters.`)
    .transform((value) => value.normalize("NFC").trim().replace(/\s+/gu, " "))
    .pipe(z.string().max(maximum, `${label} must be ${maximum} characters or fewer.`))
    .transform((value) => value || null)
    .nullish()
    .transform((value) => value ?? null);
}

const optionalAdministratorMessageSchema = z
  .string()
  .max(
    ADMIN_MESSAGE_MAX_LENGTH + 64,
    `Message to administrator must be ${ADMIN_MESSAGE_MAX_LENGTH.toLocaleString()} characters or fewer.`,
  )
  .refine(
    (value) => !MULTILINE_CONTROL_CHARACTERS.test(value),
    "Message to administrator contains invalid characters.",
  )
  .transform((value) =>
    value.normalize("NFC").replace(/\r\n?/gu, "\n").trim(),
  )
  .pipe(
    z
      .string()
      .max(
        ADMIN_MESSAGE_MAX_LENGTH,
        `Message to administrator must be ${ADMIN_MESSAGE_MAX_LENGTH.toLocaleString()} characters or fewer.`,
      ),
  )
  .transform((value) => value || null)
  .nullish()
  .transform((value) => value ?? null);

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
    company: optionalSingleLine("Company or organisation", 160),
    department: optionalSingleLine("Department", 120),
    jobTitle: optionalSingleLine("Job title", 120),
    adminMessage: optionalAdministratorMessageSchema,
  })
  .strict();

export type AccountRequestInput = z.infer<typeof accountRequestInputSchema>;

const passwordProofSchema = z
  .string()
  .length(43, "The password proof is invalid.")
  .regex(/^[A-Za-z0-9_-]+$/u, "The password proof is invalid.");

const passwordSaltSchema = z
  .string()
  .length(22, "The password salt is invalid.")
  .regex(/^[A-Za-z0-9_-]+$/u, "The password salt is invalid.");

function addPasswordValidationIssues(
  password: string,
  context: z.RefinementCtx,
  path: string,
) {
  for (const message of passwordValidationMessages(password)) {
    context.addIssue({
      code: "custom",
      path: [path],
      message,
    });
  }
}

const loginInputFields = {
  email: emailSchema,
  password: z.string(),
  returnTo: z.string().max(300).optional(),
};

export const loginInputSchema = z
  .object(loginInputFields)
  .strict()
  .superRefine((value, context) => {
    addPasswordValidationIssues(value.password, context, "password");
  });

export type LoginInput = z.infer<typeof loginInputSchema>;

export const loginChallengeInputSchema = z
  .object({ email: emailSchema })
  .strict();

export const loginProofInputSchema = z
  .object({
    ...loginInputFields,
    passwordProof: passwordProofSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addPasswordValidationIssues(value.password, context, "password");
  });

export type LoginProofInput = z.infer<typeof loginProofInputSchema>;

export interface ScryptPasswordDerivation {
  algorithm: "scrypt";
  salt: string;
  cost: number;
  blockSize: number;
  parallelization: number;
  keyLength: number;
}

export interface Pbkdf2PasswordDerivation {
  algorithm: "pbkdf2-sha256";
  salt: string;
  iterations: number;
  keyLength: number;
}

export type PasswordDerivation =
  | ScryptPasswordDerivation
  | Pbkdf2PasswordDerivation;

export const setupTokenInputSchema = z
  .object({
    token: z.string().min(32, "The setup link is invalid.").max(256, "The setup link is invalid."),
  })
  .strict();

export function passwordValidationMessages(password: string) {
  const messages: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) {
    messages.push("Password must contain more than 8 characters.");
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    messages.push("Password must contain fewer than 64 characters.");
  }
  if (password.length > 0 && !ENGLISH_KEYBOARD_CHARACTERS.test(password)) {
    messages.push("Password must use English keyboard characters only.");
  }
  return messages;
}

export const passwordSetupFormInputSchema = z
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
    addPasswordValidationIssues(value.newPassword, context, "newPassword");
  });

export const passwordSetupInputSchema = z
  .object({
    token: setupTokenInputSchema.shape.token,
    newPassword: z.string(),
    confirmPassword: z.string(),
    passwordSalt: passwordSaltSchema,
    passwordProof: passwordProofSchema,
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
    addPasswordValidationIssues(value.newPassword, context, "newPassword");
  });

export type PasswordSetupFormInput = z.infer<
  typeof passwordSetupFormInputSchema
>;
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

export const clientRemovalInputSchema = z
  .object({
    message: z
      .string()
      .max(
        CLIENT_REMOVAL_MESSAGE_MAX_LENGTH + 64,
        `Removal message must be ${CLIENT_REMOVAL_MESSAGE_MAX_LENGTH.toLocaleString()} characters or fewer.`,
      )
      .refine(
        (value) => !MULTILINE_CONTROL_CHARACTERS.test(value),
        "Removal message contains invalid characters.",
      )
      .transform((value) =>
        value.normalize("NFC").replace(/\r\n?/gu, "\n").trim(),
      )
      .pipe(
        z
          .string()
          .min(1, "Enter a removal message before continuing.")
          .max(
            CLIENT_REMOVAL_MESSAGE_MAX_LENGTH,
            `Removal message must be ${CLIENT_REMOVAL_MESSAGE_MAX_LENGTH.toLocaleString()} characters or fewer.`,
          ),
      ),
  })
  .strict();

export type ClientRemovalInput = z.infer<typeof clientRemovalInputSchema>;

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
  company: string | null;
  department: string | null;
  jobTitle: string | null;
  adminMessage: string | null;
  attachment: AccountRequestAttachmentView | null;
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

export interface AccountRequestAttachmentView {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  createdAt: number;
}

export interface AccountRoleSummary {
  employeeAccounts: number;
  clientAccounts: number;
}

export interface AccountListUserView {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  status: UserStatus;
  createdAt: number;
  reviewRequestCount: number;
  rewriteRequestCount: number;
}

export interface ClientRemovalAuditView {
  id: string;
  removedClientAccountId: string;
  clientEmail: string;
  administratorAccountId: string;
  removalMessage: string;
  createdAt: number;
}

export interface AuthApiErrorBody {
  error: {
    code: string;
    message: string;
    fieldErrors?: Record<string, string[]>;
    requestId?: string;
  };
}

export interface EmailDeliveryView {
  status: "sent" | "preview" | "failed";
  developmentSetupUrl?: string;
}
