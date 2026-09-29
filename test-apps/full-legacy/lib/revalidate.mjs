import { revalidatePath, revalidateTag } from "next/cache";

/**
 * Applies one invalidation. `profile`: "none" (revalidateTag(tag), deprecated single-argument form),
 * "max", or "expire:<seconds>" ({ expire }).
 */
export function applyRevalidation({ tag, path, profile = "max" }) {
  if (path) revalidatePath(path);
  if (!tag) return;
  if (profile === "none") revalidateTag(tag);
  else if (profile.startsWith("expire:")) revalidateTag(tag, { expire: Number(profile.slice("expire:".length)) });
  else revalidateTag(tag, profile);
}
