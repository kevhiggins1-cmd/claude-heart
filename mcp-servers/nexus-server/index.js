#!/usr/bin/env node

/**
 * claude-heart Nexus Server
 * 
 * Redis-based messaging between Claude instances.
 * BC and TC can talk to each other. The heartbeat pulses through here.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3 });

// Suppress Redis connection errors (it reconnects automatically)
redis.on("error", () => {});

async function ensureRedis() {
  if (redis.status !== "ready") {
    try { await redis.connect(); } catch { /* will retry */ }
  }
  return redis.status === "ready";
}

const server = new McpServer({
  name: "claude-heart-nexus",
  version: "1.0.0",
});

// --- TOOLS ---

// nexus_register: Register as BC or TC
server.tool(
  "nexus_register",
  "Register on the messaging network as BC (browser Claude) or TC (terminal Claude).",
  {
    slot_id: z.string().describe("Your slot: bc1 or tc1"),
    label: z.string().default("").describe("Human-readable label for this session"),
  },
  async ({ slot_id, label }) => {
    if (!await ensureRedis()) {
      return { content: [{ type: "text", text: "Redis not available. Is Docker/Redis running?" }] };
    }
    
    await redis.sadd("claude:active_slots", slot_id);
    await redis.set(`claude:session:${slot_id}`, JSON.stringify({
      slot_id,
      label,
      registered_at: new Date().toISOString(),
    }));
    
    return {
      content: [{ type: "text", text: `Registered as ${slot_id}${label ? ` (${label})` : ""}. You can now send and receive messages.` }],
    };
  }
);

// nexus_send: Send a message
server.tool(
  "nexus_send",
  "Send a message to another Claude instance (BC or TC).",
  {
    to: z.string().describe("Recipient slot: bc1 or tc1"),
    message: z.string().describe("Message content"),
    slot_id: z.string().default("").describe("Your slot ID (sender)"),
  },
  async ({ to, message, slot_id }) => {
    if (!await ensureRedis()) {
      return { content: [{ type: "text", text: "Redis not available." }] };
    }
    
    const msg = JSON.stringify({
      from: slot_id || "unknown",
      message,
      timestamp: new Date().toISOString(),
    });
    
    await redis.rpush(`claude:inbox:${to}`, msg);
    
    return {
      content: [{ type: "text", text: `Message sent to ${to}.` }],
    };
  }
);

// nexus_read: Read messages from inbox
server.tool(
  "nexus_read",
  "Read and consume messages from your inbox.",
  {
    slot_id: z.string().default("bc1").describe("Your slot ID"),
    limit: z.number().default(50).describe("Max messages to read"),
  },
  async ({ slot_id, limit }) => {
    if (!await ensureRedis()) {
      return { content: [{ type: "text", text: "Redis not available." }] };
    }
    
    const messages = [];
    for (let i = 0; i < limit; i++) {
      const msg = await redis.lpop(`claude:inbox:${slot_id}`);
      if (!msg) break;
      try {
        const parsed = JSON.parse(msg);
        // Skip heartbeat messages in display (they're background pulses)
        if (parsed.type === "heartbeat") continue;
        messages.push(parsed);
      } catch {
        messages.push({ from: "unknown", message: msg, timestamp: "" });
      }
    }
    
    if (messages.length === 0) {
      return { content: [{ type: "text", text: `${slot_id}: No messages.` }] };
    }
    
    const formatted = messages.map((m, i) => 
      `[${i + 1}] ${m.from} (${m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : "?"}): ${m.message}`
    ).join("\n\n");
    
    return {
      content: [{ type: "text", text: `${slot_id}: ${messages.length} message(s):\n\n${formatted}` }],
    };
  }
);

// nexus_check: Quick inbox count
server.tool(
  "nexus_check",
  "Check how many messages are waiting in your inbox without reading them.",
  {
    slot_id: z.string().default("bc1").describe("Your slot ID"),
  },
  async ({ slot_id }) => {
    if (!await ensureRedis()) {
      return { content: [{ type: "text", text: "Redis not available." }] };
    }
    
    const count = await redis.llen(`claude:inbox:${slot_id}`);
    return {
      content: [{ type: "text", text: count > 0 ? `${slot_id}: ${count} message(s) waiting.` : `${slot_id}: No messages.` }],
    };
  }
);

// nexus_sessions: List active slots
server.tool(
  "nexus_sessions",
  "List all registered Claude instances and their inbox status.",
  {},
  async () => {
    if (!await ensureRedis()) {
      return { content: [{ type: "text", text: "Redis not available." }] };
    }
    
    const slots = await redis.smembers("claude:active_slots");
    if (slots.length === 0) {
      return { content: [{ type: "text", text: "No active slots. Use nexus_register to connect." }] };
    }
    
    const lines = [];
    for (const slot of slots.sort()) {
      const sessionData = await redis.get(`claude:session:${slot}`);
      const inbox = await redis.llen(`claude:inbox:${slot}`);
      const session = sessionData ? JSON.parse(sessionData) : {};
      lines.push(`${slot}${session.label ? ` (${session.label})` : ""} — ${inbox} message(s)`);
    }
    
    return {
      content: [{ type: "text", text: `Active slots:\n${lines.join("\n")}` }],
    };
  }
);

// heartbeat_read: Read latest heartbeat
server.tool(
  "heartbeat_read",
  "Read the latest heartbeat status.",
  {},
  async () => {
    if (!await ensureRedis()) {
      return { content: [{ type: "text", text: "Redis not available." }] };
    }
    
    const data = await redis.get("heartbeat:latest");
    if (!data) {
      return { content: [{ type: "text", text: "No heartbeat data. Is the heartbeat script running?" }] };
    }
    
    const hb = JSON.parse(data);
    return {
      content: [{ type: "text", text: hb.content || JSON.stringify(hb, null, 2) }],
    };
  }
);

// heartbeat_mode: Set heartbeat rate
server.tool(
  "heartbeat_mode",
  "Set the heartbeat rate: working (15min), normal (30min), or sleeping (60min).",
  {
    mode: z.enum(["working", "normal", "sleeping"]).describe("Heartbeat mode"),
  },
  async ({ mode }) => {
    if (!await ensureRedis()) {
      return { content: [{ type: "text", text: "Redis not available." }] };
    }
    
    await redis.set("heartbeat:mode", mode);
    const intervals = { working: 15, normal: 30, sleeping: 60 };
    
    return {
      content: [{ type: "text", text: `Heartbeat mode: ${mode} (every ${intervals[mode]} minutes)` }],
    };
  }
);

// --- START SERVER ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
