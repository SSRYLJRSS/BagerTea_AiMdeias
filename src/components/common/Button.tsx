import clsx from "clsx";
import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "ghost" | "danger";
  children: ReactNode;
}

export default function Button({ variant = "ghost", className, children, ...rest }: ButtonProps) {
  return (
    <button
      className={clsx(
        "inline-flex min-h-9 items-center justify-center rounded-[var(--radius-control)] px-3.5 py-2 text-sm font-medium transition-[background-color,color,border-color,opacity] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-status)] disabled:cursor-not-allowed disabled:opacity-40",
        variant === "primary" && "bg-[var(--color-accent)] text-[var(--color-accent-text)] hover:bg-[var(--color-accent-hover)]",
        variant === "ghost" && "border border-transparent text-[var(--color-text)] hover:border-[var(--color-border)] hover:bg-[var(--color-surface)]",
        variant === "danger" && "border border-[var(--color-danger)] text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-white",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
