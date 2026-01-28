/**
 * Moltbot Reranker Plugin
 *
 * Adds reranking capability to RAG queries using:
 * - Cohere Rerank API (cloud)
 * - Jina AI Reranker (cloud)
 * - Local cross-encoder models via OpenAI-compatible API
 * - Hugging Face Inference API
 *
 * Reranking improves retrieval quality by reordering initial results
 * using a more sophisticated cross-encoder model that considers
 * query-document pairs jointly rather than independently.
 */

import { Type } from "@sinclair/typebox";
import type { MoltbotPluginApi } from "clawdbot/plugin-sdk";
import { stringEnum } from "clawdbot/plugin-sdk";

// ============================================================================
// Types
// ============================================================================

type RerankerProvider = "cohere" | "jina" | "local" | "huggingface";

type RerankDocument = {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
};

type RerankResult = {
  id: string;
  text: string;
  score: number;
  originalIndex: number;
  metadata?: Record<string, unknown>;
};

type RerankerClient = {
  rerank: (
    query: string,
    documents: RerankDocument[],
    topK?: number,
  ) => Promise<RerankResult[]>;
};

// Cohere API types
type CohereRerankRequest = {
  model: string;
  query: string;
  documents: string[];
  top_n?: number;
  return_documents?: boolean;
};

type CohereRerankResponse = {
  results: Array<{
    index: number;
    relevance_score: number;
    document?: { text: string };
  }>;
};

// Jina API types
type JinaRerankRequest = {
  model: string;
  query: string;
  documents: string[];
  top_n?: number;
};

type JinaRerankResponse = {
  results: Array<{
    index: number;
    relevance_score: number;
    document: { text: string };
  }>;
};

// Local/HuggingFace cross-encoder types
type CrossEncoderRequest = {
  inputs: Array<{ text: string; text_pair: string }> | string[][];
};

type CrossEncoderResponse = Array<{ score: number } | number[]>;

// ============================================================================
// Reranker Clients
// ============================================================================

function createCohereClient(params: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}): RerankerClient {
  const baseUrl = params.baseUrl || "https://api.cohere.ai/v1";
  const model = params.model || "rerank-english-v3.0";

  return {
    async rerank(query, documents, topK) {
      const request: CohereRerankRequest = {
        model,
        query,
        documents: documents.map((d) => d.text),
        top_n: topK || documents.length,
        return_documents: true,
      };

      const response = await fetch(`${baseUrl}/rerank`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Cohere rerank failed: ${response.status} ${error}`);
      }

      const data = (await response.json()) as CohereRerankResponse;

      return data.results.map((r) => ({
        id: documents[r.index].id,
        text: documents[r.index].text,
        score: r.relevance_score,
        originalIndex: r.index,
        metadata: documents[r.index].metadata,
      }));
    },
  };
}

function createJinaClient(params: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}): RerankerClient {
  const baseUrl = params.baseUrl || "https://api.jina.ai/v1";
  const model = params.model || "jina-reranker-v2-base-multilingual";

  return {
    async rerank(query, documents, topK) {
      const request: JinaRerankRequest = {
        model,
        query,
        documents: documents.map((d) => d.text),
        top_n: topK || documents.length,
      };

      const response = await fetch(`${baseUrl}/rerank`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Jina rerank failed: ${response.status} ${error}`);
      }

      const data = (await response.json()) as JinaRerankResponse;

      return data.results.map((r) => ({
        id: documents[r.index].id,
        text: documents[r.index].text,
        score: r.relevance_score,
        originalIndex: r.index,
        metadata: documents[r.index].metadata,
      }));
    },
  };
}

