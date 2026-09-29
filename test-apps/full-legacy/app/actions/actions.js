"use server";
import { applyRevalidation } from "../../lib/revalidate.mjs";

export async function revalidateAction(formData) {
  applyRevalidation({
    tag: formData.get("tag") || undefined,
    path: formData.get("path") || undefined,
    profile: formData.get("profile") || "max",
  });
}
