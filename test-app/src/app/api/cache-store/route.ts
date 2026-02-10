import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const { getCacheStore, getCacheEntry } = await import("../../../../logger.mjs");

  const key = request.nextUrl.searchParams.get("key");

  // Single key detail
  if (key) {
    const entry = getCacheEntry(key);
    if (!entry) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json(entry);
  }

  // List all keys (without values)
  const entries = getCacheStore();
  return NextResponse.json({ entries, total: entries.length });
}

export async function DELETE() {
  const { clearCacheStore } = await import("../../../../logger.mjs");
  clearCacheStore();
  return NextResponse.json({ ok: true });
}
