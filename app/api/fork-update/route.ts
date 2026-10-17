import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { ForkUpdateError, getForkUpdateInfo, startForkUpdate } from "@/lib/fork-update";
import { isApiRequestOriginAllowed, shouldCheckApiRequestOrigin } from "@/lib/request-security";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

async function errorResponse(error: unknown): Promise<NextResponse> {
  if (error instanceof ForkUpdateError) {
    const info = error.httpStatus === 409 ? await getForkUpdateInfo() : undefined;
    return NextResponse.json({ ...info, error: error.message, code: error.code }, { status: error.httpStatus, headers });
  }
  if (error instanceof RequestBodyTooLargeError) {
    return NextResponse.json({ error: "Request body is too large", code: "body_too_large" }, { status: 413, headers });
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400, headers });
  }
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error), code: "fork_update_failed" }, { status: 500, headers });
}

export async function GET() {
  try {
    return NextResponse.json(await getForkUpdateInfo(), { headers });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  if (shouldCheckApiRequestOrigin(request) && !isApiRequestOriginAllowed(request)) {
    return NextResponse.json({ error: "Cross-origin API requests are not allowed", code: "cross_origin_forbidden" }, { status: 403, headers });
  }
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return NextResponse.json({ error: "Content-Type must be application/json", code: "unsupported_media_type" }, { status: 415, headers });
  }
  try {
    const body: unknown = await parseJsonWithinLimit(request, 4_096);
    if (!isRecord(body) || body.action !== "update" || Object.keys(body).length !== 1) {
      return NextResponse.json({ error: "The only supported action is update", code: "invalid_action" }, { status: 400, headers });
    }
    return NextResponse.json(await startForkUpdate(), { status: 202, headers });
  } catch (error) {
    return errorResponse(error);
  }
}
