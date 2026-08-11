/**
 * Sign-in form state.
 *
 * Kept out of `actions.ts` because a `"use server"` module may only export
 * async functions — exporting this object from there makes every action in the
 * file fail at invocation time, while the page still renders fine.
 */
export type SignInState = {
  step: "email" | "code";
  email: string;
  error: string | null;
  /** Only ever set in development with no email provider configured. */
  devCode?: string;
};

export const initialSignInState: SignInState = {
  step: "email",
  email: "",
  error: null,
};
