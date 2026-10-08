import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GelatoClient, compactOrder, compactOrderRow, summarizeOrders, summarizeQuote, type Record_ } from "./client.js";

export const VERSION = "0.1.0";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

const RO = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } as const;

const country = z.string().regex(/^[A-Z]{2}$/).describe("Two-letter ISO country code, e.g. US, GB, DE");
const currency = z.string().length(3).describe("ISO 4217 currency, e.g. USD, EUR, GBP");
const file = z.object({
  type: z.string().optional().describe("Print area: default, front, back, inside, sleeve-left, neck-inner, chest-left-embroidery..."),
  url: z.string().url().describe("Public URL of the print file (PDF, PNG, JPEG, TIFF or SVG)"),
});
const item = z.object({
  productUid: z.string().describe("Product UID from search_products"),
  quantity: z.number().int().min(1),
  files: z.array(file).optional().describe("Print files (required for printable products)"),
  pageCount: z.number().int().optional().describe("Multi-page products only"),
  itemReferenceId: z.string().optional().describe("Your line item ID (auto-generated if omitted)"),
});
const address = z.object({
  firstName: z.string().max(25),
  lastName: z.string().max(25),
  companyName: z.string().optional(),
  addressLine1: z.string().max(35),
  addressLine2: z.string().max(35).optional(),
  city: z.string().max(30),
  postCode: z.string().max(15),
  state: z.string().optional().describe("Required for US, CA and AU"),
  country,
  email: z.string().email(),
  phone: z.string().optional(),
});

const withItemRefs = (items: z.infer<typeof item>[]) =>
  items.map((i, n) => ({ ...i, itemReferenceId: i.itemReferenceId ?? `item-${n + 1}` }));

