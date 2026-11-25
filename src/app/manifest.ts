import type { MetadataRoute } from "next";

/**
 * Lets Rallied be added to a phone's home screen. On iPhone that's also what
 * makes alerts possible: Safari only lets a site send them once it's been
 * added to the home screen and opened from there.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Rallied",
    short_name: "Rallied",
    description: "Contribute, decide and build together.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#18181b",
    theme_color: "#18181b",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
