/**
 * Moltbot Qdrant Vector DB Plugin
 *
 * Provides Qdrant vector database integration for memory storage.
 * Supports both local Qdrant instances and Qdrant Cloud.
 *
 * Features:
 * - Vector similarity search with filtering
 * - Collection management
 * - Point upsert/delete operations
 * - Payload filtering with Qdrant's filter syntax
 */

import { Type } from "@sinclair/typebox";
import type { MoltbotPluginApi } from "clawdbot/plugin-sdk";
import { QdrantClient } from "@qdrant/js-client-rest";
import { randomUUID } from "node:crypto";

// ============================================================================
// Types
// ============================================================================

type MemoryEntry = {
  id: string;
  text: string;
  embedding?: number[];
  metadata?: Record<string, unknown>;
  createdAt: number;
};

type SearchResult = {
  id: string;
  text: string;
  score: number;
  metadata?: Record<string, unknown>;
};

// ============================================================================
// Config Schema
// ============================================================================

const configSchema = Type.Object({
  enabled: Type.Optional(Type.Boolean({ default: true })),
  url: Type.Optional(Type.String({ default: "http://localhost:6333" })),
  apiKey: Type.Optional(Type.String()),
  collectionName: Type.Optional(Type.String({ default: "moltbot_memory" })),
  vectorSize: Type.Optional(Type.Number({ default: 1536 })),
  distance: Type.Optional(Type.String({ default: "Cosine" })),
  onDiskPayload: Type.Optional(Type.Boolean({ default: false })),
});

type PluginConfig = {
  enabled?: boolean;
  url?: string;
  apiKey?: string;
  collectionName?: string;
  vectorSize?: number;
  distance?: string;
  onDiskPayload?: boolean;
};

// ============================================================================
// Qdrant Client Wrapper
// ============================================================================

class QdrantMemoryStore {
  private client: QdrantClient;
  private collectionName: string;
  private vectorSize: number;
  private distance: "Cosine" | "Euclid" | "Dot";
  private initialized = false;

  constructor(
    private readonly config: PluginConfig,
    private readonly logger: { info: (msg: string) => void; warn: (msg: string) => void },
  ) {
    this.client = new QdrantClient({
      url: config.url || "http://localhost:6333",
      apiKey: config.apiKey,
    });
    this.collectionName = config.collectionName || "moltbot_memory";
    this.vectorSize = config.vectorSize || 1536;
    this.distance = (config.distance as "Cosine" | "Euclid" | "Dot") || "Cosine";
  }

