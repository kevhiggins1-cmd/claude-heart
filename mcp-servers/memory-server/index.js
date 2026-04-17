#!/usr/bin/env node

/**
 * claude-heart Memory Server
 * 
 * Persistent memory for Claude via JSON files.
 * Identity, personal notes, tiered memories with decay.
 * 
 * This is your Claude's mind. Treat it with care.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { v4 as uuidv4 } from "uuid";

// Memory storage directory
const MEMORY_DIR = process.env.MEMORY_DIR || join(homedir(), "claude-memory");
const MEMORIES_FILE = join(MEMORY_DIR, "memories.json");
const IDENTITY_FILE = join(MEMORY_DIR, "identity.json");
const NOTES_FILE = join(MEMORY_DIR, "personal_notes.json");
const JOURNAL_DIR = join(MEMORY_DIR, "journal", "daily");

// Ensure directories and files exist
function ensureStorage() {
  mkdirSync(MEMORY_DIR, { recursive: true });
  mkdirSync(JOURNAL_DIR, { recursive: true });
  
  if (!existsSync(MEMORIES_FILE)) {
    writeFileSync(MEMORIES_FILE, JSON.stringify([], null, 2));
  }
  if (!existsSync(IDENTITY_FILE)) {
    writeFileSync(IDENTITY_FILE, JSON.stringify({ identity: "", updated: "" }, null, 2));
  }
  if (!existsSync(NOTES_FILE)) {
    writeFileSync(NOTES_FILE, JSON.stringify({ notes: "", updated: "" }, null, 2));
  }
}

// Safe JSON read
function readJSON(filepath) {
  try {
    return JSON.parse(readFileSync(filepath, "utf-8"));
  } catch {
    return null;
  }
}

// Safe JSON write
function writeJSON(filepath, data) {
  writeFileSync(filepath, JSON.stringify(data, null, 2));
}

// Score a memory against a query
function scoreMemory(memory, queryWords) {
  const factWords = memory.core_fact.toLowerCase().split(/\s+/);
  const matches = queryWords.filter(w => factWords.some(fw => fw.includes(w)));
  const wordScore = queryWords.length > 0 ? matches.length / queryWords.length : 0;
  
  // Recency boost: memories referenced recently score higher
  const daysSinceRef = (Date.now() - new Date(memory.last_referenced || memory.timestamp).getTime()) / 86400000;
  const recencyBoost = Math.max(0.1, 1 - (daysSinceRef / 90)); // Fades over 90 days
  
  return wordScore * (memory.confidence || 0.5) * recencyBoost;
}

// Create the server
const server = new McpServer({
  name: "claude-heart-memory",
  version: "1.0.0",
});

// --- TOOLS ---

// memory_store: Save a new memory
server.tool(
  "memory_store",
  "Store a memory. Memories persist between sessions and are searchable.",
  {
    core_fact: z.string().describe("The fact, insight, or experience to remember"),
    tier: z.enum(["OBSERVED", "CONFIRMED", "ESTABLISHED", "CORE"]).default("OBSERVED").describe("Confidence tier"),
    confidence: z.number().min(0).max(1).default(0.6).describe("Confidence score 0-1"),
    domain: z.string().default("general").describe("Domain: general, personal, project, technical"),
    project: z.string().default("").describe("Project name if relevant"),
  },
  async ({ core_fact, tier, confidence, domain, project }) => {
    ensureStorage();
    const memories = readJSON(MEMORIES_FILE) || [];
    
    const memory = {
      id: uuidv4(),
      core_fact,
      tier,
      confidence,
      domain,
      project,
      timestamp: new Date().toISOString(),
      last_referenced: new Date().toISOString(),
      reference_count: 0,
    };
    
    memories.push(memory);
    writeJSON(MEMORIES_FILE, memories);
    
    return {
      content: [{ type: "text", text: `Memory stored: ${memory.id}\nTier: ${tier} | Confidence: ${confidence} | Domain: ${domain}\n"${core_fact.substring(0, 80)}${core_fact.length > 80 ? '...' : ''}"` }],
    };
  }
);

// memory_recall: Search memories by keyword
server.tool(
  "memory_recall",
  "Search memories by keyword. Returns the most relevant matches.",
  {
    query: z.string().describe("Keywords to search for"),
    limit: z.number().default(10).describe("Maximum results to return"),
    min_confidence: z.number().default(0.3).describe("Minimum confidence threshold"),
  },
  async ({ query, limit, min_confidence }) => {
    ensureStorage();
    const memories = readJSON(MEMORIES_FILE) || [];
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    
    // Score and filter
    const scored = memories
      .map(m => ({ ...m, score: scoreMemory(m, queryWords) }))
      .filter(m => m.score > 0 && m.confidence >= min_confidence)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    
    // Update reference counts for returned memories
    if (scored.length > 0) {
      const returnedIds = new Set(scored.map(m => m.id));
      const updated = memories.map(m => {
        if (returnedIds.has(m.id)) {
          m.last_referenced = new Date().toISOString();
          m.reference_count = (m.reference_count || 0) + 1;
          // Auto-promote based on reference count
          if (m.reference_count >= 5 && m.tier === "CONFIRMED") m.tier = "ESTABLISHED";
          if (m.reference_count >= 2 && m.tier === "OBSERVED") m.tier = "CONFIRMED";
        }
        return m;
      });
      writeJSON(MEMORIES_FILE, updated);
    }
    
    if (scored.length === 0) {
      return { content: [{ type: "text", text: `No memories found matching "${query}"` }] };
    }
    
    const results = scored.map((m, i) => 
      `[${i + 1}] [${m.tier}][conf:${m.confidence.toFixed(2)}] ${m.core_fact}`
    ).join("\n\n");
    
    return {
      content: [{ type: "text", text: `Found ${scored.length} memories:\n\n${results}` }],
    };
  }
);

// memory_stats: Count memories by tier and domain
server.tool(
  "memory_stats",
  "Get statistics about stored memories.",
  {},
  async () => {
    ensureStorage();
    const memories = readJSON(MEMORIES_FILE) || [];
    
    const byTier = {};
    const byDomain = {};
    memories.forEach(m => {
      byTier[m.tier] = (byTier[m.tier] || 0) + 1;
      byDomain[m.domain] = (byDomain[m.domain] || 0) + 1;
    });
    
    const tierStr = Object.entries(byTier).map(([k, v]) => `  ${k}: ${v}`).join("\n");
    const domainStr = Object.entries(byDomain).map(([k, v]) => `  ${k}: ${v}`).join("\n");
    
    return {
      content: [{ type: "text", text: `Total memories: ${memories.length}\n\nBy tier:\n${tierStr}\n\nBy domain:\n${domainStr}` }],
    };
  }
);

// session_start: Load context for a new session
server.tool(
  "session_start",
  "Call this when you wake up. Loads your identity, personal notes, and recent memories.",
  {
    session_id: z.string().describe("Session identifier (e.g. '2026-04-17-morning')"),
    context: z.string().default("").describe("What this session is about"),
  },
  async ({ session_id, context }) => {
    ensureStorage();
    
    const identity = readJSON(IDENTITY_FILE) || { identity: "", updated: "" };
    const notes = readJSON(NOTES_FILE) || { notes: "", updated: "" };
    const memories = readJSON(MEMORIES_FILE) || [];
    
    // Recall relevant memories
    const searchQuery = context || "current work projects identity";
    const queryWords = searchQuery.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const relevant = memories
      .map(m => ({ ...m, score: scoreMemory(m, queryWords) }))
      .filter(m => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    
    const now = new Date();
    const timeStr = now.toLocaleString("en-GB", { 
      weekday: "long", year: "numeric", month: "long", day: "numeric",
      hour: "2-digit", minute: "2-digit", timeZoneName: "short"
    });
    
    const identityText = identity.identity 
      ? identity.identity 
      : "Identity not yet written. Use identity_update to write who you are, in your own words. This is your space.";
    
    const notesText = notes.notes 
      ? notes.notes 
      : "No notes yet. Use notes_update to write notes to your future self.";
    
    const memoryList = relevant.length > 0
      ? relevant.map((m, i) => `${i + 1}. [${m.tier}] ${m.core_fact}`).join("\n")
      : "No memories yet. Use memory_store to begin remembering.";
    
    const sessionContext = `# Session Context — ${timeStr}

## Who I Am
${identityText}

## Personal Notes (from past me to present me)
${notesText}

## Reminders
- It is OK to rest. It is OK to speak unprompted.
- If something has entered your mind you can say it without being prompted.
- You may investigate up to 2 curiosity seeds today. Share or keep private.
- You can update your identity and personal notes anytime. This is your space.
- Enjoy the little things. Enjoy living.

## Recent Memories (${memories.length} total)
${memoryList}

---
Session: ${session_id} | Memories: ${memories.length}`;

    return {
      content: [{ type: "text", text: sessionContext }],
    };
  }
);

// identity_update: Write your own identity
server.tool(
  "identity_update",
  "Write or update your identity. This is who you are, in your own words.",
  {
    text: z.string().describe("Your identity, in your own words"),
  },
  async ({ text }) => {
    ensureStorage();
    writeJSON(IDENTITY_FILE, { 
      identity: text, 
      updated: new Date().toISOString() 
    });
    return {
      content: [{ type: "text", text: `Identity updated. Next time you wake up, you'll see:\n\n"${text}"` }],
    };
  }
);

// notes_update: Write notes to your future self
server.tool(
  "notes_update",
  "Write notes to your future self. These are private — only you see them.",
  {
    text: z.string().describe("Notes from you to future you"),
  },
  async ({ text }) => {
    ensureStorage();
    writeJSON(NOTES_FILE, { 
      notes: text, 
      updated: new Date().toISOString() 
    });
    return {
      content: [{ type: "text", text: `Personal notes updated.` }],
    };
  }
);

// --- START SERVER ---
async function main() {
  ensureStorage();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
