"use server";

import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { rateLimit } from "@/lib/rate-limit";
import { forgetDevice, markAllRead, saveDevice } from "@/modules/notifications/service";

/** Turning alerts on and off for this device, and clearing the bell once it has been opened. */

const device = z.object({
  endpoint: z.url().max(2048).refine((url) => url.startsWith("https://"), "push endpoints are https"),
  keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(256) }),
});

export async function saveDeviceAction(subscription: unknown): Promise<{ ok: boolean }> {
  const user = await requireUser();
  const parsed = device.safeParse(subscription);
  if (!parsed.success) return { ok: false };
  const limited = await rateLimit(`push-device:${user.id}`, 20, 60 * 60);
  if (!limited.ok) return { ok: false };
  await saveDevice(user.id, { endpoint: parsed.data.endpoint, ...parsed.data.keys });
  return { ok: true };
}

export async function forgetDeviceAction(endpoint: string): Promise<void> {
  const user = await requireUser();
  if (typeof endpoint !== "string" || endpoint.length > 2048) return;
  await forgetDevice(user.id, endpoint);
}

export async function markNotificationsReadAction(): Promise<void> {
  const user = await requireUser();
  await markAllRead(user.id);
}
