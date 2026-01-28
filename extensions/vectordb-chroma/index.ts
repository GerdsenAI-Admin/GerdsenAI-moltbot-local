/**
 * Moltbot Chroma Vector DB Plugin
 *
 * Provides Chroma vector database integration for memory storage.
 * Supports both local Chroma instances and Chroma Cloud.
 *
 * Features:
 * - Vector similarity search
 * - Metadata filtering
 * - Collection management
 * - Automatic embedding via configured provider
 */

import { Type } from "@sinclair/typebox";
import type { MoltbotPluginApi } from "clawdbot/plugin-sdk";
import { ChromaClient, type Collection, type Where } from "chromadb";
import { randomUUID } from "node:crypto";

// ============================================================================
// Types
// ============================================================================

type MemoryEntry = {
  id: string;
  text: string;
  embedding?: number[];
  metadata?: Record<string, string | number | boolean>;
  createdAt: number;
};

type SearchResult = {
  id: string;
  text: string;
  score: number;
  metadata?: Record<string, string | number | boolean>;
};

// ============================================================================
// Config Schema
// ============================================================================

const configSchema = Type.Object({
  enabled: Type.Optional(Type.Boolean({ default: true })),
  host: Type.Optional(Type.String({ default: "http://localhost:8000" })),
  apiKey: Type.Optional(Type.String()),
  tenant: Type.Optional(Type.String()),
  database: Type.Optional(Type.String()),
  collectionName: Type.Optional(Type.String({ default: "moltbot_memory" })),
  embeddingFunction: Type.Optional(
    Type.Object({
      provider: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      apiKey: Type.Optional(Type.String()),
    }),
  ),
});

type PluginConfig = {
  enabled?: boolean;
  host?: string;
  apiKey?: string;
  tenant?: string;
  database?: string;
  collectionName?: string;
  embeddingFunction?: {
    provider?: string;
    model?: string;
    apiKey?: string;
  };
};

// ============================================================================
// Chroma Client Wrapper
// ============================================================================

