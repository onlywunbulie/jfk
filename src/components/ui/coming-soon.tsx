import { Card } from "./card";

/**
 * Placeholder for tabs whose real content arrives in a later phase. Named
 * honestly so it's obvious in a grep what still needs building.
 */
export function ComingSoon({
  title,
  description,
  phase,
}: {
  title: string;
  description: string;
  phase: string;
}) {
  return (
    <main className="animate-rise space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <Card className="border-dashed text-center">
        <div className="py-8">
          <p className="mx-auto max-w-[30ch] text-sm text-ink-muted">{description}</p>
          <p className="mt-4 text-xs text-ink-faint">{phase}</p>
        </div>
      </Card>
    </main>
  );
}
