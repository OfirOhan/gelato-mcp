import { test } from "node:test";
import assert from "node:assert/strict";
import { GelatoClient, HOSTS, summarizeOrders, compactOrder, summarizeQuote, stripEmpty } from "../dist/client.js";

function mockFetch(responder) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, ...init });
    const { status = 200, body = {} } = (await responder(url, init)) ?? {};
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  fn.calls = calls;
  return fn;
}

test("routes each call to the right Gelato host with X-API-KEY", async () => {
  const f = mockFetch(() => ({ body: {} }));
  const c = new GelatoClient({ apiKey: "key_1", fetch: f });
  await c.listCatalogs();
  await c.shipmentMethods("US");
  await c.searchOrders({ limit: 5 });
  await c.listStoreProducts("s1", { limit: 10 });
  assert.equal(f.calls[0].url, `${HOSTS.product}/v3/catalogs`);
  assert.equal(f.calls[1].url, `${HOSTS.shipment}/v1/shipment-methods?country=US`);
  assert.equal(f.calls[2].url, `${HOSTS.order}/v4/orders:search`);
  assert.equal(f.calls[2].method, "POST");
  assert.equal(f.calls[3].url, `${HOSTS.ecommerce}/v1/stores/s1/products?limit=10`);
  assert.ok(f.calls.every((x) => x.headers["X-API-KEY"] === "key_1"));
});

test("cancel and draft confirmation use the documented verbs", async () => {
  const f = mockFetch(() => ({ body: { id: "o1" } }));
  const c = new GelatoClient({ apiKey: "k", fetch: f });
  await c.cancelOrder("o1");
  await c.patchDraft("o1", { orderType: "order" });
  assert.equal(f.calls[0].url, `${HOSTS.order}/v4/orders/o1:cancel`);
  assert.equal(f.calls[0].method, "POST");
  assert.equal(f.calls[1].method, "PATCH");
  assert.deepEqual(JSON.parse(f.calls[1].body), { orderType: "order" });
});

test("surfaces API errors with status and body", async () => {
  const f = mockFetch(() => ({ status: 409, body: { message: "Order can't be canceled" } }));
  const c = new GelatoClient({ apiKey: "k", fetch: f });
  await assert.rejects(() => c.cancelOrder("o1"), /Gelato API 409 .*can't be canceled/);
});

test("strips empty values from bodies", () => {
  assert.deepEqual(stripEmpty({ a: undefined, b: null, c: [], d: { e: 1, f: undefined } }), { d: { e: 1 } });
});

test("summarizes orders and flags the ones that need attention", () => {
  const s = summarizeOrders([
    { id: "1", fulfillmentStatus: "shipped", currency: "USD", totalInclVat: "20.50" },
    { id: "2", fulfillmentStatus: "failed", currency: "USD", totalInclVat: "10.00", orderReferenceId: "A-2" },
    { id: "3", fulfillmentStatus: "shipped", currency: "EUR", totalInclVat: "5" },
  ]);
  assert.deepEqual(s.byFulfillmentStatus, { shipped: 2, failed: 1 });
  assert.deepEqual(s.totalInclVatByCurrency, { USD: 30.5, EUR: 5 });
  assert.deepEqual(s.needsAttention, [{ id: "2", orderReferenceId: "A-2", fulfillmentStatus: "failed" }]);
});

test("compacts an order with tracking and prices", () => {
  const o = compactOrder({
    id: "o1",
    fulfillmentStatus: "shipped",
    items: [{ id: "i1", productUid: "p", quantity: 2, fulfillmentStatus: "shipped", previews: [{ url: "https://p/1.png" }] }],
    shipment: { shipmentMethodName: "UPS", minDeliveryDate: "2026-10-10", maxDeliveryDate: "2026-10-12", packages: [{ trackingCode: "1Z", trackingUrl: "https://t/1Z" }] },
    receipts: [{ currency: "USD", productsPrice: 24.94, shippingPrice: 4.91, packagingPrice: 1.7, totalVat: 1.9, totalInclVat: 33.45 }],
    shippingAddress: { firstName: "Paul", lastName: "Smith", city: "New York", country: "US" },
  });
  assert.deepEqual(o.shipping.tracking, [{ code: "1Z", url: "https://t/1Z" }]);
  assert.equal(o.shipping.estimatedDelivery, "2026-10-10 to 2026-10-12");
  assert.equal(o.price.totalInclVat, 33.45);
  assert.equal(o.items[0].preview, "https://p/1.png");
  assert.equal(o.shipTo.name, "Paul Smith");
});

test("picks the cheapest and fastest shipping in a quote", () => {
  const [q] = summarizeQuote({
    quotes: [
      {
        fulfillmentCountry: "US",
        products: [{ itemReferenceId: "a", price: 10 }, { itemReferenceId: "b", price: 5.5 }],
        shipmentMethods: [
          { shipmentMethodUid: "ups_ground", price: 5, minDeliveryDays: 5, maxDeliveryDays: 6 },
          { shipmentMethodUid: "ups_next_day", price: 25, minDeliveryDays: 1, maxDeliveryDays: 2 },
        ],
      },
    ],
  });
  assert.equal(q.productsTotal, 15.5);
  assert.equal(q.cheapestShipping.shipmentMethodUid, "ups_ground");
  assert.equal(q.fastestShipping.shipmentMethodUid, "ups_next_day");
  assert.equal(q.cheapestTotal, 20.5);
});
