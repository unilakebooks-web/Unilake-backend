// The Shiprocket address client (updateOrderAddress, getOrderAddress) against a stubbed
// fetch: the empty 202 that the address call answers, a refusal whose text must never
// travel on, a call that gives up, and the read of the order's address. The shapes are
// the ones seen on a real Shiprocket test account.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/config/env.js", () => ({
  config: {
    nodeEnv: "test",
    shiprocket: { email: "e", password: "p", pickupLocationName: "x" },
  },
}));
// A valid cached token, so no login call is made and no database is touched.
vi.mock("../../src/lib/systemConfig.js", () => ({
  getSystemConfig: vi.fn(async (key: string) =>
    key === "shiprocket_token"
      ? "test-token"
      : new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString()
  ),
  setSystemConfig: vi.fn(),
}));

import {
  getOrderAddress,
  updateOrderAddress,
} from "../../src/lib/shiprocket.js";
import { AppError } from "../../src/utils/errors.js";

const PARAMS = {
  shiprocketOrderId: "1740347527",
  name: "Asha Kapoor",
  phone: "9123456780",
  line1: "Flat 9, Sunrise Apartments",
  line2: null,
  city: "Mumbai",
  state: "Maharashtra",
  country: "India",
  pincode: "400050",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("updateOrderAddress", () => {
  it("sends the documented body (integers where Shiprocket wants them) and accepts the empty 202", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateOrderAddress(PARAMS)).resolves.toBeUndefined();

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    const [url, init] = calls[0]!;
    expect(url).toBe(
      "https://apiv2.shiprocket.in/v1/external/orders/address/update"
    );
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token"
    );
    expect(JSON.parse(init.body as string)).toEqual({
      order_id: 1740347527,
      shipping_customer_name: "Asha Kapoor",
      shipping_phone: 9123456780,
      shipping_address: "Flat 9, Sunrise Apartments",
      shipping_address_2: "",
      shipping_city: "Mumbai",
      shipping_state: "Maharashtra",
      shipping_country: "India",
      shipping_pincode: 400050,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal); // a call that cannot hang for ever
  });

  it("gives up after 15 seconds", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 202 }))
    );
    await updateOrderAddress(PARAMS);
    expect(timeout).toHaveBeenCalledWith(15_000);
    timeout.mockRestore();
  });

  it("a value that is not a plain number is refused without repeating the value", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const error = await updateOrderAddress({
      ...PARAMS,
      phone: "+91 9123456780",
    }).catch((e) => e);
    expect(error.message).toMatch(/plain number/);
    expect(error.message).not.toContain("9123456780");
  });

  it("a refusal throws a message with the status only, never the text Shiprocket sent back", async () => {
    const reply = {
      message: "Oops! Invalid Data.",
      errors: {
        shipping_phone: ["Flat 9, Sunrise Apartments 9123456780 is not valid"],
      },
      status_code: 422,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(reply), { status: 422 }))
    );

    const error = await updateOrderAddress(PARAMS).catch((e) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error.message).toBe(
      "Shiprocket /orders/address/update failed with HTTP 422"
    );
    expect(error.message).not.toMatch(/Sunrise|9123456780/);
  });

  it("a call that is aborted rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError"
        );
      })
    );
    await expect(updateOrderAddress(PARAMS)).rejects.toThrow(/timeout/i);
  });

  it("refuses a phone or pincode that is not a plain number before any call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      updateOrderAddress({ ...PARAMS, phone: "+91 9123456780" })
    ).rejects.toThrow();
    await expect(
      updateOrderAddress({ ...PARAMS, pincode: "SW1A 1AA" })
    ).rejects.toThrow();
    await expect(
      updateOrderAddress({ ...PARAMS, pincode: "1e5" })
    ).rejects.toThrow();
    await expect(
      updateOrderAddress({ ...PARAMS, phone: "0x12345678" })
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getOrderAddress", () => {
  const order = (data: Record<string, unknown>) =>
    vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200 }));

  it("reads the customer_* fields and turns null into an empty string", async () => {
    const fetchMock = order({
      customer_name: "Asha Kapoor",
      customer_address: "Flat 9, Sunrise Apartments",
      customer_address_2: null,
      customer_city: "Mumbai",
      customer_state: "Maharashtra",
      customer_pincode: "400050",
      customer_country: "India",
      customer_phone: "xxxxxxxxxx",
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await getOrderAddress("1740347527")).toEqual({
      name: "Asha Kapoor",
      line1: "Flat 9, Sunrise Apartments",
      line2: "",
      city: "Mumbai",
      state: "Maharashtra",
      pincode: "400050",
      country: "India",
    });
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![0]).toBe(
      "https://apiv2.shiprocket.in/v1/external/orders/show/1740347527"
    );
  });

  it("encodes the order id in the path", async () => {
    const fetchMock = order({ customer_name: "x" });
    vi.stubGlobal("fetch", fetchMock);
    await getOrderAddress("12/../34");
    const calls = fetchMock.mock.calls as unknown as [string][];
    expect(calls[0]![0]).toBe(
      "https://apiv2.shiprocket.in/v1/external/orders/show/12%2F..%2F34"
    );
  });

  it("a reply with no order in it throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    );
    await expect(getOrderAddress("1")).rejects.toThrow(/no order/);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 200 }))
    );
    await expect(getOrderAddress("1")).rejects.toThrow(/no order/);
  });

  it("an error status throws without the reply text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Flat 9 secret", { status: 500 }))
    );
    const error = await getOrderAddress("1").catch((e) => e);
    expect(error.message).toBe(
      "Shiprocket /orders/show/1 failed with HTTP 500"
    );
  });
});
