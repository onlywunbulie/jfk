import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/session";
import { getGroupDetail } from "@/modules/groups/service";
import { findChannel } from "@/components/shell/channels";

export async function generateMetadata({
  params,
}: PageProps<"/groups/[groupId]/[channel]">): Promise<Metadata> {
  const { channel } = await params;
  return { title: findChannel(channel)?.label ?? "Group" };
}

/**
 * Every channel's screen, for this UI-only step: what the channel will show,
 * and that it's coming. Members only; anyone else sees a 404, the same as a
 * group that doesn't exist.
 */
export default async function ChannelPage({ params }: PageProps<"/groups/[groupId]/[channel]">) {
  const { groupId, channel: slug } = await params;
  const channel = findChannel(slug);
  if (!channel) notFound();

  const user = await requireUser();
  const group = await getGroupDetail(groupId, user.id);
  if (!group) notFound();

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col items-center justify-center py-12 text-center">
      <span
        aria-hidden="true"
        className="grid size-20 place-items-center rounded-[var(--radius-big)] border border-border bg-raised text-accent [&_svg]:size-9"
      >
        {channel.icon}
      </span>
      <h2 className="mt-6 text-xl font-semibold text-ink">{channel.label}</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-muted">{channel.promise}</p>
      <p className="mt-6 rounded-[var(--radius-control)] border border-border px-3 py-1.5 text-xs text-ink-faint">
        Coming in a later step
      </p>
    </div>
  );
}
