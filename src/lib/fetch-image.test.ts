import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { fetchPublicImage, isPrivateAddress } = await import("@/lib/fetch-image");

describe("which addresses Rallied will fetch from", () => {
  it("refuses private, loopback, link-local and reserved IPv4", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.5.4", "172.31.255.255", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("refuses the same ranges in IPv6, including IPv4 written as IPv6", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "64:ff9b::a00:1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe("fetching a linked image", () => {
  it("refuses anything but a plain https link", async () => {
    expect(await fetchPublicImage("http://example.com/a.png")).toMatchObject({ ok: false, reason: expect.stringContaining("https://") });
    expect(await fetchPublicImage("https://user:pw@example.com/a.png")).toMatchObject({ ok: false });
    expect(await fetchPublicImage("https://example.com:8443/a.png")).toMatchObject({ ok: false });
    expect(await fetchPublicImage("not a link")).toMatchObject({ ok: false, reason: "That isn't a web address." });
  });

  it("refuses a private address, written out or behind a name", async () => {
    expect(await fetchPublicImage("https://169.254.169.254/latest/meta-data")).toMatchObject({
      ok: false,
      reason: "That link points somewhere Rallied won't fetch from.",
    });
    // localhost resolves to 127.0.0.1: refused at the moment of connecting.
    expect(await fetchPublicImage("https://localhost/a.png")).toMatchObject({
      ok: false,
      reason: "That link points somewhere Rallied won't fetch from.",
    });
  });
});
