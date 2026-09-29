"use server";
import { updateTag } from "next/cache";
import { applyRevalidation } from "../../lib/revalidate.mjs";

export async function updateTagAction(formData) {
  updateTag(String(formData.get("tag")));
}

export async function revalidateAction(formData) {
  applyRevalidation({ tag: String(formData.get("tag")), profile: String(formData.get("profile") || "max") });
}
