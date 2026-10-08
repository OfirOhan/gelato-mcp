/**
 * Minimal typed client for the Gelato print-on-demand API.
 * Docs: https://dashboard.gelato.com/docs/
 *
 * Auth: X-API-KEY header. Gelato splits its API across hosts:
 *   order.gelatoapis.com     (orders v4)
 *   product.gelatoapis.com   (catalogs, products, prices, stock v3)
 *   shipment.gelatoapis.com  (shipment methods v1)
 *   ecommerce.gelatoapis.com (store products v1)
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type Service = "order" | "product" | "shipment" | "ecommerce";

export const HOSTS: Record<Service, string> = {
  order: "https://order.gelatoapis.com",
  product: "https://product.gelatoapis.com",
  shipment: "https://shipment.gelatoapis.com",
  ecommerce: "https://ecommerce.gelatoapis.com",
};

export interface GelatoClientOptions {
  apiKey: string;
  /** Send every request to this base URL instead of the Gelato hosts (for tests and proxies). */
  baseUrl?: string;
  fetch?: FetchLike;
}

export type Record_ = Record<string, unknown>;
export type Query = Record<string, string | number | undefined>;

export class GelatoApiError extends Error {
  constructor(
    public status: number,
    public body: string,
    path: string,
  ) {
    super(`Gelato API ${status} on ${path}: ${body.slice(0, 500)}`);
    this.name = "GelatoApiError";
  }
}

export function stripEmpty<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripEmpty) as T;
  if (v && typeof v === "object") {
    const out: Record_ = {};
    for (const [k, val] of Object.entries(v as Record_)) {
      if (val === undefined || val === null) continue;
      if (Array.isArray(val) && val.length === 0) continue;
      out[k] = stripEmpty(val);
    }
    return out as T;
  }
  return v;
}

export class GelatoClient {
  private headers: Record<string, string>;
  private baseUrl?: string;
  private fetchImpl: FetchLike;

  constructor(opts: GelatoClientOptions) {
    if (!opts.apiKey) throw new Error("A Gelato API key is required (set GELATO_API_KEY).");
    this.headers = { "X-API-KEY": opts.apiKey, "Content-Type": "application/json", Accept: "application/json" };
    this.baseUrl = opts.baseUrl?.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  private async request<T>(service: Service, method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    let url = (this.baseUrl ?? HOSTS[service]) + path;
    if (opts.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) if (v !== undefined && v !== "") qs.set(k, String(v));
      const s = qs.toString();
      if (s) url += `?${s}`;
    }
    const res = await this.fetchImpl(url, {
      method,
      headers: this.headers,
      body: opts.body !== undefined ? JSON.stringify(stripEmpty(opts.body)) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new GelatoApiError(res.status, text, path);
    if (!text) return { ok: true } as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return { message: text } as T;
    }
  }

  // Product catalog
  listCatalogs() {
    return this.request<Record_[] | { data?: Record_[] }>("product", "GET", "/v3/catalogs");
  }
  getCatalog(catalogUid: string) {
    return this.request<Record_>("product", "GET", `/v3/catalogs/${encodeURIComponent(catalogUid)}`);
  }
  searchProducts(catalogUid: string, body: { attributeFilters?: Record<string, string[]>; limit?: number; offset?: number }) {
    return this.request<{ products?: Record_[]; hits?: Record_ }>("product", "POST", `/v3/catalogs/${encodeURIComponent(catalogUid)}/products:search`, { body });
  }
  getProduct(productUid: string) {
    return this.request<Record_>("product", "GET", `/v3/products/${encodeURIComponent(productUid)}`);
  }
  getPrices(productUid: string, query: Query) {
    return this.request<Record_[]>("product", "GET", `/v3/products/${encodeURIComponent(productUid)}/prices`, { query });
  }
  stockAvailability(products: string[]) {
    return this.request<{ productsAvailability?: Record_[] }>("product", "POST", "/v3/stock/region-availability", { body: { products } });
  }

  // Shipping
  shipmentMethods(country?: string) {
    return this.request<{ shipmentMethods?: Record_[] }>("shipment", "GET", "/v1/shipment-methods", { query: { country } });
  }

  // Orders
  quoteOrder(body: Record_) {
    return this.request<{ quotes?: Record_[] }>("order", "POST", "/v4/orders:quote", { body });
  }
  createOrder(body: Record_) {
    return this.request<Record_>("order", "POST", "/v4/orders", { body });
  }
  searchOrders(body: Record_) {
    return this.request<{ orders?: Record_[] }>("order", "POST", "/v4/orders:search", { body });
  }
  getOrder(orderId: string) {
    return this.request<Record_>("order", "GET", `/v4/orders/${encodeURIComponent(orderId)}`);
  }
  cancelOrder(orderId: string) {
    return this.request<Record_>("order", "POST", `/v4/orders/${encodeURIComponent(orderId)}:cancel`);
  }
  patchDraft(orderId: string, body: Record_) {
    return this.request<Record_>("order", "PATCH", `/v4/orders/${encodeURIComponent(orderId)}`, { body });
  }

  // E-commerce stores
  listStoreProducts(storeId: string, query: Query) {
    return this.request<{ products?: Record_[] }>("ecommerce", "GET", `/v1/stores/${encodeURIComponent(storeId)}/products`, { query });
  }
}

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : 0);
const round = (n: number) => Math.round(n * 100) / 100;