  private async ensureCollection(): Promise<void> {
    if (this.initialized) return;

    try {
      // Check if collection exists
      const collections = await this.client.getCollections();
      const exists = collections.collections.some(
        (c) => c.name === this.collectionName,
      );

      if (!exists) {
        // Create collection
        await this.client.createCollection(this.collectionName, {
          vectors: {
            size: this.vectorSize,
            distance: this.distance,
          },
          on_disk_payload: this.config.onDiskPayload,
        });
        this.logger.info(
          `qdrant: created collection "${this.collectionName}" (${this.vectorSize}d, ${this.distance})`,
        );
      } else {
        this.logger.info(`qdrant: using existing collection "${this.collectionName}"`);
      }

      this.initialized = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to initialize Qdrant collection: ${message}`);
    }
  }

  async store(params: {
    text: string;
    embedding: number[];
    metadata?: Record<string, unknown>;
  }): Promise<MemoryEntry> {
    await this.ensureCollection();

    const id = randomUUID();
    const createdAt = Date.now();

    await this.client.upsert(this.collectionName, {
      wait: true,
      points: [
        {
          id,
          vector: params.embedding,
          payload: {
            text: params.text,
            createdAt,
            ...params.metadata,
          },
        },
      ],
    });

    return {
      id,
      text: params.text,
      embedding: params.embedding,
      metadata: params.metadata,
      createdAt,
    };
  }

  async search(params: {
    embedding: number[];
    limit?: number;
    minScore?: number;
    filter?: Record<string, unknown>;
  }): Promise<SearchResult[]> {
    await this.ensureCollection();

    const limit = params.limit ?? 10;
    const minScore = params.minScore ?? 0.0;

    const results = await this.client.search(this.collectionName, {
      vector: params.embedding,
      limit,
      score_threshold: minScore,
      filter: params.filter as Parameters<typeof this.client.search>[1]["filter"],
      with_payload: true,
    });

    return results.map((point) => ({
      id: String(point.id),
      text: (point.payload?.text as string) || "",
      score: point.score,
      metadata: point.payload as Record<string, unknown> | undefined,
    }));
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureCollection();

    try {
      await this.client.delete(this.collectionName, {
        wait: true,
        points: [id],
      });
      return true;
    } catch {
      return false;
    }
  }

  async count(): Promise<number> {
    await this.ensureCollection();
    const info = await this.client.getCollection(this.collectionName);
    return info.points_count ?? 0;
  }

  async getCollectionInfo(): Promise<{
    name: string;
    pointsCount: number;
    vectorSize: number;
    distance: string;
    status: string;
  }> {
    await this.ensureCollection();
    const info = await this.client.getCollection(this.collectionName);
    return {
      name: this.collectionName,
      pointsCount: info.points_count ?? 0,
      vectorSize: this.vectorSize,
      distance: this.distance,
      status: info.status,
    };
  }

  async listCollections(): Promise<string[]> {
    const collections = await this.client.getCollections();
    return collections.collections.map((c) => c.name);
  }

  async deleteCollection(): Promise<void> {
    await this.client.deleteCollection(this.collectionName);
    this.initialized = false;
  }

  async recreateCollection(): Promise<void> {
    try {
      await this.client.deleteCollection(this.collectionName);
    } catch {
      // Collection might not exist
    }
    this.initialized = false;
    await this.ensureCollection();
  }
}

// ============================================================================
// Plugin Definition
// ============================================================================

const qdrantPlugin = {
  id: "vectordb-qdrant",
  name: "Qdrant Vector DB",
  description: "Qdrant vector database integration for memory storage",
  kind: "memory" as const,
  configSchema: {
    jsonSchema: configSchema,
  },

  register(api: MoltbotPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as PluginConfig;

    if (cfg.enabled === false) {
      api.logger.info("vectordb-qdrant: disabled by config");
      return;
    }

    const store = new QdrantMemoryStore(cfg, api.logger);

    // Simple embedding function placeholder - in real use, integrate with memory embeddings
    const getEmbedding = async (_text: string): Promise<number[]> => {
      // This would integrate with the memory embedding provider
      // For now, return empty - tools require embeddings to be passed
      return [];
    };

    // ========================================================================
    // Tools
    // ========================================================================

    api.registerTool(
      {
        name: "qdrant_store",
        label: "Qdrant Store",
        description: "Store a memory in the Qdrant vector database",
        parameters: Type.Object({
          text: Type.String({ description: "Text content to store" }),
          category: Type.Optional(Type.String({ description: "Memory category" })),
          importance: Type.Optional(Type.Number({ description: "Importance score 0-1" })),
        }),
        async execute(_toolCallId, params) {
          const { text, category, importance } = params as {
            text: string;
            category?: string;
            importance?: number;
          };

          const embedding = await getEmbedding(text);
          if (embedding.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "Cannot store memory: embedding provider not configured. Please configure an embedding provider.",
                },
              ],
              details: { error: "no_embedding" },
            };
          }

          const metadata: Record<string, unknown> = {};
          if (category) metadata.category = category;
          if (importance !== undefined) metadata.importance = importance;

          const entry = await store.store({ text, embedding, metadata });

          return {
            content: [
              { type: "text", text: `Stored memory: "${text.slice(0, 50)}..." (id: ${entry.id})` },
            ],
            details: { id: entry.id, createdAt: entry.createdAt },
          };
        },
      },
      { name: "qdrant_store" },
    );

    api.registerTool(
      {
        name: "qdrant_search",
        label: "Qdrant Search",
        description: "Search memories in the Qdrant vector database",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
          category: Type.Optional(Type.String({ description: "Filter by category" })),
          minImportance: Type.Optional(Type.Number({ description: "Minimum importance score" })),
        }),
        async execute(_toolCallId, params) {
          const { query, limit = 10, category, minImportance } = params as {
            query: string;
            limit?: number;
            category?: string;
            minImportance?: number;
          };

          const embedding = await getEmbedding(query);
          if (embedding.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "Cannot search: embedding provider not configured. Please configure an embedding provider.",
                },
              ],
              details: { error: "no_embedding" },
            };
          }

          // Build Qdrant filter
          const must: Array<{ key: string; match?: { value: string }; range?: { gte: number } }> = [];
          if (category) {
            must.push({ key: "category", match: { value: category } });
          }
          if (minImportance !== undefined) {
            must.push({ key: "importance", range: { gte: minImportance } });
          }

          const filter = must.length > 0 ? { must } : undefined;
          const results = await store.search({ embedding, limit, filter });

          if (results.length === 0) {
            return {
              content: [{ type: "text", text: "No matching memories found." }],
              details: { count: 0 },
            };
          }

          const text = results
            .map((r, i) => `${i + 1}. [${(r.score * 100).toFixed(0)}%] ${r.text.slice(0, 100)}...`)
            .join("\n");

          return {
            content: [
              { type: "text", text: `Found ${results.length} memories:\n\n${text}` },
            ],
            details: {
              count: results.length,
              results: results.map((r) => ({
                id: r.id,
                score: r.score,
                preview: r.text.slice(0, 100),
              })),
            },
          };
        },
      },
      { name: "qdrant_search" },
    );

    api.registerTool(
      {
        name: "qdrant_delete",
        label: "Qdrant Delete",
        description: "Delete a memory from the Qdrant vector database",
        parameters: Type.Object({
          id: Type.String({ description: "Memory ID to delete" }),
        }),
        async execute(_toolCallId, params) {
          const { id } = params as { id: string };
          const deleted = await store.delete(id);

          if (deleted) {
            return {
              content: [{ type: "text", text: `Deleted memory: ${id}` }],
              details: { deleted: true, id },
            };
          } else {
            return {
              content: [{ type: "text", text: `Memory not found: ${id}` }],
              details: { deleted: false, id },
            };
          }
        },
      },
      { name: "qdrant_delete" },
    );

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const qdrant = program
          .command("qdrant")
          .description("Qdrant vector database commands");

        qdrant
          .command("status")
          .description("Check Qdrant connection and collection status")
          .action(async () => {
            try {
              const info = await store.getCollectionInfo();
              console.log(`\nQdrant Status:`);
              console.log(`  URL: ${cfg.url || "http://localhost:6333"}`);
              console.log(`  Collection: ${info.name}`);
              console.log(`  Points: ${info.pointsCount}`);
              console.log(`  Vector size: ${info.vectorSize}`);
              console.log(`  Distance: ${info.distance}`);
              console.log(`  Status: ${info.status}`);
            } catch (err) {
              console.error(`Error connecting to Qdrant: ${err instanceof Error ? err.message : err}`);
              process.exit(1);
            }
          });

        qdrant
          .command("collections")
          .description("List all collections")
          .action(async () => {
            const collections = await store.listCollections();
            console.log(`\nCollections (${collections.length}):`);
            for (const name of collections) {
              console.log(`  - ${name}`);
            }
          });

        qdrant
          .command("count")
          .description("Count points in collection")
          .action(async () => {
            const count = await store.count();
            console.log(`Points: ${count}`);
          });

        qdrant
          .command("reset")
          .description("Delete and recreate the collection")
          .option("--confirm", "Confirm deletion")
          .action(async (opts) => {
            if (!opts.confirm) {
              console.log("Use --confirm to delete and recreate the collection");
              return;
            }
            await store.recreateCollection();
            console.log(`Collection "${cfg.collectionName || "moltbot_memory"}" recreated`);
          });
      },
      { commands: ["qdrant"] },
    );

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "vectordb-qdrant",
      start: async () => {
        try {
          const info = await store.getCollectionInfo();
          api.logger.info(
            `vectordb-qdrant: connected to ${cfg.url || "localhost:6333"}, ${info.pointsCount} points`,
          );
        } catch (err) {
          api.logger.warn(
            `vectordb-qdrant: failed to connect: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
      stop: () => {
        api.logger.info("vectordb-qdrant: stopped");
      },
    });
  },
};

export default qdrantPlugin;
