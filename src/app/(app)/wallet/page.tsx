import { redirect } from "next/navigation";

/**
 * Settings used to live here. Everything about the user is now in the
 * profile modal (the profile square at the foot of the rail), and card
 * payments are off for now, so this address just goes home with the profile
 * open.
 */
export default function WalletPage(): never {
  redirect("/?profile=1");
}
