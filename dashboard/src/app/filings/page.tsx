import { redirect } from "next/navigation";

/** Canonical filing UI lives on /calendar — keep this URL so old bookmarks work. */
export default function FilingsRedirect() {
  redirect("/calendar");
}
