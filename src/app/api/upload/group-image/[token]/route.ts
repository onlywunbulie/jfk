import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { readUploadToken, UPLOAD_TOKEN_SECONDS } from "@/lib/upload-token";
import { setGroupImageFromBytes } from "@/modules/groups/images";

/**
 * Where Claude sends a file the user attached, using the one-time address
 * from the upload_group_image tool:
 *
 *   curl -X PUT --data-binary @photo.jpg <address>
 *
 * The body is the image itself (or a form with a "file" field). The token in
 * the address says who, which group and which image; the usual rules still
 * apply (owner or admin), and the image is re-encoded before it's stored.
 * Vercel accepts at most 4.5 MB per request.
 */

const MAX_BODY = 4_500_000;

async function handle(request: Request, { params }: RouteContext<"/api/upload/group-image/[token]">) {
  const { token } = await params;
  const grant = readUploadToken(token);
  if (!grant) return NextResponse.json({ ok: false, error: "This upload address isn't valid, or has expired. Ask for a new one." }, { status: 401 });

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY) return NextResponse.json({ ok: false, error: "The file is over 4.5 MB. Shrink it and try again." }, { status: 413 });

  let bytes: Buffer;
  try {
    if ((request.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
      const file = (await request.formData()).get("file");
      if (!(file instanceof Blob)) return NextResponse.json({ ok: false, error: "Send the image as the body, or as a form field called file." }, { status: 400 });
      bytes = Buffer.from(await file.arrayBuffer());
    } else {
      bytes = Buffer.from(await request.arrayBuffer());
    }
  } catch {
    return NextResponse.json({ ok: false, error: "Couldn't read the upload." }, { status: 400 });
  }
  if (bytes.length === 0) return NextResponse.json({ ok: false, error: "The upload was empty." }, { status: 400 });
  if (bytes.length > MAX_BODY) return NextResponse.json({ ok: false, error: "The file is over 4.5 MB. Shrink it and try again." }, { status: 413 });

  // Each address works once.
  const once = await rateLimit(`upload-token:${grant.nonce}`, 1, UPLOAD_TOKEN_SECONDS);
  if (!once.ok) return NextResponse.json({ ok: false, error: "This upload address has already been used. Ask for a new one." }, { status: 409 });

  const saved = await setGroupImageFromBytes(grant.userId, grant.groupId, grant.kind, bytes);
  if (!saved.ok) return NextResponse.json({ ok: false, error: saved.reason }, { status: 422 });
  return NextResponse.json({ ok: true, set: grant.kind === "avatar" ? "picture" : "banner" });
}

export const PUT = handle;
export const POST = handle;
