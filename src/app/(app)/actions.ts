"use server";

import { redirect } from "next/navigation";
import { destroySession, requireUser } from "@/lib/auth/session";
import { setDisplayName } from "@/modules/identity/wallet";

export async function signOutAction(): Promise<void> {
  await destroySession();
  redirect("/sign-in");
}

export type WelcomeState = { error?: string };

/** The first thing a new member does: say what the group should call them. */
export async function setNameAction(_prev: WelcomeState, formData: FormData): Promise<WelcomeState> {
  const user = await requireUser();
  const result = await setDisplayName(user.id, String(formData.get("name") ?? ""));
  if (!result.ok) {
    return {
      error: result.reason === "empty" ? "Tell us what to call you." : "Keep it under 40 characters.",
    };
  }
  redirect("/");
}
