"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ACCEPTED_TYPES, shrinkImage, type ImageKind } from "@/lib/shrink-image";
import { removeGroupImageAction, uploadGroupImageAction } from "@/app/(app)/groups/image-actions";

/**
 * The group's picture (the rail) and banner (the sidebar), for its owner and
 * admins. A preview of both, as members will see them, with a button each to
 * pick a new one and a way back to the fallback.
 *
 * The photo is cropped and shrunk in the browser first, so a large phone
 * photo uploads in a moment.
 */
export function GroupLook({
  groupId,
  groupName,
  avatarUrl,
  bannerUrl,
}: {
  groupId: string;
  groupName: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<ImageKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const inputs = { avatar: useRef<HTMLInputElement>(null), banner: useRef<HTMLInputElement>(null) };
  const letter = Array.from(groupName.trim())[0]?.toUpperCase() ?? "?";

  async function pick(kind: ImageKind, file: File | undefined) {
    if (!file) return;
    setError(null);
    setBusy(kind);
    try {
      const shrunk = await shrinkImage(file, kind);
      if (!shrunk.ok) return setError(shrunk.error);
      const form = new FormData();
      form.set("image", shrunk.blob, `${kind}.webp`);
      const result = await uploadGroupImageAction(groupId, kind, form);
      if (!result.ok) return setError(result.error);
      startTransition(() => router.refresh());
    } finally {
      setBusy(null);
      const input = inputs[kind].current;
      if (input) input.value = "";
    }
  }

  async function remove(kind: ImageKind) {
    setError(null);
    setBusy(kind);
    try {
      const result = await removeGroupImageAction(groupId, kind);
      if (!result.ok) return setError(result.error);
      startTransition(() => router.refresh());
    } finally {
      setBusy(null);
    }
  }

  return (
    <div id="picture" className="scroll-mt-6 rounded-[var(--radius-card)] border border-border bg-surface p-4">
      <p className="font-semibold text-ink">Picture and banner</p>
      <p className="mt-1 text-sm text-ink-muted">
        {avatarUrl || bannerUrl
          ? "Everyone in the group sees these. PNG, JPG or WebP."
          : "Add a picture and banner so friends know the group at a glance. PNG, JPG or WebP."}
      </p>

      {/* The preview: the banner as the sidebar crops it, the picture as the rail does. */}
      <div className="relative mt-4 mb-8">
        {bannerUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- a user upload on Blob, already resized
          <img src={bannerUrl} alt="The group's banner" className="aspect-[3/1] w-full rounded-[var(--radius-control)] object-cover" />
        ) : (
          <div aria-label="No banner yet" role="img" className="aspect-[3/1] w-full rounded-[var(--radius-control)] bg-raised empty-banner" />
        )}
        <div className="absolute -bottom-6 left-4 grid size-14 place-items-center overflow-hidden rounded-[var(--radius-control)] border-4 border-surface bg-raised">
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a user upload on Blob, already resized
            <img src={avatarUrl} alt="The group's picture" className="size-full object-cover" />
          ) : (
            <span className="text-lg font-semibold text-ink-muted" aria-label="No picture yet">
              {letter}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {(["avatar", "banner"] as const).map((kind) => {
          const current = kind === "avatar" ? avatarUrl : bannerUrl;
          const noun = kind === "avatar" ? "picture" : "banner";
          return (
            <div key={kind} className="flex items-center gap-1">
              <input
                ref={inputs[kind]}
                type="file"
                accept={ACCEPTED_TYPES.join(",")}
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(event) => void pick(kind, event.target.files?.[0])}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={busy === kind}
                disabled={busy !== null && busy !== kind}
                onClick={() => inputs[kind].current?.click()}
              >
                {current ? `Change ${noun}` : `Add a ${noun}`}
              </Button>
              {current && (
                <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => void remove(kind)}>
                  Remove
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {error && (
        <p role="alert" className="mt-3 rounded-[var(--radius-control)] bg-danger-soft px-4 py-3 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
