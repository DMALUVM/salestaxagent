import { redirect } from "next/navigation";

/** Bookmark for Reese / Dana — same desk, Needs case tab. */
export default function ReimbursementsEligiblePage() {
  redirect("/reimbursements?tab=eligible");
}
