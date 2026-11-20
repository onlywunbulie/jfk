"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { GroupIcon, WalletIcon } from "@/components/ui/iconoir";
import { cn } from "@/lib/cn";
import { MAX_ZOOM, MIN_ZOOM, clampOffset, cropArea, placement, type Point, type Size } from "@/lib/crop";
import { ACCEPTED_TYPES, checkPicked, cropToWebp, type ImageKind } from "@/lib/shrink-image";
import { removeGroupImageAction, uploadGroupImageAction } from "@/app/(app)/groups/image-actions";
import type { ShellGroup } from "./app-shell";

/**
 * The group profile: its picture (the rail) and banner (the top of the
 * sidebar), for owners and admins. Laid out the way Discord's server profile
 * is: the controls on the left, a live preview of exactly what members see on
 * the right. Picking an image opens a crop step; nothing goes live until
 * "Save changes" in the bar at the bottom.
 */

/** What's waiting to be saved for one image: a new crop, or taking it away. */
type Pending = { blob: Blob; url: string } | "remove";

const COPY: Record<ImageKind, { title: string; where: string; noun: string }> = {
  avatar: { title: "Picture", where: "Square. Shows beside the group in the left rail.", noun: "picture" },
  banner: { title: "Banner", where: "Wide. Shows across the top of the group’s sidebar.", noun: "banner" },
};

