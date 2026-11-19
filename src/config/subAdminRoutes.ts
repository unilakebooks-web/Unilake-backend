// The only /api/admin routes a SUB_ADMIN may use: the order routes. Everything else is
// closed to a sub-admin by default, so a route added later stays closed until it is listed here on
// purpose. requireStaff reads this list; tests/integration/adminRouteWalk.test.ts proves it against
// every route the admin router really registers.
//
// ⚠️ The admin sidebar's list of entries for a sub-admin (frontend components/admin/AdminSidebar.tsx)
// follows this list: change both together.
//
// Matching follows how Express 5 matches the same routes (probed on 5.2.1): on the path below the
// /api/admin mount without the query string, case-insensitive, with one optional trailing slash, an
// id being any run of characters but "/", and HEAD answered by the GET route. A path with an empty
// segment ("//orders") matches no route in Express and no pattern here.

type StaffRoute = { method: string; pattern: RegExp };

const ID = "[^/]+";

function staffRoute(method: string, path: string): StaffRoute {
  return { method, pattern: new RegExp(`^${path}/?$`, "i") };
}

export const SUB_ADMIN_ROUTES: StaffRoute[] = [
  staffRoute("GET", "/orders"),
  staffRoute("GET", `/orders/${ID}`),
  staffRoute("GET", `/orders/${ID}/label`),
  staffRoute("GET", `/orders/${ID}/bill-of-supply`),
  staffRoute("POST", `/orders/${ID}/confirm-dimensions`),
  staffRoute("POST", `/orders/${ID}/retry-shiprocket`),
  staffRoute("POST", `/orders/${ID}/refresh-tracking`),
  staffRoute("PATCH", `/orders/${ID}/sent-to-printer`),
  staffRoute("GET", `/orders/${ID}/pages`),
  staffRoute("POST", `/orders/${ID}/regenerate-pages`),
  staffRoute("PATCH", `/orders/${ID}/shipping-address`),
  staffRoute("POST", `/orders/${ID}/shipping-address/retry-sync`),
];

/** True when a SUB_ADMIN may call this method and path (the path as seen below the /api/admin mount). */
export function isSubAdminRoute(method: string, path: string): boolean {
  const upper = method.toUpperCase();
  const effective = upper === "HEAD" ? "GET" : upper;
  return SUB_ADMIN_ROUTES.some(
    (route) => route.method === effective && route.pattern.test(path)
  );
}
