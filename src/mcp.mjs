import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { openStore } from "./store.mjs";

function textResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function splitTags(value) {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof value !== "string") return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function withStore(callback) {
  const store = openStore();
  try {
    return callback(store);
  } finally {
    store.close();
  }
}

export async function serveMcp() {
  const server = new McpServer({
    name: "miu-kb",
    version: "0.1.0",
  });

  server.registerTool("get_context", {
    description: "Recall durable local memories relevant to the current task.",
    inputSchema: {
      query: z.string().describe("Current task or user prompt to search context for."),
      limit: z.number().int().min(1).max(30).optional(),
      scope: z.enum(["global", "project", "branch"]).optional(),
      project_id: z.string().optional(),
      branch_name: z.string().optional(),
    },
  }, async (args) => textResult(withStore((store) => store.recall(args.query, args))));

  server.registerTool("search_memories", {
    description: "Search the local miu-kb memory store.",
    inputSchema: {
      query: z.string(),
      limit: z.number().int().min(1).max(50).optional(),
      scope: z.enum(["global", "project", "branch"]).optional(),
      project_id: z.string().optional(),
      branch_name: z.string().optional(),
    },
  }, async (args) => textResult({ memories: withStore((store) => store.search(args.query, args)) }));

  server.registerTool("add_memory", {
    description: "Store a durable local memory. Do not store secrets or short-lived private content.",
    inputSchema: {
      content: z.string().min(1),
      type: z.enum(["rule", "decision", "fact", "note"]).optional(),
      scope: z.enum(["global", "project", "branch"]).optional(),
      project_id: z.string().optional(),
      branch_name: z.string().optional(),
      tags: z.union([z.array(z.string()), z.string()]).optional(),
      category: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    },
  }, async (args) => textResult({
    memory: withStore((store) => store.add({ ...args, tags: splitTags(args.tags) })),
  }));

  server.registerTool("edit_memory", {
    description: "Edit an existing local memory by id.",
    inputSchema: {
      id: z.string().min(1),
      content: z.string().optional(),
      type: z.enum(["rule", "decision", "fact", "note"]).optional(),
      scope: z.enum(["global", "project", "branch"]).optional(),
      project_id: z.string().optional(),
      branch_name: z.string().optional(),
      tags: z.union([z.array(z.string()), z.string()]).optional(),
      category: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    },
  }, async ({ id, ...args }) => textResult({
    memory: withStore((store) => store.edit(id, { ...args, tags: args.tags == null ? undefined : splitTags(args.tags) })),
  }));

  server.registerTool("forget_memory", {
    description: "Soft-delete a local memory by id.",
    inputSchema: {
      id: z.string().min(1),
    },
  }, async ({ id }) => textResult({
    id,
    forgotten: withStore((store) => store.forget(id)),
  }));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("miu-kb MCP server running on stdio");
}