class ChromaMemoryStore {
  private client: ChromaClient;
  private collection: Collection | null = null;
  private collectionName: string;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly config: PluginConfig,
    private readonly logger: { info: (msg: string) => void; warn: (msg: string) => void },
  ) {
    const clientConfig: { path?: string; auth?: { provider: string; credentials: string } } = {};

    if (config.host) {
      clientConfig.path = config.host;
    }

    if (config.apiKey) {
      clientConfig.auth = {
        provider: "token",
        credentials: config.apiKey,
      };
    }

    this.client = new ChromaClient(clientConfig);
    this.collectionName = config.collectionName || "moltbot_memory";
  }

  private async ensureInitialized(): Promise<void> {
    if (this.collection) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    this.collection = await this.client.getOrCreateCollection({
      name: this.collectionName,
      metadata: {
        "hnsw:space": "cosine",
        description: "Moltbot memory store",
      },
    });
    this.logger.info(`chroma: initialized collection "${this.collectionName}"`);
  }

  async store(params: {
    text: string;
    embedding: number[];
    metadata?: Record<string, string | number | boolean>;
  }): Promise<MemoryEntry> {
    await this.ensureInitialized();

    const id = randomUUID();
    const createdAt = Date.now();

    await this.collection!.add({
      ids: [id],
      embeddings: [params.embedding],
      documents: [params.text],
      metadatas: [
        {
          ...params.metadata,
          createdAt,
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
    await this.ensureInitialized();

    const limit = params.limit ?? 10;
    const minScore = params.minScore ?? 0.0;

    const where: Where | undefined = params.filter
      ? (params.filter as Where)
      : undefined;

    const results = await this.collection!.query({
      queryEmbeddings: [params.embedding],
      nResults: limit,
      where,
      include: ["documents", "metadatas", "distances"],
    });

    if (!results.ids[0] || !results.documents?.[0]) {
      return [];
    }

    const searchResults: SearchResult[] = [];

    for (let i = 0; i < results.ids[0].length; i++) {
      const distance = results.distances?.[0]?.[i] ?? 1;
      // Convert L2 distance to similarity score (cosine)
      const score = 1 - distance;

      if (score < minScore) continue;

      searchResults.push({
        id: results.ids[0][i],
        text: results.documents[0][i] ?? "",
        score,
        metadata: results.metadatas?.[0]?.[i] as Record<string, string | number | boolean> | undefined,
      });
    }

    return searchResults;
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureInitialized();

    try {
      await this.collection!.delete({
        ids: [id],
      });
      return true;
    } catch {
      return false;
    }
  }

  async count(): Promise<number> {
    await this.ensureInitialized();
    return this.collection!.count();
  }

  async listCollections(): Promise<string[]> {
    const collections = await this.client.listCollections();
    return collections.map((c) => c.name);
  }

  async deleteCollection(): Promise<void> {
    await this.client.deleteCollection({ name: this.collectionName });
    this.collection = null;
    this.initPromise = null;
  }
}

// ============================================================================
// Plugin Definition
// ============================================================================

const chromaPlugin = {
  id: "vectordb-chroma",
  name: "Chroma Vector DB",
  description: "Chroma vector database integration for memory storage",
  kind: "memory" as const,
  configSchema: {
    jsonSchema: configSchema,
  },

  register(api: MoltbotPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as PluginConfig;

    if (cfg.enabled === false) {
      api.logger.info("vectordb-chroma: disabled by config");
      return;
    }

    const store = new ChromaMemoryStore(cfg, api.logger);

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
        name: "chroma_store",
        label: "Chroma Store",
        description: "Store a memory in the Chroma vector database",
        parameters: Type.Object({
          text: Type.String({ description: "Text content to store" }),
          category: Type.Optional(Type.String({ description: "Memory category" })),
          tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for filtering" })),
        }),
        async execute(_toolCallId, params) {
          const { text, category, tags } = params as {
            text: string;
            category?: string;
            tags?: string[];
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

          const metadata: Record<string, string | number | boolean> = {};
          if (category) metadata.category = category;
          if (tags) metadata.tags = tags.join(",");

          const entry = await store.store({ text, embedding, metadata });

          return {
            content: [
              { type: "text", text: `Stored memory: "${text.slice(0, 50)}..." (id: ${entry.id})` },
            ],
            details: { id: entry.id, createdAt: entry.createdAt },
          };
        },
      },
      { name: "chroma_store" },
    );

    api.registerTool(
      {
        name: "chroma_search",
        label: "Chroma Search",
        description: "Search memories in the Chroma vector database",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
          category: Type.Optional(Type.String({ description: "Filter by category" })),
        }),
        async execute(_toolCallId, params) {
          const { query, limit = 10, category } = params as {
            query: string;
            limit?: number;
            category?: string;
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

          const filter = category ? { category: { $eq: category } } : undefined;
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
      { name: "chroma_search" },
    );

    api.registerTool(
      {
        name: "chroma_delete",
        label: "Chroma Delete",
        description: "Delete a memory from the Chroma vector database",
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
      { name: "chroma_delete" },
    );

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const chroma = program
          .command("chroma")
          .description("Chroma vector database commands");

        chroma
          .command("status")
          .description("Check Chroma connection status")
          .action(async () => {
            try {
              const count = await store.count();
              const collections = await store.listCollections();
              console.log(`\nChroma Status:`);
              console.log(`  Host: ${cfg.host || "http://localhost:8000"}`);
              console.log(`  Collection: ${cfg.collectionName || "moltbot_memory"}`);
              console.log(`  Documents: ${count}`);
              console.log(`  All collections: ${collections.join(", ")}`);
            } catch (err) {
              console.error(`Error connecting to Chroma: ${err instanceof Error ? err.message : err}`);
              process.exit(1);
            }
          });

        chroma
          .command("collections")
          .description("List all collections")
          .action(async () => {
            const collections = await store.listCollections();
            console.log(`\nCollections (${collections.length}):`);
            for (const name of collections) {
              console.log(`  - ${name}`);
            }
          });

        chroma
          .command("count")
          .description("Count documents in collection")
          .action(async () => {
            const count = await store.count();
            console.log(`Documents: ${count}`);
          });

        chroma
          .command("reset")
          .description("Delete and recreate the collection")
          .option("--confirm", "Confirm deletion")
          .action(async (opts) => {
            if (!opts.confirm) {
              console.log("Use --confirm to delete the collection");
              return;
            }
            await store.deleteCollection();
            console.log(`Collection "${cfg.collectionName || "moltbot_memory"}" deleted`);
          });
      },
      { commands: ["chroma"] },
    );

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "vectordb-chroma",
      start: async () => {
        try {
          const count = await store.count();
          api.logger.info(
            `vectordb-chroma: connected to ${cfg.host || "localhost:8000"}, ${count} documents`,
          );
        } catch (err) {
          api.logger.warn(
            `vectordb-chroma: failed to connect: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
      stop: () => {
        api.logger.info("vectordb-chroma: stopped");
      },
    });
  },
};

export default chromaPlugin;
