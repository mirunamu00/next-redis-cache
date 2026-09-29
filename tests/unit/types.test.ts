// Option resolution and implicit tag detection: pins 1.0.6 defaults.
import { describe, expect, it } from "vitest";
import type { RedisClientType } from "@redis/client";
import { isImplicitTag, NEXT_CACHE_IMPLICIT_TAG_ID, resolveOptions } from "../../src/types";

const client = {} as RedisClientType;

describe("resolveOptions", () => {
  it("uses the documented defaults for omitted options", () => {
    expect(resolveOptions({ client })).toEqual({
      client,
      keyPrefix: "",
      sharedTagsKey: "__sharedTags__",
      sharedTagsTtlKey: "__sharedTagsTtl__",
      revalidatedTagsKey: "__revalidated_tags__",
      timeoutMs: 5000,
    });
  });

  it("keeps explicitly provided options", () => {
    const resolved = resolveOptions({
      client,
      keyPrefix: "app:1:",
      sharedTagsKey: "_tags",
      sharedTagsTtlKey: "_tagTtls",
      revalidatedTagsKey: "_revalidated",
      timeoutMs: 100,
    });
    expect(resolved.keyPrefix).toBe("app:1:");
    expect(resolved.sharedTagsKey).toBe("_tags");
    expect(resolved.timeoutMs).toBe(100);
  });
});

describe("isImplicitTag", () => {
  it("detects the Next.js implicit tag prefix (_N_T_)", () => {
    expect(NEXT_CACHE_IMPLICIT_TAG_ID).toBe("_N_T_");
    expect(isImplicitTag("_N_T_/blog")).toBe(true);
    expect(isImplicitTag("product")).toBe(false);
  });
});
