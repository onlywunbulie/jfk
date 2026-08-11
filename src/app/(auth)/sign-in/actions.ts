"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requestLoginCode, verifyLoginCode } from "@/modules/identity/service";
import { createSession } from "@/lib/auth/session";
import type { SignInState } from "./state";

const emailSchema = z.email("That doesn't look like an email address");
const codeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Enter the 6-digit code");

async function clientIp(): Promise<string | null> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  // Only the left-most entry is the client; the rest are proxies.
  const ip = forwarded?.split(",")[0]?.trim() || h.get("x-real-ip");
  // `inet` rejects junk, and a spoofed header shouldn't break sign-in.
  return ip && /^[0-9a-fA-F.:]+$/.test(ip) ? ip : null;
}

export async function requestCodeAction(
  _prev: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const parsed = emailSchema.safeParse(formData.get("email"));
  if (!parsed.success) {
    return {
      step: "email",
      email: String(formData.get("email") ?? ""),
      error: parsed.error.issues[0].message,
    };
  }

  const result = await requestLoginCode(parsed.data, { ip: await clientIp() });

  if (!result.ok) {
    return {
      step: "email",
      email: parsed.data,
      error: `Too many codes requested. Try again in ${result.retryAfterMinutes} minute${
        result.retryAfterMinutes === 1 ? "" : "s"
      }.`,
    };
  }

  return {
    step: "code",
    email: parsed.data,
    error: null,
    devCode: result.devCode,
  };
}

export async function verifyCodeAction(
  prev: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const parsed = codeSchema.safeParse(formData.get("code"));
  if (!parsed.success) {
    return { ...prev, step: "code", error: parsed.error.issues[0].message };
  }

  const result = await verifyLoginCode(prev.email, parsed.data);

  if (!result.ok) {
    const message = {
      invalid: "That code isn't right. Check it and try again.",
      expired: "That code has expired. Request a new one.",
      too_many_attempts: "Too many attempts. Request a new code.",
    }[result.reason];

    return {
      ...prev,
      step: result.reason === "invalid" ? "code" : "email",
      error: message,
      devCode: undefined,
    };
  }

  const h = await headers();
  await createSession(result.userId, {
    ip: await clientIp(),
    userAgent: h.get("user-agent"),
  });

  // redirect() throws to unwind — must be outside any try/catch.
  redirect("/");
}
