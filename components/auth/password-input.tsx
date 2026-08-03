"use client";

import { useState, type InputHTMLAttributes } from "react";

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

export function PasswordInput(props: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  const label = visible ? "Hide password" : "Show password";

  return (
    <div className="password-input">
      <input {...props} type={visible ? "text" : "password"} />
      <button
        className="password-visibility-toggle"
        type="button"
        aria-label={label}
        aria-pressed={visible}
        aria-controls={props.id}
        disabled={props.disabled}
        onClick={() => setVisible((current) => !current)}
      >
        <span className="password-eye" aria-hidden="true">
          <span className="password-eye-pupil" />
        </span>
        {!visible ? <span className="password-eye-slash" aria-hidden="true" /> : null}
      </button>
    </div>
  );
}
