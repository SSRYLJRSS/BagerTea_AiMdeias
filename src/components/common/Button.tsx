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
        "px-3 py-1.5 rounded-md text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
        variant === "primary" && "bg-[var(--color-accent)] text-[var(--color-accent-text)] hover:bg-[var(--color-accent-hover)]",
        variant === "ghost" && "text-[var(--color-text)] hover:bg-[var(--color-surface)]",
        variant === "danger" && "text-white bg-[var(--color-danger)] hover:opacity-90",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
