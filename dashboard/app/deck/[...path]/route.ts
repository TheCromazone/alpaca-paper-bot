import { readFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { NextResponse } from "next/server";

/**
 * Serves the deck files from the repo-root `deck/` folder.
 * The dashboard's public/ directory intentionally doesn't include them so that
 * `deck/` at the repo root is the canonical location (single source of truth).
 */
const DECK_ROOT = join(process.cwd(), "..", "deck");

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js:   "application/javascript; charset=utf-8",
  jsx:  "application/javascript; charset=utf-8",
  css:  "text/css; charset=utf-8",
  json: "application/json",
  svg:  "image/svg+xml",
  png:  "image/png",
  jpg:  "image/jpeg",
  jpeg: "image/jpeg",
  gif:  "image/gif",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  const rel = path.map(decodeURIComponent).join(sep);
  const abs = normalize(join(DECK_ROOT, rel));
  // Prevent path traversal out of DECK_ROOT.
  if (!abs.startsWith(DECK_ROOT)) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  try {
    const data = await readFile(abs);
    const ext = rel.split(".").pop()?.toLowerCase() ?? "";
    const mime = MIME[ext] ?? "application/octet-stream";
    return new NextResponse(data, {
      headers: {
        "Content-Type": mime,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
