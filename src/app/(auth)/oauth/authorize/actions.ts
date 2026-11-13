"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { createAuthorizationCode } from "@/modules/agents/oauth";
import { backTo, checkAuthorizeRequest } from "./checks";

/**
 * The user's decision on the approval screen. Everything is checked again
 * here (the form is just hidden fields), then the app is sent back with a
 * one-time code, or with "access_denied".
 */
export async function decideAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const fields = Object.fromEntries(
    ["client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "response_type"].map((key) => [
      key,
      typeof formData.get(key) === "string" ? (formData.get(key) as string) : undefined,
    ]),
  );
  const check = await checkAuthorizeRequest(fields);
  if (!check.ok) {
    if ("sendBack" in check) redirect(check.sendBack.toString());
    redirect("/");
  }

  const { request } = check;
  if (formData.get("decision") !== "allow") {
    redirect(backTo(request.redirectUri, { error: "access_denied", state: request.state }));
  }

  const code = await createAuthorizationCode({
    clientId: request.clientId,
    userId: user.id,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    scope: request.scope,
  });
  redirect(backTo(request.redirectUri, { code, state: request.state }));
}
