import Link from "next/link";
import type { ReactNode } from "react";

interface AuthShellProps {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}

export function AuthShell({
  eyebrow,
  title,
  description,
  children,
  footer,
  wide = false,
}: AuthShellProps) {
  return (
    <main className="auth-page">
      <div className={`auth-shell${wide ? " auth-shell-wide" : ""}`}>
        <Link className="auth-brand" href="/">
          PressReady
        </Link>
        <section className="card auth-card" aria-labelledby="auth-page-title">
          <div className="eyebrow">{eyebrow}</div>
          <h1 id="auth-page-title">{title}</h1>
          <p className="auth-description">{description}</p>
          {children}
        </section>
        {footer ? <div className="auth-footer">{footer}</div> : null}
      </div>
    </main>
  );
}
