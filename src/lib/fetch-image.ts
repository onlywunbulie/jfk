import "server-only";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";

/**
 * Fetch an image someone gave Rallied a link to (Claude passing on a group
 * picture), without letting that link reach anything private.
 *
 * - https only, on the standard port.
 * - Every address the name resolves to is checked at the moment of
 *   connecting (the `lookup` hook), so a name can't resolve to a public
 *   address when checked and a private one when used.
 * - Private, loopback, link-local (cloud metadata), carrier-grade NAT,
 *   multicast and reserved ranges are refused, for IPv4 and IPv6.
 * - At most 3 redirects, each one checked the same way.
 * - At most 10 MB, 10 seconds, and only PNG, JPEG or WebP as declared.
 *
 * What comes back is still untrusted bytes: the caller re-encodes it
 * (lib/process-image.ts) before anything is stored.
 */

export const MAX_FETCHED_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const ACCEPTED = new Set(["image/png", "image/jpeg", "image/webp"]);

export type FetchedImage = { ok: true; bytes: Buffer; type: string } | { ok: false; reason: string };

/** True for an address the open internet can't reach, or shouldn't be reached through Rallied. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return privateV4(address);
  if (family === 6) {
    const lower = address.toLowerCase();
    // IPv4 written as IPv6 (::ffff:10.0.0.1): judge the IPv4 inside.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return privateV4(mapped[1]);
    return (
      lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") || // unique local
      /^fe[89ab]/.test(lower) || // link-local
      lower.startsWith("ff") || // multicast
      lower.startsWith("64:ff9b:") || // NAT64, can reach IPv4 private ranges
      lower.startsWith("2001:db8") // documentation
    );
  }
  return true; // not an IP at all: refuse
}

function privateV4(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

/** A DNS lookup that refuses to hand back any private address. */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "", 4);
    const list = (Array.isArray(addresses) ? addresses : [addresses]) as LookupAddress[];
    if (list.length === 0 || list.some((entry) => isPrivateAddress(entry.address))) {
      return callback(new Error("private address"), "", 4);
    }
    if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

export async function fetchPublicImage(link: string): Promise<FetchedImage> {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return { ok: false, reason: "That isn't a web address." };
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password) {
      return { ok: false, reason: "Only a plain https:// link to an image works." };
    }
    // A bare IP in the link gets the same check as a resolved name.
    if (isIP(url.hostname.replace(/^\[|\]$/g, "")) && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ""))) {
      return { ok: false, reason: "That link points somewhere Rallied won't fetch from." };
    }
    const result = await getOnce(url);
    if (result.kind === "redirect") {
      try {
        url = new URL(result.location, url);
      } catch {
        return { ok: false, reason: "That link redirects somewhere that isn't a web address." };
      }
      continue;
    }
    return result.value;
  }
  return { ok: false, reason: "That link redirects too many times." };
}

type Once = { kind: "redirect"; location: string } | { kind: "done"; value: FetchedImage };

function getOnce(url: URL): Promise<Once> {
  return new Promise((resolve) => {
    const done = (value: FetchedImage) => resolve({ kind: "done", value });
    const req = request(
      url,
      { method: "GET", lookup: guardedLookup, timeout: TIMEOUT_MS, headers: { accept: "image/png,image/jpeg,image/webp", "user-agent": "Rallied" } },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ kind: "redirect", location: res.headers.location });
        }
        if (status !== 200) {
          res.resume();
          return done({ ok: false, reason: `That link didn't return an image (status ${status}).` });
        }
        const type = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        if (!ACCEPTED.has(type)) {
          res.resume();
          return done({ ok: false, reason: "That link isn't a PNG, JPG or WebP image." });
        }
        const declared = Number(res.headers["content-length"] ?? 0);
        if (declared > MAX_FETCHED_BYTES) {
          res.resume();
          return done({ ok: false, reason: "That image is over 10 MB." });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_FETCHED_BYTES) {
            req.destroy();
            done({ ok: false, reason: "That image is over 10 MB." });
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => done({ ok: true, bytes: Buffer.concat(chunks), type }));
        res.on("error", () => done({ ok: false, reason: "Couldn't download that image." }));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      done({ ok: false, reason: "That image took too long to download." });
    });
    req.on("error", (error) =>
      done({
        ok: false,
        reason: error.message === "private address" ? "That link points somewhere Rallied won't fetch from." : "Couldn't download that image.",
      }),
    );
    req.end();
  });
}
