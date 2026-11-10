import { connection } from "next/server";

import { generateApiKey } from "@/lib/auth";
import { db, type ApiKeyRow } from "@/lib/db";
import { requireUser, unauthorized } from "@/lib/session";

type RouteContext = { params: Promise<{ id: string }> };

/** Rotate a key: the old secret stops working, a new one is returned once. */
export async function POST(request: Request, context: RouteContext) {
  const user = requireUser(request);
  if (!user) return unauthorized();

  const { id } = await context.params;
  const keyId = Number(id);

  const existing = db
    .prepare("SELECT * FROM api_keys WHERE id = ? AND user_id = ?")
    .get(keyId, user.id) as ApiKeyRow | undefined;

  if (!existing) {
    return Response.json(
      { error: { status: 404, code: "key_not_found", message: "Unknown API key." } },
      { status: 404 },
    );
  }

  const key = generateApiKey();
  const now = Date.now();

  db.prepare(
    "UPDATE api_keys SET revoked_at = ?, key_prefix = ?, key_hash = ? WHERE id = ?",
  ).run(now, key.prefix, key.hash, keyId);

  return Response.json({
    id: keyId,
    label: existing.label,
    masked: key.prefix,
    secret: key.plaintext,
    rotated_at: now,
  });
}

/** Revoke a key without creating a replacement. */
export async function DELETE(request: Request, context: RouteContext) {
  await connection();

  const user = requireUser(request);
  if (!user) return unauthorized();

  const { id } = await context.params;
  const keyId = Number(id);

  const result = db
    .prepare(
      "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    )
    .run(Date.now(), keyId, user.id);

  if (result.changes === 0) {
    return Response.json(
      { error: { status: 404, code: "key_not_found", message: "Unknown API key." } },
      { status: 404 },
    );
  }

  return Response.json({ id: keyId, revoked: true });
}
