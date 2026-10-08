# Gelato MCP Server

[![CI](https://github.com/OfirOhan/gelato-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/OfirOhan/gelato-mcp/actions/workflows/ci.yml)
![MCP](https://img.shields.io/badge/MCP-compatible-blue)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

A [Model Context Protocol](https://modelcontextprotocol.io) server for **[Gelato](https://www.gelato.com)**, the print-on-demand network. It lets Claude, Cursor, ChatGPT and other AI agents browse the product catalog, compare prices and shipping options, place draft orders, and track what's printing, shipped or stuck.

> **Unofficial.** This is a community project and is not affiliated with Gelato. It was built from Gelato's public API documentation.

## What you can ask your agent

- "Find a vertical A3 poster on matte paper and tell me the unit price at 1, 10 and 50 copies in the US."
- "Quote 2 of these posters to this address in Brooklyn. What's the cheapest and the fastest way to ship?"
- "Create a draft order for that, with my artwork at this URL. Don't send it to print yet."
- "Show me last week's orders. Any failed, on hold or waiting for approval?"
- "Where is order A-1042? Give me the tracking link."
- "Is the black wooden frame in stock in the UK and EU?"

## Tools

| Tool | What it does | Writes? |
|---|---|---|
| `list_catalogs` | Product catalogs (posters, apparel, mugs, cards, wall art...) | No |
| `get_catalog` | A catalog's attributes and allowed values | No |
| `search_products` | Product UIDs by attribute filters, with counts to refine the search | No |
| `get_product` | One product's attributes, weight, dimensions, countries | No |
| `get_product_prices` | Price per quantity tier, with unit price | No |
| `check_stock` | Stock by region for frames, hangers and other stockable items | No |
| `list_shipment_methods` | Shipping methods, optionally for one destination country | No |
| `quote_order` | Products plus every shipping option to an address. **Returns the cheapest, the fastest and the cheapest total** | No |
| `create_order` | Create an order. **Draft by default**, so nothing prints until confirmed | Yes |
| `confirm_draft_order` | Send a draft to production, optionally swapping print files | Yes |
| `cancel_order` | Cancel before printing | Yes (destructive) |
| `search_orders` | Orders by status, channel, store, country, dates, name. **Returns counts, totals and orders needing attention** | No |
| `get_order` | One order with item status, delivery estimate, tracking links and price breakdown | No |
| `list_store_products` | Products in a connected Shopify/Etsy/etc store | No |

The server smooths over the parts an LLM tends to trip on: Gelato's API spans four hosts (order, product, shipment, ecommerce), quotes come back as nested shipping options, and orders are large objects. Tools return compact, decision-ready answers instead (use `raw: true` on `get_order` for the full payload). Orders are created as drafts unless you ask otherwise, and write tools carry MCP annotations, so clients can ask before running them.

## Setup

1. In the Gelato dashboard, create an API key (Developer > API Keys).
2. Build it:

```bash
git clone https://github.com/OfirOhan/gelato-mcp.git
cd gelato-mcp && npm install && npm run build
```

### Claude Desktop

Add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gelato": {
      "command": "node",
      "args": ["/absolute/path/to/gelato-mcp/dist/index.js"],
      "env": { "GELATO_API_KEY": "..." }
    }
  }
}
```

### Claude Code / Cursor / other MCP clients

```bash
claude mcp add gelato -e GELATO_API_KEY=... -- node /path/to/gelato-mcp/dist/index.js
```

For Cursor and other clients, use the same command with the variable in the environment.

| Variable | Default | Notes |
|---|---|---|
| `GELATO_API_KEY` | (required) | API key from the Gelato dashboard |
| `GELATO_BASE_URL` | Gelato's hosts | Send all requests to one base URL (for testing) |

## Development

```bash
npm install
npm test   # builds, runs unit tests and an end-to-end MCP stdio test against a fake Gelato API
```

The tests run on Node 20, 22 and 24 in CI.

## Author

Built by [Ofir Ohana](https://github.com/OfirOhan), an AI agents engineer. Issues and PRs are welcome.

## License

MIT
