import { connection } from "next/server";

import { generateApiKey } from "@/lib/auth";
import { db, type ApiKeyRow } from "@/lib/db";
import { requireUser, unauthorized } from "@/lib/session";

/** List the API keys of the signed-in user (Step 5.1, masked by default). */
export async function GET(request: Request) {
  await connection();

  const user = requireUser(request);
  if (!user) return unauthorized();

  const rows = db
    .prepare(
      "SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC",
    )
    .all(user.id) as ApiKeyRow[];

  return Response.json(
    {
      keys: rows.map((row) => ({
        id: row.id,
        label: row.label,
        masked: row.key_prefix,
        created_at: row.created_at,
        last_used_at: row.last_used_at,
        revoked_at: row.revoked_at,
        active: row.revoked_at === null,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** Create a new API key. The plaintext secret is returned exactly once. */
export async function POST(request: Request) {
  const user = requireUser(request);
  if (!user) return unauthorized();

  let body: { label?: unknown } = {};
  try {
    body = (await request.json()) as { label?: unknown };
  } catch {
    body = {};
  }

  const label =
    typeof body.label === "string" && body.label.trim()
      ? body.label.trim().slice(0, 60)
      : "default";

  const key = generateApiKey();
  const result = db
    .prepare(
      `INSERT INTO api_keys (user_id, label, key_prefix, key_hash, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(user.id, label, key.prefix, key.hash, Date.now());

  return Response.json(
    {
      id: Number(result.lastInsertRowid),
      label,
      masked: key.prefix,
      // Shown once. It is hashed on the server and cannot be recovered.
      secret: key.plaintext,
    },
    { status: 201 },
  );
}
