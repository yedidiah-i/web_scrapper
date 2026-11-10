/**
 * End-to-end check of the auth and admin flows against the running dev server.
 *
 *   node scripts/verify.mjs
 */
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures += 1;
}

async function json(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, options);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}

console.log("public pages");
for (const path of ["/", "/login", "/signup"]) {
  const response = await fetch(`${BASE}${path}`);
  const html = await response.text();
  check(`${path} renders`, response.status === 200, `status ${response.status}`);
  if (path === "/") {
    check("landing shows the hero", html.includes("clean, structured JSON"));
    check("landing links to signup", html.includes("/signup"));
    check("landing links to login", html.includes("/login"));
  }
}

console.log("route protection");
{
  const response = await fetch(`${BASE}/dashboard`, { redirect: "manual" });
  check("dashboard redirects when signed out", response.status === 307 || response.status === 302,
    `status ${response.status}`);
  const admin = await fetch(`${BASE}/admin`, { redirect: "manual" });
  check("admin redirects when signed out", admin.status === 307 || admin.status === 302,
    `status ${admin.status}`);
}

console.log("signup validation");
{
  const weak = await json("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Test", email: "t@example.com", password: "short" }),
  });
  check("weak password rejected", weak.status === 400, `status ${weak.status}`);

  const bad = await json("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Test", email: "not-an-email", password: "longenough123" }),
  });
  check("invalid email rejected", bad.status === 400, `status ${bad.status}`);
}

console.log("signup creates an account");
const email = `verify-${Date.now()}@example.com`;
{
  const created = await json("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Verify User", email, password: "verify-password-123" }),
  });
  check("account created", created.status === 201, JSON.stringify(created.body).slice(0, 160));
  check("session cookie issued", Boolean(created.headers.get("set-cookie")));
  check("api key returned once", typeof created.body?.api_key === "string");

  const dupe = await json("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Verify User", email, password: "verify-password-123" }),
  });
  check("duplicate email rejected", dupe.status === 409, `status ${dupe.status}`);
}

console.log("admin access");
{
  const adminLogin = await json("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "yedidiah@scrapeworks.com", password: "yedidiah@scrapeworks.com" }),
  });
  check("admin can sign in", adminLogin.status === 200, JSON.stringify(adminLogin.body).slice(0, 160));
  check("admin role returned", adminLogin.body?.user?.role === "admin");

  const cookie = (adminLogin.headers.get("set-cookie") ?? "").split(";")[0];
  check("session cookie set", cookie.startsWith("scrapeworks_session="));

  const users = await json("/api/admin/users", { headers: { cookie } });
  check("admin can list accounts", users.status === 200, `status ${users.status}`);
  check("accounts listed", Array.isArray(users.body?.users) && users.body.users.length >= 2,
    `count ${users.body?.users?.length}`);
  check("seeded admin present",
    users.body?.users?.some((u) => u.email === "yedidiah@scrapeworks.com"));

  const target = users.body?.users?.find((u) => u.email === email);
  if (target) {
    const patched = await json(`/api/admin/users/${target.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ tier: "professional" }),
    });
    check("admin can change a plan", patched.status === 200 && patched.body?.user?.tier === "professional",
      JSON.stringify(patched.body).slice(0, 160));

    const reset = await json(`/api/admin/users/${target.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ password: "reset-password-456" }),
    });
    check("admin can reset a password", reset.status === 200, `status ${reset.status}`);
  }
}

console.log("admin is required");
{
  // The admin reset this account's password above, so sign in with the new one.
  const userLogin = await json("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "reset-password-456" }),
  });
  check("reset password works", userLogin.status === 200, JSON.stringify(userLogin.body).slice(0, 160));
  const cookie = (userLogin.headers.get("set-cookie") ?? "").split(";")[0];
  const denied = await json("/api/admin/users", { headers: { cookie } });
  check("non-admin blocked from admin api", denied.status === 403, `status ${denied.status}`);
}

console.log("account self-service");
{
  const login = await json("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "reset-password-456" }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  const renamed = await json("/api/account/profile", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ name: "Renamed User" }),
  });
  check("name updated", renamed.status === 200, `status ${renamed.status}`);

  const sessions = await json("/api/account/sessions", { headers: { cookie } });
  check("sessions listed", sessions.status === 200 && Array.isArray(sessions.body?.sessions),
    `status ${sessions.status}`);

  const wrongCurrent = await json("/api/account/profile", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ current_password: "wrong-password-1", password: "new-password-999" }),
  });
  check("password change needs the current password", wrongCurrent.status === 401,
    `status ${wrongCurrent.status}`);

  const changed = await json("/api/account/profile", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ current_password: "reset-password-456", password: "new-password-999" }),
  });
  check("password changed with the correct current password", changed.status === 200,
    `status ${changed.status}`);
}

console.log("health");
{
  const health = await json("/api/health");
  check("health reports ok", health.status === 200 && health.body?.status === "ok",
    JSON.stringify(health.body));
  check("engine reachable", health.body?.engine?.status === "ok");
  check("processor reachable", health.body?.processor?.status === "ok");
}

console.log();
if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