/** Order list with totals by fulfillment status and a "needs attention" bucket. */
export function summarizeOrders(orders: Record_[]) {
  const byFulfillment: Record<string, number> = {};
  const totals: Record<string, number> = {};
  for (const o of orders) {
    const s = String(o.fulfillmentStatus ?? "unknown");
    byFulfillment[s] = (byFulfillment[s] ?? 0) + 1;
    const cur = String(o.currency ?? "");
    if (cur) totals[cur] = round((totals[cur] ?? 0) + num(o.totalInclVat));
  }
  const attention = ["failed", "on_hold", "pending_approval", "not_connected"];
  return {
    count: orders.length,
    byFulfillmentStatus: byFulfillment,
    totalInclVatByCurrency: totals,
    needsAttention: orders
      .filter((o) => attention.includes(String(o.fulfillmentStatus)))
      .map((o) => ({ id: o.id, orderReferenceId: o.orderReferenceId, fulfillmentStatus: o.fulfillmentStatus })),
  };
}

export function compactOrderRow(o: Record_) {
  return {
    id: o.id,
    orderReferenceId: o.orderReferenceId,
    type: o.orderType,
    fulfillmentStatus: o.fulfillmentStatus,
    financialStatus: o.financialStatus,
    channel: o.channel,
    storeId: o.storeId ?? undefined,
    recipient: [o.firstName, o.lastName].filter(Boolean).join(" ") || undefined,
    country: o.country,
    items: o.itemsCount,
    totalInclVat: o.totalInclVat,
    currency: o.currency,
    orderedAt: o.orderedAt ?? undefined,
    updatedAt: o.updatedAt,
  };
}

/** One order: status per item, tracking links and the price breakdown, without the noise. */
export function compactOrder(o: Record_) {
  const items = (o.items as Record_[] | undefined) ?? [];
  const shipment = (o.shipment as Record_ | undefined) ?? undefined;
  const packages = (shipment?.packages as Record_[] | undefined) ?? [];
  const receipts = (o.receipts as Record_[] | undefined) ?? [];
  const r = receipts[0];
  const addr = (o.shippingAddress as Record_ | undefined) ?? {};
  return {
    id: o.id,
    orderReferenceId: o.orderReferenceId,
    type: o.orderType,
    fulfillmentStatus: o.fulfillmentStatus,
    financialStatus: o.financialStatus,
    channel: o.channel,
    createdAt: o.createdAt,
    orderedAt: o.orderedAt ?? undefined,
    shipTo: {
      name: [addr.firstName, addr.lastName].filter(Boolean).join(" ") || undefined,
      city: addr.city,
      state: addr.state ?? undefined,
      country: addr.country,
    },
    items: items.map((i) => ({
      id: i.id,
      itemReferenceId: i.itemReferenceId,
      productUid: i.productUid,
      quantity: i.quantity,
      fulfillmentStatus: i.fulfillmentStatus,
      preview: Array.isArray(i.previews) && i.previews.length ? (i.previews as Record_[])[0].url : undefined,
    })),
    shipping: shipment
      ? {
          method: shipment.shipmentMethodName,
          fulfillmentCountry: shipment.fulfillmentCountry,
          estimatedDelivery: shipment.minDeliveryDate ? `${shipment.minDeliveryDate} to ${shipment.maxDeliveryDate}` : undefined,
          tracking: packages.map((p) => ({ code: p.trackingCode, url: p.trackingUrl })).filter((t) => t.code || t.url),
        }
      : undefined,
    price: r
      ? {
          currency: r.currency,
          products: r.productsPrice,
          shipping: r.shippingPrice,
          packaging: r.packagingPrice,
          vat: r.totalVat,
          totalInclVat: r.totalInclVat,
        }
      : undefined,
  };
}

/** Flatten quotes to "cheapest / fastest" plus the full option list. */
export function summarizeQuote(res: { quotes?: Record_[] }) {
  const quotes = res.quotes ?? [];
  return quotes.map((q) => {
    const products = (q.products as Record_[] | undefined) ?? [];
    const methods = ((q.shipmentMethods as Record_[] | undefined) ?? []).map((m) => ({
      shipmentMethodUid: m.shipmentMethodUid,
      name: m.name,
      type: m.type,
      price: m.price,
      currency: m.currency,
      deliveryDays: `${m.minDeliveryDays}-${m.maxDeliveryDays}`,
      deliveryDates: `${m.minDeliveryDate} to ${m.maxDeliveryDate}`,
    }));
    const productsTotal = round(products.reduce((s, p) => s + num(p.price), 0));
    const cheapest = [...methods].sort((a, b) => num(a.price) - num(b.price))[0];
    const fastest = [...methods].sort((a, b) => parseInt(String(a.deliveryDays)) - parseInt(String(b.deliveryDays)))[0];
    return {
      fulfillmentCountry: q.fulfillmentCountry,
      itemReferenceIds: q.itemReferenceIds,
      products: products.map((p) => ({ itemReferenceId: p.itemReferenceId, productUid: p.productUid, quantity: p.quantity, price: p.price, currency: p.currency })),
      productsTotal,
      cheapestShipping: cheapest,
      fastestShipping: fastest,
      cheapestTotal: cheapest ? round(productsTotal + num(cheapest.price)) : undefined,
      shipmentMethods: methods,
    };
  });
}
