import { revalidateTag } from "next/cache";

/** profile: "max" | "expire:<seconds>" ({ expire }). updateTag is only allowed in server actions. */
export function applyRevalidation({ tag, profile = "max" }) {
  if (!tag) return;
  if (profile.startsWith("expire:")) revalidateTag(tag, { expire: Number(profile.slice("expire:".length)) });
  else revalidateTag(tag, profile);
}
