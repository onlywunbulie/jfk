import "server-only";
import webpush from "web-push";
import { env } from "@/lib/env";

/**
 * Sending one alert to one device through its browser's push service (Web
 * Push, signed with Rallied's VAPID key). The push service only relays it;
 * the message is encrypted for that device.
 *
 * Returns "gone" when the device has unsubscribed or the browser dropped it,
 * so the caller forgets it.
 */

export interface Device {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushMessage {
  title: string;
  body: string;
  url: string;
  /** Same tag replaces an earlier alert on the device instead of stacking. */
  tag: string;
}

export type PushOutcome = "sent" | "gone" | "failed" | "not_set_up";

export function pushConfigured(): boolean {
  const { NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = env();
  return Boolean(NEXT_PUBLIC_VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
}

export async function sendPush(device: Device, message: PushMessage): Promise<PushOutcome> {
  const { NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, APP_URL } = env();
  if (!NEXT_PUBLIC_VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return "not_set_up";
  // Push services want an https: contact; locally there isn't one, so the live site's stands in.
  const subject = APP_URL.startsWith("https://") ? APP_URL : "https://getrallied.vercel.app";

  try {
    await webpush.sendNotification(
      { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
      JSON.stringify(message),
      {
        vapidDetails: { subject, publicKey: NEXT_PUBLIC_VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY },
        // A day: an alert about today's vote is no use next week.
        TTL: 24 * 60 * 60,
        timeout: 10_000,
      },
    );
    return "sent";
  } catch (cause) {
    const status = (cause as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) return "gone";
    console.error("[push] couldn't send", status ?? cause);
    return "failed";
  }
}
