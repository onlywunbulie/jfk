type ClassValue = string | number | null | undefined | false | ClassValue[];

/**
 * Join class names, dropping falsy values.
 *
 * Deliberately not `tailwind-merge`: nothing here yet needs conflict
 * resolution, and the components below control their own class order. Add it
 * when a real override case appears, not before.
 */
export function cn(...values: ClassValue[]): string {
  const out: string[] = [];
  for (const value of values) {
    if (!value && value !== 0) continue;
    out.push(Array.isArray(value) ? cn(...value) : String(value));
  }
  return out.join(" ");
}
