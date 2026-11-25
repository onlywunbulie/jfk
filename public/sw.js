/*
 * Rallied's service worker. It only shows alerts and opens the right screen
 * when one is tapped; it caches nothing, so the app is always the live one.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Rallied", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Rallied", {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      tag: data.tag,
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Only ever a path in Rallied, never another site.
  const url = event.notification.data?.url;
  const path = typeof url === "string" && url.startsWith("/") && !url.startsWith("//") ? url : "/";
  const target = new URL(path, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of open) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          await client.navigate(target).catch(() => undefined);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })(),
  );
});
