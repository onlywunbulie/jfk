import type { ButtonHTMLAttributes, ReactNode } from "react";
import Link from "next/link";
import type { LinkProps } from "next/link";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

/**
 * Orange is the action colour, and the brand.
 *
 * One clear first choice per screen: the orange button. Everything else is a
 * quieter grey. A disabled button looks clearly off: grey, not faded orange.
 */
const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-accent text-accent-ink hover:bg-accent-hover disabled:bg-overlay disabled:text-ink-faint",
  secondary:
    "bg-raised text-ink border border-border hover:bg-overlay disabled:text-ink-faint",
  ghost: "text-ink-muted hover:text-ink hover:bg-raised",
  danger: "bg-danger-soft text-danger border border-danger/30 hover:bg-danger/20",
};

// Rounded rectangles on the 10px control radius, never capsules.
const SIZES: Record<Size, string> = {
  sm: "h-9 px-3.5 text-sm rounded-[var(--radius-control)]",
  md: "h-11 px-5 text-base rounded-[var(--radius-control)]",
  lg: "h-14 px-6 text-base rounded-[var(--radius-control)]",
};

/**
 * Shared appearance, so a button and a link that look identical never drift.
 * Preferred over an `asChild` slot: no runtime cloning, and a link stays a
 * real anchor for middle-click, keyboard and screen readers.
 */
export function buttonClasses({
  variant = "primary",
  size = "md",
  fullWidth = false,
  className,
}: {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
  className?: string;
} = {}): string {
  return cn(
    "inline-flex items-center justify-center gap-2 font-medium whitespace-nowrap",
    "transition-[background-color,border-color,transform] duration-150",
    "active:scale-[0.98] disabled:cursor-not-allowed disabled:active:scale-100",
    VARIANTS[variant],
    SIZES[size],
    fullWidth && "w-full",
    className,
  );
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  fullWidth?: boolean;
  children: ReactNode;
}

export function Button({
  variant,
  size,
  loading = false,
  fullWidth,
  className,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses({ variant, size, fullWidth, className })}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

type ButtonLinkProps = LinkProps & {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
  className?: string;
  children: ReactNode;
};

export function ButtonLink({
  variant,
  size,
  fullWidth,
  className,
  children,
  ...props
}: ButtonLinkProps) {
  return (
    <Link {...props} className={buttonClasses({ variant, size, fullWidth, className })}>
      {children}
    </Link>
  );
}

function Spinner() {
  return (
    <svg
      className="size-4 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="2.5"
        className="opacity-25"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