export function GroupProfile({
  group,
  attention,
  onDirtyChange,
}: {
  group: ShellGroup;
  /** Goes up each time the user tries to close with unsaved changes: the bar shakes. */
  attention: number;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<Partial<Record<ImageKind, Pending>>>({});
  const [cropping, setCropping] = useState<{ kind: ImageKind; url: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const inputs = { avatar: useRef<HTMLInputElement>(null), banner: useRef<HTMLInputElement>(null) };
  const dirty = Object.keys(pending).length > 0;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  // Object URLs hold the picked images in memory until let go.
  const urls = useRef(new Set<string>());
  useEffect(() => {
    const held = urls.current;
    return () => held.forEach((url) => URL.revokeObjectURL(url));
  }, []);
  const hold = (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    urls.current.add(url);
    return url;
  };

  /** What each image looks like right now, counting unsaved changes. */
  const shown = (kind: ImageKind): string | null => {
    const change = pending[kind];
    if (change === "remove") return null;
    if (change) return change.url;
    return kind === "avatar" ? group.avatarUrl : group.bannerUrl;
  };

  function pick(kind: ImageKind, file: File | undefined) {
    const input = inputs[kind].current;
    if (input) input.value = "";
    if (!file) return;
    const problem = checkPicked(file);
    setError(problem);
    setSaved(false);
    if (!problem) setCropping({ kind, url: hold(file) });
  }

  function remove(kind: ImageKind) {
    setSaved(false);
    setPending((now) => {
      const next = { ...now };
      const saved = kind === "avatar" ? group.avatarUrl : group.bannerUrl;
      // Taking away an unsaved crop just forgets it; taking away a saved image is a change.
      if (saved) next[kind] = "remove";
      else delete next[kind];
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      for (const kind of ["avatar", "banner"] as const) {
        const change = pending[kind];
        if (!change) continue;
        let result;
        if (change === "remove") {
          result = await removeGroupImageAction(group.id, kind);
        } else {
          const form = new FormData();
          form.set("image", change.blob, `${kind}.webp`);
          result = await uploadGroupImageAction(group.id, kind, form);
        }
        if (!result.ok) {
          setError(result.error);
          return;
        }
        // Saved: this one is no longer waiting, whatever happens to the next.
        setPending((now) => {
          const next = { ...now };
          delete next[kind];
          return next;
        });
      }
      setSaved(true);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  if (cropping) {
    return (
      <Cropper
        kind={cropping.kind}
        url={cropping.url}
        onCancel={() => setCropping(null)}
        onApply={(blob) => {
          setPending((now) => ({ ...now, [cropping.kind]: { blob, url: hold(blob) } }));
          setCropping(null);
        }}
      />
    );
  }

  return (
    <div>
      <h2 id="group-profile-title" className="pr-12 text-xl font-semibold text-ink">
        Group profile
      </h2>
      <p className="mt-1 text-sm text-ink-muted">How {group.name} looks to everyone in it.</p>

      <div className="mt-8 grid gap-8 sm:grid-cols-[minmax(0,1fr)_auto]">
        {/* The preview leads on a phone, so the change is seen first. */}
        <div className="sm:order-2">
          <p className="mb-3 text-sm font-medium text-ink-muted">Preview</p>
          <Preview group={group} avatarUrl={shown("avatar")} bannerUrl={shown("banner")} />
        </div>

        <div className="flex flex-col gap-8 sm:order-1">
          {(["avatar", "banner"] as const).map((kind) => (
            <section key={kind}>
              <h3 className="font-semibold text-ink">{COPY[kind].title}</h3>
              <p className="mt-1 text-sm text-ink-muted">{COPY[kind].where}</p>
              <input
                ref={inputs[kind]}
                type="file"
                accept={ACCEPTED_TYPES.join(",")}
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(event) => pick(kind, event.target.files?.[0])}
              />
              <div className="mt-4 flex flex-wrap gap-2">
                <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={() => inputs[kind].current?.click()}>
                  {shown(kind) ? `Change ${COPY[kind].noun}` : `Add a ${COPY[kind].noun}`}
                </Button>
                {shown(kind) && (
                  <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => remove(kind)}>
                    Remove
                  </Button>
                )}
              </div>
            </section>
          ))}
          <p className="text-xs text-ink-faint">PNG, JPG or WebP, up to 10 MB.</p>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-6 rounded-[var(--radius-control)] bg-danger-soft px-4 py-3 text-sm text-danger">
          {error}
        </p>
      )}
      {saved && !dirty && (
        <p role="status" className="mt-6 text-sm text-inflow">
          Saved. Everyone in the group sees the new look.
        </p>
      )}

      {/* The save bar: changes wait here until saved, as in Discord. */}
      {dirty && (
        <div
          // A new key each time someone tries to leave remounts the bar, which replays its shake.
          key={attention}
          role="region"
          aria-label="Unsaved changes"
          className={cn(
            "sticky bottom-0 mt-8 -mb-2 flex items-center gap-2 rounded-[var(--radius-control)] border border-border bg-raised p-2 pl-4 shadow-lg",
            attention > 0 ? "nudge-shake border-danger/50" : "animate-arrive",
          )}
        >
          <p className="min-w-0 flex-1 truncate text-sm text-ink">Unsaved changes</p>
          <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => setPending({})}>
            Reset
          </Button>
          <Button type="button" size="sm" loading={saving} onClick={() => void save()}>
            Save changes
          </Button>
        </div>
      )}
    </div>
  );
}

/** Exactly what members see: the rail square, and the top of the sidebar card. */
function Preview({ group, avatarUrl, bannerUrl }: { group: ShellGroup; avatarUrl: string | null; bannerUrl: string | null }) {
  const letter = Array.from(group.name.trim())[0]?.toUpperCase() ?? "?";
  return (
    <div aria-hidden="true" className="flex items-start gap-3 rounded-[var(--radius-card)] bg-canvas p-3">
      <div className="relative grid h-[41px] w-[var(--rail-width)] shrink-0 place-items-center overflow-hidden rounded-[var(--radius-control)] border-2 border-accent bg-raised text-ink-muted">
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- a local preview or a Blob upload
          <img src={avatarUrl} alt="" className="absolute inset-0 size-full rounded-[8px] object-cover" />
        ) : (
          <span className="text-base font-semibold">{letter}</span>
        )}
      </div>
      <div className="w-[min(16.5rem,calc(100vw-8rem))] overflow-hidden rounded-[var(--radius-control)] bg-surface">
        {bannerUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- a local preview or a Blob upload
          <img src={bannerUrl} alt="" className="aspect-[322/112] w-full object-cover" />
        ) : (
          <div className="empty-banner aspect-[322/112] w-full bg-raised" />
        )}
        <ul className="flex flex-col gap-3 p-4 text-sm text-ink">
          <li className="flex items-center gap-2">
            <WalletIcon className="size-4 text-ink-muted" />
            Balance: {group.balance}
          </li>
          <li className="flex items-center gap-2">
            <GroupIcon className="size-4 text-ink-muted" />
            Members: {group.memberCount}
          </li>
        </ul>
      </div>
    </div>
  );
}

