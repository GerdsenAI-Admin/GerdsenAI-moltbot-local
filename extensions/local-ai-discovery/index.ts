/**
 * Moltbot Local AI Discovery Plugin
 *
 * Auto-discovers models from local AI backends:
 * - vLlama (port 11435) - Ollama model management + vLLM inference
 * - LM Studio (port 1234) - Cross-platform local inference
 * - Ollama (port 11434) - Default local model server
 *
 * Models are discovered via OpenAI-compatible /v1/models endpoints
 * and automatically registered as providers in the model catalog.
 */

import { Type } from "@sinclair/typebox";
import type { MoltbotPluginApi } from "clawdbot/plugin-sdk";

// ============================================================================
// Types
// ============================================================================

type DiscoveredModel = {
  id: string;
  name?: string;
  owned_by?: string;
  created?: number;
  object?: string;
};

type ModelsResponse = {
  data: DiscoveredModel[];
  object?: string;
};

type LocalAIBackend = {
  id: string;
  name: string;
  baseUrl: string;
  port: number;
  api: "openai-completions" | "openai-responses";
  defaultContextWindow: number;
  defaultMaxTokens: number;
  toolCallSupport: "full" | "partial" | "none";
};

type DiscoveryResult = {
  backend: LocalAIBackend;
  models: DiscoveredModel[];
  error?: string;
};

// ============================================================================
// Backend Definitions
// ============================================================================

const BACKENDS: LocalAIBackend[] = [
  {
    id: "vllama",
    name: "vLlama",
    baseUrl: "http://127.0.0.1:11435/v1",
    port: 11435,
    api: "openai-completions",
    defaultContextWindow: 128000,
    defaultMaxTokens: 8192,
    toolCallSupport: "partial", // Via vLLM backend, may work
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    port: 1234,
    api: "openai-responses",
    defaultContextWindow: 128000,
    defaultMaxTokens: 8192,
    toolCallSupport: "partial", // Models with hammer badge support tools
  },
  {
    id: "ollama",
    name: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    port: 11434,
    api: "openai-completions",
    defaultContextWindow: 128000,
    defaultMaxTokens: 8192,
    toolCallSupport: "partial", // Beta support
  },
];

// ============================================================================
// Model Detection Helpers
// ============================================================================

/**
 * Detect if a model likely supports reasoning/thinking
 */
function detectReasoning(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return (
    lower.includes("deepseek-r1") ||
    lower.includes("o1") ||
    lower.includes("o3") ||
    lower.includes("thinking") ||
    lower.includes("reason")
  );
}

/**
 * Detect if a model likely supports vision/image input
 */
function detectVision(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return (
    lower.includes("vision") ||
    lower.includes("llava") ||
    lower.includes("bakllava") ||
    lower.includes("moondream") ||
    lower.includes("minicpm-v") ||
    lower.includes("qwen2-vl") ||
    lower.includes("pixtral")
  );
}

/**
 * Estimate context window from model name
 */
function estimateContextWindow(modelId: string, defaultWindow: number): number {
  const lower = modelId.toLowerCase();

  // Check for explicit context sizes in name
  const contextMatch = lower.match(/(\d+)k/);
  if (contextMatch) {
    const k = parseInt(contextMatch[1], 10);
    if (k >= 4 && k <= 2048) {
      return k * 1024;
    }
  }

  // Known model families with specific context windows
  if (lower.includes("mistral") || lower.includes("mixtral")) return 32768;
  if (lower.includes("llama-3") || lower.includes("llama3")) return 128000;
  if (lower.includes("llama-2") || lower.includes("llama2")) return 4096;
  if (lower.includes("qwen2.5") || lower.includes("qwen-2.5")) return 128000;
  if (lower.includes("qwen2") || lower.includes("qwen-2")) return 32768;
  if (lower.includes("deepseek")) return 64000;
  if (lower.includes("gemma")) return 8192;
  if (lower.includes("phi-3") || lower.includes("phi3")) return 128000;
  if (lower.includes("phi-2") || lower.includes("phi2")) return 2048;
  if (lower.includes("nemotron")) return 128000;
  if (lower.includes("devstral") || lower.includes("magistral")) return 128000;
  if (lower.includes("codestral")) return 32768;

  return defaultWindow;
}

/**
 * Generate a friendly display name from model ID
 */
