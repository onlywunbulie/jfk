import "server-only";
import { env, isEmailDisabled } from "./env";

type DeliveryResult = { delivered: boolean };

/**
 * Email delivery.
 *
 * Resend is wired in behind a flag: with no API key set, codes are printed to
 * the dev server terminal instead. That keeps local sign-in working with zero
 * third-party setup, and there is exactly one code path either way.
 */
export async function sendLoginCodeEmail(
  to: string,
  code: string,
): Promise<DeliveryResult> {
  if (isEmailDisabled()) {
    console.info(
      `\n  ┌─ JFK sign-in code ─────────────────\n` +
        `  │  ${to}\n` +
        `  │  ${code}\n` +
        `  └────────────────────────────────────\n`,
    );
    return { delivered: false };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env().RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env().EMAIL_FROM,
      to,
      subject: `${code} is your JFK sign-in code`,
      text:
        `Your JFK sign-in code is ${code}.\n\n` +
        `It expires in 10 minutes. If you didn't ask for it, ignore this email — ` +
        `nobody can sign in without it.`,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    // Surface loudly: a silent email failure locks everyone out of the app.
    throw new Error(`Resend rejected the email (${response.status}): ${body}`);
  }

  return { delivered: true };
}