function createLocalClient(params: {
  baseUrl: string;
  model?: string;
  apiKey?: string;
}): RerankerClient {
  const model = params.model || "BAAI/bge-reranker-base";

  return {
    async rerank(query, documents, topK) {
      // Format for cross-encoder: pairs of [query, document]
      const pairs = documents.map((d) => [query, d.text]);

      const request: CrossEncoderRequest = {
        inputs: pairs,
      };

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (params.apiKey) {
        headers["Authorization"] = `Bearer ${params.apiKey}`;
      }

      // Try different endpoint formats
      let response = await fetch(`${params.baseUrl}/rerank`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, query, documents: documents.map((d) => d.text) }),
      });

      // Fallback to embeddings-style endpoint
      if (!response.ok && response.status === 404) {
        response = await fetch(`${params.baseUrl}/v1/rerank`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model, query, documents: documents.map((d) => d.text) }),
        });
      }

      // Fallback to HF-style inference endpoint
      if (!response.ok && response.status === 404) {
        response = await fetch(params.baseUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(request),
        });
      }

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Local rerank failed: ${response.status} ${error}`);
      }

      const data = (await response.json()) as CrossEncoderResponse | { results: Array<{ index: number; relevance_score: number }> };

      // Handle different response formats
      let scores: number[];
      if (Array.isArray(data)) {
        scores = data.map((item) => {
          if (typeof item === "number") return item;
          if (Array.isArray(item)) return item[0] ?? 0;
          return (item as { score: number }).score ?? 0;
        });
      } else if ("results" in data) {
        // Standard rerank response format
        const results = data.results
          .sort((a, b) => b.relevance_score - a.relevance_score)
          .slice(0, topK || documents.length);

        return results.map((r) => ({
          id: documents[r.index].id,
          text: documents[r.index].text,
          score: r.relevance_score,
          originalIndex: r.index,
          metadata: documents[r.index].metadata,
        }));
      } else {
        throw new Error("Unexpected response format from local reranker");
      }

      // Convert scores to results
      const indexed = documents.map((doc, i) => ({
        id: doc.id,
        text: doc.text,
        score: scores[i] ?? 0,
        originalIndex: i,
        metadata: doc.metadata,
      }));

      // Sort by score descending and take topK
      indexed.sort((a, b) => b.score - a.score);
      return indexed.slice(0, topK || indexed.length);
    },
  };
}

function createHuggingFaceClient(params: {
  apiKey: string;
  model?: string;
}): RerankerClient {
  const model = params.model || "BAAI/bge-reranker-base";
  const baseUrl = `https://api-inference.huggingface.co/models/${model}`;

  return {
    async rerank(query, documents, topK) {
      // HuggingFace cross-encoder expects sentence pairs
      const pairs = documents.map((d) => ({
        text: query,
        text_pair: d.text,
      }));

      const response = await fetch(baseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ inputs: pairs }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`HuggingFace rerank failed: ${response.status} ${error}`);
      }

      const data = (await response.json()) as Array<number | number[]>;

      // Convert scores to results
      const indexed = documents.map((doc, i) => {
        const score = Array.isArray(data[i])
          ? (data[i] as number[])[0] ?? 0
          : (data[i] as number) ?? 0;
        return {
          id: doc.id,
          text: doc.text,
          score,
          originalIndex: i,
          metadata: doc.metadata,
        };
      });

      // Sort by score descending and take topK
      indexed.sort((a, b) => b.score - a.score);
      return indexed.slice(0, topK || indexed.length);
    },
  };
}

// ============================================================================
// Config Schema
// ============================================================================

const PROVIDERS = ["cohere", "jina", "local", "huggingface"] as const;

const configSchema = Type.Object({
  enabled: Type.Optional(Type.Boolean({ default: true })),
  provider: Type.Optional(stringEnum(PROVIDERS)),
  topK: Type.Optional(Type.Number({ default: 10 })),
  minScore: Type.Optional(Type.Number({ default: 0.0 })),
  cohere: Type.Optional(
    Type.Object({
      apiKey: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      baseUrl: Type.Optional(Type.String()),
    }),
  ),
  jina: Type.Optional(
    Type.Object({
      apiKey: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      baseUrl: Type.Optional(Type.String()),
    }),
  ),
  local: Type.Optional(
    Type.Object({
      baseUrl: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      apiKey: Type.Optional(Type.String()),
    }),
  ),
  huggingface: Type.Optional(
    Type.Object({
      apiKey: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
    }),
  ),
});

type PluginConfig = {
  enabled?: boolean;
  provider?: RerankerProvider;
  topK?: number;
  minScore?: number;
  cohere?: { apiKey?: string; model?: string; baseUrl?: string };
  jina?: { apiKey?: string; model?: string; baseUrl?: string };
  local?: { baseUrl?: string; model?: string; apiKey?: string };
  huggingface?: { apiKey?: string; model?: string };
};

