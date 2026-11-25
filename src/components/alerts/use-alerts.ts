"use client";

import { useCallback, useEffect, useState } from "react";
import { forgetDeviceAction, saveDeviceAction } from "@/app/(app)/notify-actions";

/**
 * Alerts on this device (Web Push), as one state the screens can show:
 *
 *  - loading:      still finding out
 *  - unavailable:  this browser can't, or Rallied's keys aren't set up
 *  - install:      an iPhone or iPad in Safari: alerts need Rallied on the home screen first
 *  - blocked:      the member said no in the browser; only the browser's settings undo it
 *  - off / on
 */
export type AlertsState = "loading" | "unavailable" | "install" | "blocked" | "off" | "on";

const PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

export function useAlerts() {
  const [state, setState] = useState<AlertsState>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = await currentState();
      if (!cancelled) setState(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const turnOn = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "blocked" : "off");
        return;
      }
      const registration = await register();
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(PUBLIC_KEY) }));
      const saved = await saveDeviceAction(subscription.toJSON());
      if (!saved.ok) {
        setError("Couldn't turn alerts on. Try again in a minute.");
        return;
      }
      setState("on");
    } catch (cause) {
      console.error("Turning alerts on failed", cause);
      setError("Couldn't turn alerts on in this browser.");
    } finally {
      setBusy(false);
    }
  }, []);

  const turnOff = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await forgetDeviceAction(subscription.endpoint);
        await subscription.unsubscribe();
      }
      setState("off");
    } catch (cause) {
      console.error("Turning alerts off failed", cause);
      setError("Couldn't turn alerts off. Try again.");
    } finally {
      setBusy(false);
    }
  }, []);

  return { state, busy, error, turnOn, turnOff };
}

async function currentState(): Promise<AlertsState> {
  if (typeof window === "undefined") return "loading";
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!supported) return isAppleMobile() && !isStandalone() ? "install" : "unavailable";
  if (!PUBLIC_KEY) return "unavailable";
  if (Notification.permission === "denied") return "blocked";
  try {
    const registration = await register();
    const subscription = await registration.pushManager.getSubscription();
    if (subscription && Notification.permission === "granted") {
      // Keep the server's copy current: browsers sometimes renew the address.
      void saveDeviceAction(subscription.toJSON());
      return "on";
    }
    return "off";
  } catch {
    return "unavailable";
  }
}

function register(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
}

function isAppleMobile(): boolean {
  // iPadOS reports itself as a Mac; touch gives it away.
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = (value + "=".repeat((4 - (value.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
