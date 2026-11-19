import { describe, it, expect } from "vitest";
import {
  isSubAdminRoute,
  SUB_ADMIN_ROUTES,
} from "../../src/config/subAdminRoutes.js";
import { STAFF_ROUTES } from "../fixtures/adminRouteClassification.js";

const ID = "7f3c2d9e-1a4b-4c8d-9e5f-0a1b2c3d4e5f";

describe("isSubAdminRoute: the ten order routes are open", () => {
  const open: [string, string][] = [
    ["GET", "/orders"],
    ["GET", `/orders/${ID}`],
    ["GET", `/orders/${ID}/label`],
    ["GET", `/orders/${ID}/bill-of-supply`],
    ["POST", `/orders/${ID}/confirm-dimensions`],
    ["POST", `/orders/${ID}/retry-shiprocket`],
    ["POST", `/orders/${ID}/refresh-tracking`],
    ["PATCH", `/orders/${ID}/sent-to-printer`],
    ["GET", `/orders/${ID}/pages`],
    ["POST", `/orders/${ID}/regenerate-pages`],
  ];

  it("is the same set of routes the classification lists as staff", () => {
    const asKeys = open.map(([m, p]) => `${m} ${p.replace(ID, ":orderId")}`);
    expect([...asKeys].sort()).toEqual([...STAFF_ROUTES].sort());
    expect(SUB_ADMIN_ROUTES).toHaveLength(STAFF_ROUTES.length);
  });

  it.each(open)("%s %s", (method, path) => {
    expect(isSubAdminRoute(method, path)).toBe(true);
  });

  it("matches the way Express matches: case, one trailing slash, HEAD as GET", () => {
    expect(isSubAdminRoute("GET", `/ORDERS/${ID}`)).toBe(true);
    expect(isSubAdminRoute("get", `/orders/${ID}/`)).toBe(true);
    expect(isSubAdminRoute("POST", `/Orders/${ID}/RETRY-SHIPROCKET/`)).toBe(
      true
    );
    expect(isSubAdminRoute("HEAD", `/orders/${ID}`)).toBe(true);
    expect(isSubAdminRoute("HEAD", "/orders")).toBe(true);
    expect(isSubAdminRoute("GET", "/orders/")).toBe(true);
  });

  it("takes an encoded slash inside an id as one id, as Express does", () => {
    expect(isSubAdminRoute("GET", `/orders/${ID}%2Fretry-shiprocket`)).toBe(
      true
    );
    // ...and that is still the single-order GET route, not the POST one.
    expect(isSubAdminRoute("POST", `/orders/${ID}%2Fretry-shiprocket`)).toBe(
      false
    );
  });
});

describe("isSubAdminRoute: everything else is closed", () => {
  it.each([
    ["GET", "/comics"],
    ["GET", "/users"],
    ["PATCH", `/users/${ID}/role`],
    ["GET", "/customers"],
    ["GET", "/customers/export"],
    ["GET", "/stats/summary"],
    ["GET", "/coupons/customers"],
    ["GET", "/status"],
    ["GET", "/site-settings"],
    ["POST", "/orders"],
    ["DELETE", `/orders/${ID}`],
    ["PUT", `/orders/${ID}`],
    ["PATCH", `/orders/${ID}`],
    ["GET", `/orders/${ID}/retry-shiprocket`],
    ["POST", `/orders/${ID}/label`],
    ["GET", `/orders/${ID}/unknown`],
    ["GET", `/orders/${ID}/pages/extra`],
    ["GET", `/orders/${ID}/pages//`],
    ["OPTIONS", "/orders"],
  ])("%s %s", (method, path) => {
    expect(isSubAdminRoute(method, path)).toBe(false);
  });

  it("refuses paths Express would not route to an order route", () => {
    for (const path of [
      "//orders",
      `//orders/${ID}`,
      `/orders//${ID}`,
      "/orders/../comics",
      "/orders/%2e%2e/comics",
      `/orders/${ID}/../comics`,
      "/orders//",
      "",
      "/",
      "orders",
      "/orderss",
      "/x/orders",
    ]) {
      expect(isSubAdminRoute("GET", path), `GET ${path}`).toBe(false);
    }
  });

  it("does not let a query string or fragment text change the answer (req.path has neither)", () => {
    expect(isSubAdminRoute("GET", "/comics?x=/orders")).toBe(false);
    expect(isSubAdminRoute("GET", `/orders/${ID}?x=1`)).toBe(true);
  });
});
