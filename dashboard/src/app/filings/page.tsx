import { redirect } from "next/navigation";

/** Orphan duplicate of Filing Calendar — keep the URL, send operators to the real page. */
export default function FilingsRedirect() {
  redirect("/calendar");
}