/**
 * Position the image: drag it inside the frame, zoom with the slider. The
 * frame has the real shape (square, or the sidebar banner's), and the part
 * outside it shows dimmed, so it's clear what will be kept.
 */
function Cropper({
  kind,
  url,
  onCancel,
  onApply,
}: {
  kind: ImageKind;
  url: string;
  onCancel: () => void;
  onApply: (blob: Blob) => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [image, setImage] = useState<Size | null>(null);
  const [frame, setFrame] = useState<Size | null>(null);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ start: Point; from: Point } | null>(null);

  // The frame's real size on screen, kept up to date if the window changes.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = () => setFrame({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const safe = image && frame ? clampOffset(image, frame, zoom, offset) : offset;
  const at = image && frame ? placement(image, frame, zoom, safe) : null;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { start: { x: event.clientX, y: event.clientY }, from: safe };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setOffset({
      x: drag.current.from.x + event.clientX - drag.current.start.x,
      y: drag.current.from.y + event.clientY - drag.current.start.y,
    });
  };
  const endDrag = () => {
    drag.current = null;
    if (image && frame) setOffset(clampOffset(image, frame, zoom, offset));
  };

  async function apply() {
    if (!image || !frame || !imageRef.current) return;
    setBusy(true);
    try {
      const result = await cropToWebp(imageRef.current, kind, cropArea(image, frame, zoom, safe));
      if (!result.ok) return setError(result.error);
      onApply(result.blob);
    } finally {
      setBusy(false);
    }
  }

  const style = at ? { left: at.x, top: at.y, width: at.width, height: at.height } : { opacity: 0 };

  return (
    <div>
      <h2 id="group-profile-title" className="pr-12 text-xl font-semibold text-ink">
        Position the {COPY[kind].noun}
      </h2>
      <p className="mt-1 text-sm text-ink-muted">Drag to move it, and use the slider to zoom.</p>

      {/* The stage: the dimmed image around the frame, the frame on top. */}
      <div className="relative mt-6 grid place-items-center overflow-hidden rounded-[var(--radius-card)] bg-canvas px-6 py-8">
        <div
          ref={frameRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className={cn(
            "relative cursor-grab touch-none select-none active:cursor-grabbing",
            kind === "avatar" ? "size-56" : "aspect-[322/112] w-full max-w-[40rem]",
          )}
        >
          {/* Outside the frame, dimmed. */}
          {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL being cropped */}
          <img src={url} alt="" aria-hidden="true" draggable={false} className="pointer-events-none absolute max-w-none opacity-30" style={style} />
          {/* Inside the frame: what will be kept. */}
          <div className="absolute inset-0 overflow-hidden rounded-[var(--radius-control)] ring-2 ring-accent">
            {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL being cropped */}
            <img
              ref={imageRef}
              src={url}
              alt={`The new ${COPY[kind].noun}`}
              draggable={false}
              onLoad={(event) => setImage({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
              onError={() => setError("That file couldn’t be opened as an image.")}
              className="pointer-events-none absolute max-w-none"
              style={style}
            />
          </div>
        </div>
      </div>

      <label className="mt-6 flex items-center gap-4 text-sm text-ink-muted">
        Zoom
        <input
          type="range"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={0.01}
          value={zoom}
          onChange={(event) => setZoom(Number(event.target.value))}
          className="h-1 flex-1 cursor-pointer accent-[var(--color-accent)]"
        />
      </label>

      {error && (
        <p role="alert" className="mt-4 rounded-[var(--radius-control)] bg-danger-soft px-4 py-3 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="mt-8 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" loading={busy} disabled={!image} onClick={() => void apply()}>
          Apply
        </Button>
      </div>
    </div>
  );
}