export function createServer(client: GelatoClient): McpServer {
  const server = new McpServer({ name: "gelato-mcp", version: VERSION });

  server.registerTool(
    "list_catalogs",
    {
      title: "List product catalogs",
      description: "List Gelato's product catalogs (posters, t-shirts, mugs, cards, wall art, photo books...). Start here to find products.",
      inputSchema: {},
      annotations: RO,
    },
    async () =>
      run(async () => {
        const res = await client.listCatalogs();
        const list = Array.isArray(res) ? res : (res.data ?? []);
        return list.map((c) => ({ catalogUid: c.catalogUid, title: c.title }));
      }),
  );

  server.registerTool(
    "get_catalog",
    {
      title: "Catalog attributes",
      description: "Get a catalog's attributes and their allowed values (size, paper, color, orientation...). Use them as filters in search_products.",
      inputSchema: { catalogUid: z.string() },
      annotations: RO,
    },
    async ({ catalogUid }) =>
      run(async () => {
        const c = await client.getCatalog(catalogUid);
        const attrs = (c.productAttributes as Record_[] | undefined) ?? [];
        return {
          catalogUid: c.catalogUid,
          title: c.title,
          attributes: Object.fromEntries(
            attrs.map((a) => [
              String(a.productAttributeUid),
              ((a.values as Record_[] | undefined) ?? []).map((v) => `${v.productAttributeValueUid} (${v.title})`),
            ]),
          ),
        };
      }),
  );

  server.registerTool(
    "search_products",
    {
      title: "Search products in a catalog",
      description:
        "Find product UIDs in a catalog, filtered by attributes, e.g. {\"PaperFormat\": [\"A3\"], \"Orientation\": [\"ver\"]}. Returns UIDs with attributes and how many products match each remaining attribute value.",
      inputSchema: {
        catalogUid: z.string(),
        filters: z.record(z.array(z.string())).optional().describe("Attribute UID -> list of value UIDs (from get_catalog)"),
        limit: z.number().int().min(1).max(100).optional().describe("Default 20"),
        offset: z.number().int().min(0).optional(),
      },
      annotations: RO,
    },
    async ({ catalogUid, filters, limit = 20, offset }) =>
      run(async () => {
        const res = await client.searchProducts(catalogUid, { attributeFilters: filters, limit, offset });
        return {
          products: (res.products ?? []).map((p) => ({ productUid: p.productUid, attributes: p.attributes })),
          refineBy: (res.hits as Record_ | undefined)?.attributeHits,
        };
      }),
  );

  server.registerTool(
    "get_product",
    {
      title: "Get product",
      description: "Get one product's attributes, weight, dimensions and supported countries.",
      inputSchema: { productUid: z.string() },
      annotations: RO,
    },
    async ({ productUid }) => run(() => client.getProduct(productUid)),
  );

  server.registerTool(
    "get_product_prices",
    {
      title: "Product price tiers",
      description: "Get a product's base price at each quantity tier, optionally for a country and currency. Shipping is not included (use quote_order).",
      inputSchema: {
        productUid: z.string(),
        country: country.optional(),
        currency: currency.optional(),
        pageCount: z.number().int().optional().describe("Required for multi-page products"),
      },
      annotations: RO,
    },
    async ({ productUid, ...q }) =>
      run(async () => {
        const rows = await client.getPrices(productUid, q);
        return (Array.isArray(rows) ? rows : [])
          .map((r) => ({ quantity: r.quantity, price: r.price, unitPrice: Math.round((Number(r.price) / Number(r.quantity)) * 100) / 100, currency: r.currency, country: r.country }))
          .sort((a, b) => Number(a.quantity) - Number(b.quantity));
      }),
  );

  server.registerTool(
    "check_stock",
    {
      title: "Stock availability by region",
      description: "Check stock of stockable products (frames, hangers, envelopes) per region: US-CA, EU, UK, OC, AS, SA, ROW. Printed items are always non-stockable.",
      inputSchema: { productUids: z.array(z.string()).min(1).max(250) },
      annotations: RO,
    },
    async ({ productUids }) =>
      run(async () => {
        const res = await client.stockAvailability(productUids);
        return Object.fromEntries(
          (res.productsAvailability ?? []).map((p) => [
            String(p.productUid),
            Object.fromEntries(
              ((p.availability as Record_[] | undefined) ?? []).map((a) => [
                String(a.stockRegionUid),
                a.replenishmentDate ? `${a.status} (back ${a.replenishmentDate})` : a.status,
              ]),
            ),
          ]),
        );
      }),
  );

  server.registerTool(
    "list_shipment_methods",
    {
      title: "Shipping methods",
      description: "List Gelato's shipping methods, optionally only those that deliver to a country, with tracking support and type (normal, express, pallet).",
      inputSchema: { country: country.optional() },
      annotations: RO,
    },
    async ({ country: c }) =>
      run(async () => {
        const res = await client.shipmentMethods(c);
        return (res.shipmentMethods ?? []).map((m) => ({
          shipmentMethodUid: m.shipmentMethodUid,
          name: m.name,
          type: m.type,
          hasTracking: m.hasTracking,
          business: m.isBusiness,
          residential: m.isPrivate,
          countries: c ? undefined : (m.supportedCountries as string[] | undefined)?.length,
        }));
      }),
  );

  server.registerTool(
    "quote_order",
    {
      title: "Quote an order",
      description:
        "Price products plus every available shipping option to an address, with delivery dates. Returns the cheapest and fastest option and the cheapest total. Nothing is ordered.",
      inputSchema: {
        recipient: address,
        items: z.array(item).min(1),
        currency,
        orderReferenceId: z.string().optional(),
        customerReferenceId: z.string().optional(),
      },
      annotations: RO,
    },
    async ({ recipient, items, currency: cur, orderReferenceId, customerReferenceId }) =>
      run(async () =>
        summarizeQuote(
          await client.quoteOrder({
            orderReferenceId: orderReferenceId ?? `quote-${Date.now()}`,
            customerReferenceId: customerReferenceId ?? "mcp",
            currency: cur,
            allowMultipleQuotes: true,
            recipient,
            products: withItemRefs(items),
          }),
        ),
      ),
  );

  server.registerTool(
    "create_order",
    {
      title: "Create order (draft by default)",
      description:
        "Create an order. By default it is a DRAFT: nothing is printed or charged until it is confirmed with confirm_draft_order or in the Gelato dashboard. Set draft: false only when the user explicitly wants it sent to production now.",
      inputSchema: {
        orderReferenceId: z.string().describe("Your order ID"),
        customerReferenceId: z.string().describe("Your customer ID"),
        currency,
        items: z.array(item).min(1),
        shippingAddress: address,
        shipmentMethodUid: z.string().optional().describe("normal, standard, express, or a UID from quote_order. Default: cheapest"),
        draft: z.boolean().optional().describe("Default true"),
        metadata: z.record(z.string()).optional().describe("Up to 20 key/value pairs"),
      },
      annotations: WRITE,
    },
    async ({ draft = true, items, metadata, ...o }) =>
      run(async () =>
        compactOrder(
          await client.createOrder({
            ...o,
            orderType: draft ? "draft" : "order",
            items: withItemRefs(items),
            metadata: metadata ? Object.entries(metadata).map(([key, value]) => ({ key, value })) : undefined,
          }),
        ),
      ),
  );

  server.registerTool(
    "search_orders",
    {
      title: "Search orders",
      description:
        "Search orders by status, country, channel (api, shopify, etsy, ui), store, dates or recipient name / reference. Returns rows plus counts by fulfillment status, totals by currency, and orders that need attention (failed, on hold, pending approval, not connected).",
      inputSchema: {
        fulfillmentStatuses: z
          .array(z.enum(["created", "passed", "failed", "canceled", "printed", "shipped", "draft", "pending_approval", "not_connected", "on_hold"]))
          .optional(),
        financialStatuses: z.array(z.string()).optional().describe("draft, pending, invoiced, to_be_invoiced, paid, canceled, partially_refunded, refunded, refused"),
        orderTypes: z.array(z.enum(["order", "draft"])).optional(),
        channels: z.array(z.string()).optional(),
        countries: z.array(country).optional(),
        storeIds: z.array(z.string()).optional(),
        orderReferenceIds: z.array(z.string()).optional(),
        search: z.string().optional().describe("Matches recipient first/last name or your order reference"),
        startDate: z.string().optional().describe("ISO 8601, e.g. 2026-10-01T00:00:00Z"),
        endDate: z.string().optional().describe("ISO 8601"),
        limit: z.number().int().min(1).max(100).optional().describe("Default 50"),
        offset: z.number().int().min(0).optional(),
      },
      annotations: RO,
    },
    async (q) =>
      run(async () => {
        const res = await client.searchOrders(q);
        const orders = res.orders ?? [];
        return { summary: summarizeOrders(orders), orders: orders.map(compactOrderRow) };
      }),
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order with tracking",
      description: "Get one order: status per item, shipping method, estimated delivery, tracking codes and links, and the price breakdown.",
      inputSchema: { orderId: z.string().describe("Gelato order ID"), raw: z.boolean().optional() },
      annotations: RO,
    },
    async ({ orderId, raw }) =>
      run(async () => {
        const o = await client.getOrder(orderId);
        return raw ? o : compactOrder(o);
      }),
  );

  server.registerTool(
    "confirm_draft_order",
    {
      title: "Send a draft order to production",
      description:
        "Convert a draft order into a real order, which starts printing and charging. Optionally replace item print files first. Only use when the user confirms.",
      inputSchema: {
        orderId: z.string(),
        itemFiles: z
          .array(z.object({ itemId: z.string().describe("Gelato order item ID"), files: z.array(file) }))
          .optional()
          .describe("Replace files for these items; other items are kept as they are"),
      },
      annotations: WRITE,
    },
    async ({ orderId, itemFiles }) =>
      run(async () => {
        let items: Record_[] | undefined;
        if (itemFiles?.length) {
          const current = await client.getOrder(orderId);
          const replace = new Map(itemFiles.map((i) => [i.itemId, i.files]));
          items = ((current.items as Record_[] | undefined) ?? []).map((i) =>
            replace.has(String(i.id)) ? { id: i.id, files: replace.get(String(i.id)) } : { id: i.id },
          );
        }
        return compactOrder(await client.patchDraft(orderId, { orderType: "order", items }));
      }),
  );

  server.registerTool(
    "cancel_order",
    {
      title: "Cancel order",
      description: "Cancel an order before it is printed. Fails with 409 once any item is printed or shipped.",
      inputSchema: { orderId: z.string() },
      annotations: DESTRUCTIVE,
    },
    async ({ orderId }) =>
      run(async () => {
        await client.cancelOrder(orderId);
        return { orderId, canceled: true };
      }),
  );

  server.registerTool(
    "list_store_products",
    {
      title: "List e-commerce store products",
      description: "List the products in one of your connected Gelato e-commerce stores (Shopify, Etsy, etc).",
      inputSchema: {
        storeId: z.string(),
        orderBy: z.enum(["createdAt", "updatedAt"]).optional(),
        order: z.enum(["asc", "desc"]).optional(),
        limit: z.number().int().min(1).max(100).optional().describe("Default 50"),
        offset: z.number().int().min(0).optional(),
      },
      annotations: RO,
    },
    async ({ storeId, limit = 50, ...q }) =>
      run(async () => {
        const res = await client.listStoreProducts(storeId, { ...q, limit });
        return (res.products ?? []).map((p) => ({
          id: p.id,
          title: p.title,
          status: p.status,
          publishingError: p.publishingErrorCode ?? undefined,
          externalId: p.externalId,
          variants: Array.isArray(p.variants) ? p.variants.length : undefined,
          previewUrl: p.previewUrl,
          updatedAt: p.updatedAt,
        }));
      }),
  );

  return server;
}