function generateDisplayName(modelId: string): string {
  return modelId
    .replace(/[:\/]/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
    .trim();
}

// ============================================================================
// Discovery Functions
// ============================================================================

async function fetchModels(
  baseUrl: string,
  timeoutMs: number = 5000,
): Promise<ModelsResponse | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as ModelsResponse;
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverBackend(
  backend: LocalAIBackend,
  timeoutMs: number = 5000,
): Promise<DiscoveryResult> {
  const result = await fetchModels(backend.baseUrl, timeoutMs);

  if (!result || !Array.isArray(result.data)) {
    return {
      backend,
      models: [],
      error: `${backend.name} not responding at ${backend.baseUrl}`,
    };
  }

  return {
    backend,
    models: result.data,
  };
}

async function discoverAllBackends(
  timeoutMs: number = 5000,
): Promise<DiscoveryResult[]> {
  const results = await Promise.all(
    BACKENDS.map((backend) => discoverBackend(backend, timeoutMs)),
  );
  return results;
}

// ============================================================================
// Config Schema
// ============================================================================

const configSchema = Type.Object({
  enabled: Type.Optional(Type.Boolean({ default: true })),
  backends: Type.Optional(
    Type.Object({
      vllama: Type.Optional(
        Type.Object({
          enabled: Type.Optional(Type.Boolean({ default: true })),
          baseUrl: Type.Optional(Type.String()),
          apiKey: Type.Optional(Type.String()),
        }),
      ),
      lmstudio: Type.Optional(
        Type.Object({
          enabled: Type.Optional(Type.Boolean({ default: true })),
          baseUrl: Type.Optional(Type.String()),
          apiKey: Type.Optional(Type.String()),
        }),
      ),
      ollama: Type.Optional(
        Type.Object({
          enabled: Type.Optional(Type.Boolean({ default: true })),
          baseUrl: Type.Optional(Type.String()),
          apiKey: Type.Optional(Type.String()),
        }),
      ),
    }),
  ),
  discoveryIntervalMs: Type.Optional(Type.Number({ default: 30000 })),
  timeoutMs: Type.Optional(Type.Number({ default: 5000 })),
  autoRegister: Type.Optional(Type.Boolean({ default: true })),
});

type PluginConfig = {
  enabled?: boolean;
  backends?: {
    vllama?: { enabled?: boolean; baseUrl?: string; apiKey?: string };
    lmstudio?: { enabled?: boolean; baseUrl?: string; apiKey?: string };
    ollama?: { enabled?: boolean; baseUrl?: string; apiKey?: string };
  };
  discoveryIntervalMs?: number;
  timeoutMs?: number;
  autoRegister?: boolean;
};

// ============================================================================
// Plugin Definition
// ============================================================================

const localAiDiscoveryPlugin = {
  id: "local-ai-discovery",
  name: "Local AI Discovery",
  description: "Auto-discover models from vLlama, LM Studio, and Ollama",
  configSchema: {
    jsonSchema: configSchema,
  },

  register(api: MoltbotPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as PluginConfig;

    if (cfg.enabled === false) {
      api.logger.info("local-ai-discovery: disabled by config");
      return;
    }

    let discoveryInterval: NodeJS.Timeout | null = null;
    let lastDiscovery: DiscoveryResult[] = [];

    // Merge user-configured backends with defaults
    const getBackendConfig = (backendId: string): LocalAIBackend | null => {
      const base = BACKENDS.find((b) => b.id === backendId);
      if (!base) return null;

      const userConfig = cfg.backends?.[backendId as keyof typeof cfg.backends];
      if (userConfig?.enabled === false) return null;

      return {
        ...base,
        baseUrl: userConfig?.baseUrl || base.baseUrl,
      };
    };

    const runDiscovery = async (): Promise<DiscoveryResult[]> => {
      const backends = BACKENDS.map((b) => getBackendConfig(b.id)).filter(
        (b): b is LocalAIBackend => b !== null,
      );

      const results = await Promise.all(
        backends.map((backend) =>
          discoverBackend(backend, cfg.timeoutMs ?? 5000),
        ),
      );

      lastDiscovery = results;
      return results;
    };

    // ========================================================================
    // Tools
    // ========================================================================

    api.registerTool(
      {
        name: "local_ai_discover",
        label: "Local AI Discover",
        description:
          "Discover available models from local AI backends (vLlama, LM Studio, Ollama)",
        parameters: Type.Object({
          backend: Type.Optional(
            Type.String({
              description:
                'Specific backend to query: "vllama", "lmstudio", "ollama", or omit for all',
            }),
          ),
          refresh: Type.Optional(
            Type.Boolean({
              description: "Force refresh discovery (default: use cached)",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { backend, refresh } = params as {
            backend?: string;
            refresh?: boolean;
          };

          let results: DiscoveryResult[];

          if (refresh || lastDiscovery.length === 0) {
            results = await runDiscovery();
          } else {
            results = lastDiscovery;
          }

          if (backend) {
            results = results.filter(
              (r) => r.backend.id.toLowerCase() === backend.toLowerCase(),
            );
          }

          const available = results.filter((r) => r.models.length > 0);
          const unavailable = results.filter((r) => r.models.length === 0);

          if (available.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    "No local AI backends are currently available.\n\n" +
                    "Checked backends:\n" +
                    unavailable
                      .map((r) => `- ${r.backend.name}: ${r.error || "offline"}`)
                      .join("\n"),
                },
              ],
              details: { available: [], unavailable: unavailable.map((r) => r.backend.id) },
            };
          }

          const summary = available
            .map((r) => {
              const models = r.models.map((m) => `  - ${m.id}`).join("\n");
              return `**${r.backend.name}** (${r.backend.baseUrl}):\n${models}`;
            })
            .join("\n\n");

          return {
            content: [
              {
                type: "text",
                text: `Found ${available.reduce((sum, r) => sum + r.models.length, 0)} models across ${available.length} backends:\n\n${summary}`,
              },
            ],
            details: {
              backends: available.map((r) => ({
                id: r.backend.id,
                name: r.backend.name,
                baseUrl: r.backend.baseUrl,
                models: r.models.map((m) => ({
                  id: m.id,
                  name: m.name || generateDisplayName(m.id),
                  reasoning: detectReasoning(m.id),
                  vision: detectVision(m.id),
                  contextWindow: estimateContextWindow(
                    m.id,
                    r.backend.defaultContextWindow,
                  ),
                })),
              })),
            },
          };
        },
      },
      { name: "local_ai_discover" },
    );

    api.registerTool(
      {
        name: "local_ai_status",
        label: "Local AI Status",
        description: "Check the status of local AI backends",
        parameters: Type.Object({}),
        async execute() {
          const results = await runDiscovery();

          const status = results.map((r) => ({
            backend: r.backend.name,
            url: r.backend.baseUrl,
            status: r.models.length > 0 ? "online" : "offline",
            modelCount: r.models.length,
            error: r.error,
          }));

          const text = status
            .map(
              (s) =>
                `${s.status === "online" ? "+" : "-"} ${s.backend}: ${s.status}${s.modelCount > 0 ? ` (${s.modelCount} models)` : ""}${s.error ? ` - ${s.error}` : ""}`,
            )
            .join("\n");

          return {
            content: [{ type: "text", text: `Local AI Backend Status:\n\n${text}` }],
            details: { backends: status },
          };
        },
      },
      { name: "local_ai_status" },
    );

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const localAi = program
          .command("local-ai")
          .description("Local AI backend management");

        localAi
          .command("discover")
          .description("Discover models from local AI backends")
          .option("--backend <name>", "Specific backend to query")
          .option("--json", "Output as JSON")
          .action(async (opts) => {
            const results = await runDiscovery();
            const filtered = opts.backend
              ? results.filter(
                  (r) =>
                    r.backend.id.toLowerCase() === opts.backend.toLowerCase(),
                )
              : results;

            if (opts.json) {
              console.log(JSON.stringify(filtered, null, 2));
              return;
            }

            for (const result of filtered) {
              console.log(`\n${result.backend.name} (${result.backend.baseUrl}):`);
              if (result.error) {
                console.log(`  Error: ${result.error}`);
              } else if (result.models.length === 0) {
                console.log("  No models found");
              } else {
                for (const model of result.models) {
                  const features = [];
                  if (detectReasoning(model.id)) features.push("reasoning");
                  if (detectVision(model.id)) features.push("vision");
                  const featureStr =
                    features.length > 0 ? ` [${features.join(", ")}]` : "";
                  console.log(`  - ${model.id}${featureStr}`);
                }
              }
            }
          });

        localAi
          .command("status")
          .description("Check status of local AI backends")
          .action(async () => {
            const results = await runDiscovery();
            console.log("\nLocal AI Backend Status:");
            console.log("-".repeat(50));
            for (const result of results) {
              const status =
                result.models.length > 0 ? "ONLINE" : "OFFLINE";
              const count =
                result.models.length > 0
                  ? ` (${result.models.length} models)`
                  : "";
              console.log(
                `${status.padEnd(8)} ${result.backend.name.padEnd(12)} ${result.backend.baseUrl}${count}`,
              );
            }
          });

        localAi
          .command("config")
          .description("Generate provider config for discovered models")
          .option("--backend <name>", "Specific backend")
          .action(async (opts) => {
            const results = await runDiscovery();
            const available = results.filter((r) => r.models.length > 0);
            const filtered = opts.backend
              ? available.filter(
                  (r) =>
                    r.backend.id.toLowerCase() === opts.backend.toLowerCase(),
                )
              : available;

            if (filtered.length === 0) {
              console.log("No backends available to generate config for.");
              return;
            }

            const providers: Record<string, unknown> = {};
            for (const result of filtered) {
              const userConfig =
                cfg.backends?.[result.backend.id as keyof typeof cfg.backends];
              providers[result.backend.id] = {
                baseUrl: result.backend.baseUrl,
                apiKey: userConfig?.apiKey || `${result.backend.id}-local`,
                api: result.backend.api,
                models: result.models.map((m) => ({
                  id: m.id,
                  name: generateDisplayName(m.id),
                  reasoning: detectReasoning(m.id),
                  input: detectVision(m.id) ? ["text", "image"] : ["text"],
                  contextWindow: estimateContextWindow(
                    m.id,
                    result.backend.defaultContextWindow,
                  ),
                  maxTokens: result.backend.defaultMaxTokens,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                })),
              };
            }

            const config = {
              models: {
                mode: "merge",
                providers,
              },
            };

            console.log("\nAdd this to your moltbot.json:\n");
            console.log(JSON.stringify(config, null, 2));
          });
      },
      { commands: ["local-ai"] },
    );

    // ========================================================================
    // Provider Registration (auto-register discovered models)
    // ========================================================================

    if (cfg.autoRegister !== false) {
      // Register providers for auto-discovered backends
      for (const backend of BACKENDS) {
        const backendConfig = getBackendConfig(backend.id);
        if (!backendConfig) continue;

        const userConfig = cfg.backends?.[backend.id as keyof typeof cfg.backends];

        api.registerProvider({
          id: backend.id,
          label: backend.name,
          docsPath: `/local-models#${backend.id}`,
          aliases: [],
          envVars: [`${backend.id.toUpperCase()}_API_KEY`],
          models: {
            baseUrl: backendConfig.baseUrl,
            apiKey: userConfig?.apiKey || `${backend.id}-local`,
            api: backendConfig.api,
            models: [], // Models discovered dynamically
          },
          auth: [
            {
              id: "local",
              label: "Local (no auth required)",
              kind: "api_key",
              run: async () => ({
                profiles: [
                  {
                    profileId: `${backend.id}-local`,
                    credential: {
                      kind: "api_key",
                      apiKey: `${backend.id}-local`,
                    },
                  },
                ],
                notes: [
                  `${backend.name} typically doesn't require authentication for local access.`,
                ],
              }),
            },
          ],
        });
      }
    }

    // ========================================================================
    // Service (background discovery)
    // ========================================================================

    api.registerService({
      id: "local-ai-discovery",
      start: async () => {
        api.logger.info("local-ai-discovery: starting background discovery");

        // Initial discovery
        const results = await runDiscovery();
        const available = results.filter((r) => r.models.length > 0);
        api.logger.info(
          `local-ai-discovery: found ${available.length} backends with ${available.reduce((sum, r) => sum + r.models.length, 0)} models`,
        );

        // Periodic discovery
        const intervalMs = cfg.discoveryIntervalMs ?? 30000;
        if (intervalMs > 0) {
          discoveryInterval = setInterval(async () => {
            try {
              await runDiscovery();
            } catch (err) {
              api.logger.warn(
                `local-ai-discovery: periodic discovery failed: ${String(err)}`,
              );
            }
          }, intervalMs);
        }
      },
      stop: () => {
        if (discoveryInterval) {
          clearInterval(discoveryInterval);
          discoveryInterval = null;
        }
        api.logger.info("local-ai-discovery: stopped");
      },
    });

    // ========================================================================
    // Gateway startup hook
    // ========================================================================

    api.on("gateway_start", async () => {
      api.logger.info("local-ai-discovery: gateway started, running discovery");
      await runDiscovery();
    });
  },
};

export default localAiDiscoveryPlugin;
