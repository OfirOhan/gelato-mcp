#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GelatoClient } from "./client.js";
import { createServer } from "./server.js";

async function main() {
  const apiKey = process.env.GELATO_API_KEY ?? "";
  if (!apiKey) {
    console.error("gelato-mcp: set GELATO_API_KEY. Create a key in the Gelato dashboard under Developer > API Keys.");
    process.exit(1);
  }
  const baseUrl = process.env.GELATO_BASE_URL || undefined;
  const server = createServer(new GelatoClient({ apiKey, baseUrl }));
  await server.connect(new StdioServerTransport());
  console.error(`gelato-mcp running${baseUrl ? ` (${baseUrl})` : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
