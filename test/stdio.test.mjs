// End-to-end: start the real MCP server over stdio against a local fake Gelato API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

function fakeGelato() {
  const seen = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.setHeader("Content-Type", "application/json");
      const send = (x) => res.end(JSON.stringify(x));
      const path = req.url.split("?")[0];
      if (path === "/v3/catalogs") return send([{ catalogUid: "posters", title: "Posters" }]);
      if (path === "/v4/orders:quote") {
        return send({
          quotes: [
            {
              fulfillmentCountry: "US",
              itemReferenceIds: ["item-1"],
              products: [{ itemReferenceId: "item-1", productUid: "poster_a3", quantity: 2, price: 18.4, currency: "USD" }],
              shipmentMethods: [
                { shipmentMethodUid: "ups_ground", name: "UPS Ground", type: "normal", price: 6.1, currency: "USD", minDeliveryDays: 4, maxDeliveryDays: 6, minDeliveryDate: "2026-10-12", maxDeliveryDate: "2026-10-14" },
                { shipmentMethodUid: "ups_express", name: "UPS Express", type: "express", price: 21, currency: "USD", minDeliveryDays: 1, maxDeliveryDays: 2, minDeliveryDate: "2026-10-09", maxDeliveryDate: "2026-10-10" },
              ],
            },
          ],
        });
      }
      if (path === "/v4/orders" && req.method === "POST") {
        const b = JSON.parse(body);
        return send({ id: "o-1", orderType: b.orderType, orderReferenceId: b.orderReferenceId, fulfillmentStatus: "draft", items: b.items });
      }
      if (path === "/v4/orders:search") {
        return send({
          orders: [
            { id: "o-1", orderReferenceId: "A-1", fulfillmentStatus: "shipped", currency: "USD", totalInclVat: "33.45" },
            { id: "o-2", orderReferenceId: "A-2", fulfillmentStatus: "on_hold", currency: "USD", totalInclVat: "12.00" },
          ],
        });
      }
      res.statusCode = 404;
      send({ code: "not_found", message: "Order not found" });
    });
  });
  return { srv, seen };
}

function rpcClient(child) {
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  let id = 0;
  return {
    request(method, params) {
      const myId = ++id;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
      return new Promise((resolve, reject) => {
        pending.set(myId, resolve);
        setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10000);
      });
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
  };
}

test("MCP handshake, tool listing, quote, draft order and order review", async () => {
  const { srv, seen } = fakeGelato();
  srv.listen(0);
  await once(srv, "listening");
  const port = srv.address().port;

  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, GELATO_API_KEY: "key_test", GELATO_BASE_URL: `http://127.0.0.1:${port}` },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const rpc = rpcClient(child);
    const init = await rpc.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    });
    assert.equal(init.result.serverInfo.name, "gelato-mcp");
    rpc.notify("notifications/initialized", {});

    const list = await rpc.request("tools/list", {});
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "cancel_order",
      "check_stock",
      "confirm_draft_order",
      "create_order",
      "get_catalog",
      "get_order",
      "get_product",
      "get_product_prices",
      "list_catalogs",
      "list_shipment_methods",
      "list_store_products",
      "quote_order",
      "search_orders",
      "search_products",
    ]);
    assert.equal(list.result.tools.find((t) => t.name === "quote_order").annotations.readOnlyHint, true);
    assert.equal(list.result.tools.find((t) => t.name === "cancel_order").annotations.destructiveHint, true);

    const cats = await rpc.request("tools/call", { name: "list_catalogs", arguments: {} });
    assert.equal(JSON.parse(cats.result.content[0].text)[0].catalogUid, "posters");

    const address = { firstName: "Paul", lastName: "Smith", addressLine1: "451 Clarkson Ave", city: "New York", postCode: "11203", state: "NY", country: "US", email: "paul@example.com" };
    const items = [{ productUid: "poster_a3", quantity: 2, files: [{ type: "default", url: "https://example.com/art.pdf" }] }];
    const quote = await rpc.request("tools/call", { name: "quote_order", arguments: { recipient: address, items, currency: "USD" } });
    const [q] = JSON.parse(quote.result.content[0].text);
    assert.equal(q.cheapestShipping.shipmentMethodUid, "ups_ground");
    assert.equal(q.fastestShipping.shipmentMethodUid, "ups_express");
    assert.equal(q.cheapestTotal, 24.5);
    const qb = JSON.parse(seen.find((s) => s.url === "/v4/orders:quote").body);
    assert.equal(qb.products[0].itemReferenceId, "item-1");

    const order = await rpc.request("tools/call", {
      name: "create_order",
      arguments: { orderReferenceId: "A-9", customerReferenceId: "c-1", currency: "USD", items, shippingAddress: address, metadata: { source: "claude" } },
    });
    assert.equal(JSON.parse(order.result.content[0].text).type, "draft");
    const ob = JSON.parse(seen.find((s) => s.url === "/v4/orders" && s.method === "POST").body);
    assert.equal(ob.orderType, "draft");
    assert.deepEqual(ob.metadata, [{ key: "source", value: "claude" }]);

    const review = await rpc.request("tools/call", { name: "search_orders", arguments: { startDate: "2026-10-01T00:00:00Z" } });
    const r = JSON.parse(review.result.content[0].text);
    assert.equal(r.summary.totalInclVatByCurrency.USD, 45.45);
    assert.equal(r.summary.needsAttention[0].id, "o-2");

    assert.ok(seen.every((s) => s.headers["x-api-key"] === "key_test"));

    const bad = await rpc.request("tools/call", { name: "get_order", arguments: { orderId: "nope" } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /Gelato API 404/);
  } finally {
    child.kill();
    srv.close();
  }
});
