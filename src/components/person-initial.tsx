import { UserIcon } from "@/components/ui/iconoir";
import { initialOf } from "@/lib/names";

/** A person's initial, or the person icon when they haven't given a name. */
export function PersonInitial({ name, iconClassName = "size-[55%]" }: { name: string; iconClassName?: string }) {
  const initial = initialOf(name);
  return initial ?? <UserIcon className={iconClassName} />;
}