// ============================================================================
// Plugin Definition
// ============================================================================

const rerankerPlugin = {
  id: "reranker",
  name: "Reranker",
  description: "Reranking for improved RAG retrieval quality",
  configSchema: {
    jsonSchema: configSchema,
  },

  register(api: MoltbotPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as PluginConfig;

    if (cfg.enabled === false) {
      api.logger.info("reranker: disabled by config");
      return;
    }

    // Create reranker client based on config
    const createClient = (): RerankerClient | null => {
      const provider = cfg.provider || "cohere";

      switch (provider) {
        case "cohere": {
          const apiKey =
            cfg.cohere?.apiKey || process.env.COHERE_API_KEY;
          if (!apiKey) {
            api.logger.warn(
              "reranker: Cohere API key not configured (set COHERE_API_KEY or plugins.reranker.cohere.apiKey)",
            );
            return null;
          }
          return createCohereClient({
            apiKey,
            model: cfg.cohere?.model,
            baseUrl: cfg.cohere?.baseUrl,
          });
        }
        case "jina": {
          const apiKey = cfg.jina?.apiKey || process.env.JINA_API_KEY;
          if (!apiKey) {
            api.logger.warn(
              "reranker: Jina API key not configured (set JINA_API_KEY or plugins.reranker.jina.apiKey)",
            );
            return null;
          }
          return createJinaClient({
            apiKey,
            model: cfg.jina?.model,
            baseUrl: cfg.jina?.baseUrl,
          });
        }
        case "local": {
          const baseUrl =
            cfg.local?.baseUrl || "http://127.0.0.1:8080";
          return createLocalClient({
            baseUrl,
            model: cfg.local?.model,
            apiKey: cfg.local?.apiKey,
          });
        }
        case "huggingface": {
          const apiKey =
            cfg.huggingface?.apiKey || process.env.HF_TOKEN;
          if (!apiKey) {
            api.logger.warn(
              "reranker: HuggingFace API key not configured (set HF_TOKEN or plugins.reranker.huggingface.apiKey)",
            );
            return null;
          }
          return createHuggingFaceClient({
            apiKey,
            model: cfg.huggingface?.model,
          });
        }
        default:
          api.logger.warn(`reranker: unknown provider "${provider}"`);
          return null;
      }
    };

    let client: RerankerClient | null = null;

    const getClient = (): RerankerClient | null => {
      if (!client) {
        client = createClient();
      }
      return client;
    };

    // ========================================================================
    // Tools
    // ========================================================================

    api.registerTool(
      {
        name: "rerank",
        label: "Rerank",
        description:
          "Rerank a list of documents by relevance to a query using a cross-encoder model. Use this to improve search results quality.",
        parameters: Type.Object({
          query: Type.String({ description: "The search query" }),
          documents: Type.Array(
            Type.Object({
              id: Type.String({ description: "Document identifier" }),
              text: Type.String({ description: "Document text content" }),
            }),
            { description: "Documents to rerank" },
          ),
          topK: Type.Optional(
            Type.Number({
              description: "Number of top results to return (default: 10)",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const {
            query,
            documents,
            topK = cfg.topK ?? 10,
          } = params as {
            query: string;
            documents: RerankDocument[];
            topK?: number;
          };

          const reranker = getClient();
          if (!reranker) {
            return {
              content: [
                {
                  type: "text",
                  text: "Reranker not configured. Please set up a reranking provider in config.",
                },
              ],
              details: { error: "not_configured" },
            };
          }

          try {
            const results = await reranker.rerank(query, documents, topK);
            const minScore = cfg.minScore ?? 0.0;
            const filtered = results.filter((r) => r.score >= minScore);

            const text = filtered
              .map(
                (r, i) =>
                  `${i + 1}. [${r.score.toFixed(3)}] ${r.id}: ${r.text.slice(0, 100)}...`,
              )
              .join("\n");

            return {
              content: [
                {
                  type: "text",
                  text: `Reranked ${documents.length} documents, returning top ${filtered.length}:\n\n${text}`,
                },
              ],
              details: {
                count: filtered.length,
                results: filtered.map((r) => ({
                  id: r.id,
                  score: r.score,
                  originalIndex: r.originalIndex,
                })),
              },
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text", text: `Reranking failed: ${message}` }],
              details: { error: message },
            };
          }
        },
      },
      { name: "rerank" },
    );

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const rerank = program
          .command("rerank")
          .description("Reranking commands");

        rerank
          .command("test")
          .description("Test reranker configuration")
          .argument("<query>", "Test query")
          .option("--doc <text...>", "Documents to rerank")
          .action(async (query, opts) => {
            const reranker = getClient();
            if (!reranker) {
              console.error("Reranker not configured");
              process.exit(1);
            }

            const docs: RerankDocument[] = (opts.doc || [
              "The quick brown fox jumps over the lazy dog.",
              "Machine learning is a subset of artificial intelligence.",
              "Paris is the capital of France.",
            ]).map((text: string, i: number) => ({
              id: `doc-${i}`,
              text,
            }));

            console.log(`\nQuery: "${query}"`);
            console.log(`Documents: ${docs.length}`);
            console.log("-".repeat(50));

            try {
              const results = await reranker.rerank(query, docs);
              for (const r of results) {
                console.log(`[${r.score.toFixed(4)}] ${r.text.slice(0, 60)}...`);
              }
            } catch (err) {
              console.error(`Error: ${err instanceof Error ? err.message : err}`);
              process.exit(1);
            }
          });

        rerank
          .command("status")
          .description("Check reranker status")
          .action(() => {
            const provider = cfg.provider || "cohere";
            console.log(`\nReranker Status:`);
            console.log(`  Provider: ${provider}`);
            console.log(`  Enabled: ${cfg.enabled !== false}`);
            console.log(`  Top K: ${cfg.topK ?? 10}`);
            console.log(`  Min Score: ${cfg.minScore ?? 0.0}`);

            const reranker = getClient();
            console.log(`  Ready: ${reranker !== null}`);
          });
      },
      { commands: ["rerank"] },
    );

    // ========================================================================
    // Hooks (integrate with memory search)
    // ========================================================================

    // Hook into memory search results to rerank them
    api.on("after_tool_call", async (event, _ctx) => {
      if (event.toolName !== "memory_search" && event.toolName !== "memory_recall") {
        return;
      }

      // Get the result
      const result = event.result as {
        details?: {
          results?: Array<{ path: string; snippet: string; score: number }>;
          memories?: Array<{ id: string; text: string; score: number }>;
        };
      };

      if (!result?.details) return;

      const reranker = getClient();
      if (!reranker) return;

      // Extract documents from memory search results
      const docs: RerankDocument[] = [];
      if (result.details.results) {
        for (const r of result.details.results) {
          docs.push({
            id: r.path,
            text: r.snippet,
            metadata: { originalScore: r.score },
          });
        }
      }
      if (result.details.memories) {
        for (const m of result.details.memories) {
          docs.push({
            id: m.id,
            text: m.text,
            metadata: { originalScore: m.score },
          });
        }
      }

      if (docs.length < 2) return; // No point reranking 1 or 0 results

      try {
        // Get query from params
        const query = (event.params as { query?: string })?.query;
        if (!query) return;

        const reranked = await reranker.rerank(query, docs, cfg.topK ?? 10);
        api.logger.info?.(
          `reranker: reranked ${docs.length} memory results`,
        );

        // Update the details with reranked results
        if (result.details.results) {
          result.details.results = reranked.map((r) => ({
            path: r.id,
            snippet: r.text,
            score: r.score,
            reranked: true,
          })) as typeof result.details.results;
        }
        if (result.details.memories) {
          result.details.memories = reranked.map((r) => ({
            id: r.id,
            text: r.text,
            score: r.score,
            reranked: true,
          })) as typeof result.details.memories;
        }
      } catch (err) {
        api.logger.warn(
          `reranker: failed to rerank memory results: ${String(err)}`,
        );
      }
    });

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "reranker",
      start: () => {
        const provider = cfg.provider || "cohere";
        const reranker = getClient();
        if (reranker) {
          api.logger.info(
            `reranker: initialized with provider "${provider}"`,
          );
        } else {
          api.logger.warn(
            `reranker: provider "${provider}" not configured`,
          );
        }
      },
      stop: () => {
        api.logger.info("reranker: stopped");
      },
    });
  },
};

export default rerankerPlugin;
