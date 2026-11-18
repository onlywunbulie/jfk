import { redirect } from "next/navigation";

/** Never built; each group's #transactions and #votes cover it. Old links go home. */
export default function ActivityPage(): never {
  redirect("/");
}
