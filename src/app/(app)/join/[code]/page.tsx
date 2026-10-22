import Link from "next/link";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/session";
import { previewInvite } from "@/modules/groups/service";
import { Card } from "@/components/ui/card";
import { Button, ButtonLink } from "@/components/ui/button";
import { acceptInviteAction } from "../../groups/actions";

export const metadata: Metadata = { title: "Join a group" };

const ERROR_MESSAGES: Record<string, string> = {
  not_found: "That invite link isn't valid.",
  expired: "That invite has expired. Ask for a new one.",
  exhausted: "That invite has already been used.",
  revoked: "That invite was cancelled.",
  wrong_email: "That invite was addressed to a different email.",
  removed: "You're no longer able to join this group.",
  started_on_chain:
    "This group has already started on-chain, so new members are voted in. Ask a member to propose adding you.",
};

export default async function JoinPage({
  params,
  searchParams,
}: PageProps<"/join/[code]">) {
  const { code } = await params;
  const { error } = await searchParams;

  // Signing in first means we know who is accepting, and the invite preview
  // never leaks group details to an anonymous visitor.
  await requireUser();

  const preview = await previewInvite(code);
  const errorMessage = typeof error === "string" ? ERROR_MESSAGES[error] : undefined;

  if (!preview) {
    return (
      <main className="animate-rise space-y-6 pt-8">
        <Card className="text-center">
          <div className="py-8">
            <h1 className="font-medium text-ink">This invite isn&rsquo;t valid</h1>
            <p className="mx-auto mt-1.5 max-w-[30ch] text-sm text-ink-muted">
              {errorMessage ??
                "It may have expired, been used already, or been cancelled."}
            </p>
            <ButtonLink href="/groups" className="mt-5" size="sm" variant="secondary">
              Go to my groups
            </ButtonLink>
          </div>
        </Card>
      </main>
    );
  }

  const acceptWithCode = acceptInviteAction.bind(null, code);

  return (
    <main className="animate-rise space-y-6 pt-8">
      <div className="text-center">
        <p className="text-sm text-ink-muted">You&rsquo;ve been invited to</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {preview.groupName}
        </h1>
      </div>

      <Card raised>
        <dl className="space-y-3 text-sm">
          <Row
            label="Type"
            value={preview.groupType === "ROTATING" ? "Rotating (Ajo)" : "Treasury"}
          />
          <Row
            label="Contribution"
            value={`${preview.contributionAmount.format({ compact: true })} ${
              preview.cadence === "MONTHLY" ? "monthly" : "weekly"
            }`}
          />
          <Row
            label="Members"
            value={`${preview.memberCount} already in`}
          />
        </dl>
      </Card>

      <p className="text-center text-sm text-ink-muted">
        Joining commits you to contributing{" "}
        {preview.contributionAmount.format({ compact: true })}{" "}
        {preview.cadence === "MONTHLY" ? "every month" : "every week"}. You can
        leave at any time.
      </p>

      {errorMessage && (
        <p role="alert" className="text-center text-sm text-danger">
          {errorMessage}
        </p>
      )}

      <form action={acceptWithCode} className="space-y-3">
        <Button type="submit" size="lg" fullWidth>
          Join {preview.groupName}
        </Button>
        <Link
          href="/groups"
          className="block text-center text-sm text-ink-muted transition-colors hover:text-ink"
        >
          Not now
        </Link>
      </form>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-right text-ink">{value}</dd>
    </div>
  );
}
