import { connection } from "next/server";

import { db } from "@/lib/db";
import { forbidden, requireAdmin, requireUser, unauthorized } from "@/lib/session";
import {
  checkPasswordStrength,
  findUserById,
  listUsers,
  revokeAllUserKeys,
  setUserPassword,
  setUserRole,
  setUserTier,
} from "@/lib/users";
import { isTier, type Tier } from "@/lib/pricing";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Update one account (admin only).
 *
 * Supports changing the plan, promoting/demoting to admin, resetting the
 * password and revoking every API key.
 */
export async function PATCH(request: Request, context: RouteContext) {
  await connection();

  const admin = requireAdmin(request);
  if (!admin) {
    return requireUser(request) ? forbidden() : unauthorized();
  }

  const { id } = await context.params;
  const userId = Number(id);

  if (!Number.isInteger(userId)) {
    return Response.json(
      { error: { status: 400, code: "invalid_id", message: "Unknown account." } },
      { status: 400 },
    );
  }

  const target = findUserById(userId);
  if (!target) {
    return Response.json(
      { error: { status: 404, code: "user_not_found", message: "Unknown account." } },
      { status: 404 },
    );
  }

  let body: {
    tier?: unknown;
    role?: unknown;
    password?: unknown;
    revoke_keys?: unknown;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json(
      { error: { status: 400, code: "invalid_json", message: "Body must be valid JSON." } },
      { status: 400 },
    );
  }

  /* --- Plan -------------------------------------------------------------- */
  if (body.tier !== undefined) {
    if (typeof body.tier !== "string" || !isTier(body.tier)) {
      return Response.json(
        {
          error: {
            status: 400,
            code: "invalid_tier",
            message: "Tier must be hobby, professional or enterprise.",
          },
        },
        { status: 400 },
      );
    }

    setUserTier(userId, body.tier as Tier);
  }

  /* --- Role -------------------------------------------------------------- */
  if (body.role !== undefined) {
    if (body.role !== "user" && body.role !== "admin") {
      return Response.json(
        {
          error: {
            status: 400,
            code: "invalid_role",
            message: "Role must be user or admin.",
          },
        },
        { status: 400 },
      );
    }

    // Never let the last admin be demoted — that would lock everyone out.
    if (body.role === "user" && target.role === "admin") {
      const admins = listUsers().filter((row) => row.role === "admin");
      if (admins.length <= 1) {
        return Response.json(
          {
            error: {
              status: 400,
              code: "last_admin",
              message: "This is the last administrator account and cannot be demoted.",
            },
          },
          { status: 400 },
        );
      }
    }

    setUserRole(userId, body.role);
  }

  /* --- Password reset ---------------------------------------------------- */
  if (typeof body.password === "string" && body.password) {
    const weak = checkPasswordStrength(body.password);
    if (weak) {
      return Response.json(
        { error: { status: 400, code: "weak_password", message: weak } },
        { status: 400 },
      );
    }

    setUserPassword(userId, body.password);

    // A reset invalidates every session of that account.
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }

  /* --- Revoke keys ------------------------------------------------------- */
  let revokedKeys = 0;
  if (body.revoke_keys === true) {
    revokedKeys = revokeAllUserKeys(userId);
  }

  const updated = findUserById(userId);

  return Response.json({
    ok: true,
    revoked_keys: revokedKeys,
    user: updated
      ? {
          id: updated.id,
          email: updated.email,
          name: updated.name,
          tier: updated.tier,
          role: updated.role,
          monthly_credits: updated.monthly_credits,
          rate_limit_per_minute: updated.rate_limit_per_minute,
          concurrent_limit: updated.concurrent_limit,
        }
      : null,
  });
}
