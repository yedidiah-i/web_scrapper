/**
 * Safe smoke checks for the public auth flow and protected routes.
 * Optional signed-in checks use a pre-verified test account supplied via
 * VERIFY_ADMIN_EMAIL and VERIFY_ADMIN_PASSWORD; this script never creates or
 * resets accounts.
 */
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures += 1;
}

async function json(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, options);
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body, headers: response.headers };
}

console.log("public pages");
for (const path of ["/", "/login", "/signup", "/signup/check-email"]) {
  const response = await fetch(`${BASE}${path}`);
  const html = await response.text();
  check(`${path} renders`, response.status === 200, `status ${response.status}`);
  if (path === "/") {
    check("landing uses Scrappy branding", html.includes("Scrappy"));
    check("landing links to signup", html.includes("/signup"));
  }
}

console.log("route protection");
for (const path of ["/dashboard", "/account", "/admin"]) {
  const response = await fetch(`${BASE}${path}`, { redirect: "manual" });
  check(`${path} redirects when signed out`, [302, 307].includes(response.status), `status ${response.status}`);
}

console.log("signup validation");
const weak = await json("/api/auth/register", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Test", email: "t@example.com", password: "short" }),
});
check("weak password rejected before provider call", weak.status === 400, `status ${weak.status}`);
const bad = await json("/api/auth/register", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Test", email: "not-an-email", password: "longenough123" }),
});
check("invalid email rejected before provider call", bad.status === 400, `status ${bad.status}`);
const predictable = await json("/api/auth/register", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "Admin",
    email: "futureksmeyedidiah@gmail.com",
    password: "futureksmeyedidiah@gmail.com",
  }),
});
check(
  "password matching email is rejected",
  predictable.status === 400 && predictable.body?.error?.code === "password_matches_email",
  `status ${predictable.status}`,
);

const testEmail = process.env.VERIFY_ADMIN_EMAIL;
const testPassword = process.env.VERIFY_ADMIN_PASSWORD;
if (testEmail && testPassword) {
  console.log("optional Supabase sign-in");
  const login = await json("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: testEmail, password: testPassword }),
  });
  check("pre-verified account can sign in", login.status === 200, `status ${login.status}`);
  if (login.status === 200) {
    const cookieHeader = login.headers.get("set-cookie") ?? "";
    const cookie = cookieHeader
      .split(/,\s*(?=[^;,]+=)/)
      .map((value) => value.split(";")[0])
      .find((value) => value.startsWith("scrapeworks_session="));
    check("application session cookie set", Boolean(cookie));
    const adminUsers = await json("/api/admin/users", { headers: { cookie } });
    check("admin API available to administrator", adminUsers.status === 200, `status ${adminUsers.status}`);
  }
} else {
  console.log("  SKIP  signed-in checks (no verification credentials supplied)");
}

console.log("health");
const health = await json("/api/health");
check("health endpoint responds", health.status === 200, `status ${health.status}`);

if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
