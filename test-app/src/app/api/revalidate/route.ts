import { revalidateTag, revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const logPath = join(process.cwd(), "cache-debug.log");

function log(method: string, target: string, handler: string) {
  const entry = {
    ts: new Date().toISOString(),
    handler: "revalidate-api",
    method,
    key: target,
    status: "done",
    targetHandler: handler,
  };
  try {
    appendFileSync(logPath, JSON.stringify(entry) + "\n");
  } catch {
    // ignore
  }
}

export async function GET(request: NextRequest) {
  const tag = request.nextUrl.searchParams.get("tag");
  const path = request.nextUrl.searchParams.get("path");
  const handler = request.nextUrl.searchParams.get("handler") ?? "default";
  const redirect = request.nextUrl.searchParams.get("redirect") ?? "/";

  if (!tag && !path) {
    return NextResponse.json(
      { error: "Provide ?tag=xxx or ?path=xxx" },
      { status: 400 }
    );
  }

  try {
    if (tag) {
      // 2nd arg is cacheLife profile, not handler name. "default" works for both legacy & use-cache.
      revalidateTag(tag, "default");
      log("revalidateTag", tag, handler);
    }
    if (path) {
      revalidatePath(path);
      log("revalidatePath", path, "all");
    }
  } catch (err) {
    console.error("[revalidate]", err);
    return NextResponse.json(
      { error: "Revalidation failed", detail: String(err) },
      { status: 500 }
    );
  }

  return NextResponse.redirect(new URL(redirect, request.url));
}
