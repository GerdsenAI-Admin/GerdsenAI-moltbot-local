/**
 * Reranker Plugin Tests
 *
 * Tests the reranker plugin functionality including:
 * - Plugin registration and configuration
 * - Reranker client creation for different providers
 * - Tool registration
 * - Hook integration
 */

import { describe, test, expect, vi } from "vitest";

describe("reranker plugin", () => {
  test("plugin exports correct metadata", async () => {
    const { default: rerankerPlugin } = await import("./index.js");

    expect(rerankerPlugin.id).toBe("reranker");
    expect(rerankerPlugin.name).toBe("Reranker");
    expect(rerankerPlugin.configSchema).toBeDefined();
    expect(rerankerPlugin.register).toBeInstanceOf(Function);
  });

  test("plugin has valid config schema", async () => {
    const { default: rerankerPlugin } = await import("./index.js");

    expect(rerankerPlugin.configSchema.jsonSchema).toBeDefined();
    const schema = rerankerPlugin.configSchema.jsonSchema;

    // Check schema properties exist
    expect(schema.properties).toBeDefined();
    expect(schema.properties.enabled).toBeDefined();
    expect(schema.properties.provider).toBeDefined();
    expect(schema.properties.topK).toBeDefined();
    expect(schema.properties.minScore).toBeDefined();
    expect(schema.properties.cohere).toBeDefined();
    expect(schema.properties.jina).toBeDefined();
    expect(schema.properties.local).toBeDefined();
    expect(schema.properties.huggingface).toBeDefined();
  });

  test("plugin registers when enabled", async () => {
    const { default: rerankerPlugin } = await import("./index.js");

    const registeredTools: Array<{ tool: unknown; opts: unknown }> = [];
    const registeredClis: Array<{ registrar: unknown; opts: unknown }> = [];
    const registeredServices: Array<unknown> = [];
    const registeredHooks: Record<string, unknown[]> = {};

    const mockApi = {
      pluginConfig: {
        enabled: true,
        provider: "local",
        local: {
          baseUrl: "http://localhost:8080",
        },
      },
      logger: { info: vi.fn(), warn: vi.fn() },
      registerTool: (tool: unknown, opts: unknown) => {
        registeredTools.push({ tool, opts });
      },
      registerCli: (registrar: unknown, opts: unknown) => {
        registeredClis.push({ registrar, opts });
      },
      registerService: (service: unknown) => {
        registeredServices.push(service);
      },
      on: (hookName: string, handler: unknown) => {
        if (!registeredHooks[hookName]) registeredHooks[hookName] = [];
        registeredHooks[hookName].push(handler);
      },
    };

    rerankerPlugin.register(mockApi as any);

    // Should register rerank tool
    expect(registeredTools.length).toBe(1);
    expect((registeredTools[0].opts as { name: string })?.name).toBe("rerank");

    // Should register CLI commands
    expect(registeredClis.length).toBe(1);

    // Should register service
    expect(registeredServices.length).toBe(1);

    // Should register after_tool_call hook for memory integration
    expect(registeredHooks["after_tool_call"]).toBeDefined();
    expect(registeredHooks["after_tool_call"].length).toBe(1);
  });

  test("plugin does not register when disabled", async () => {
    const { default: rerankerPlugin } = await import("./index.js");

    const registeredTools: Array<unknown> = [];
    const logs: string[] = [];

    const mockApi = {
      pluginConfig: {
        enabled: false,
      },
      logger: {
        info: (msg: string) => logs.push(`[info] ${msg}`),
        warn: (msg: string) => logs.push(`[warn] ${msg}`),
      },
      registerTool: (tool: unknown) => {
        registeredTools.push(tool);
      },
      registerCli: vi.fn(),
      registerService: vi.fn(),
      on: vi.fn(),
    };

    rerankerPlugin.register(mockApi as any);

    expect(registeredTools.length).toBe(0);
    expect(logs.some((l) => l.includes("disabled by config"))).toBe(true);
  });

  test("rerank tool schema is valid", async () => {
    const { default: rerankerPlugin } = await import("./index.js");

    const registeredTools: Array<{ tool: { name: string; parameters: { properties: Record<string, unknown> } }; opts: unknown }> = [];

    const mockApi = {
      pluginConfig: { enabled: true, provider: "local", local: { baseUrl: "http://localhost:8080" } },
      logger: { info: vi.fn(), warn: vi.fn() },
      registerTool: (tool: unknown, opts: unknown) => {
        registeredTools.push({ tool: tool as { name: string; parameters: { properties: Record<string, unknown> } }, opts });
      },
      registerCli: vi.fn(),
      registerService: vi.fn(),
      on: vi.fn(),
    };

    rerankerPlugin.register(mockApi as any);

    const rerankTool = registeredTools[0]?.tool;
    expect(rerankTool).toBeDefined();
    expect(rerankTool.name).toBe("rerank");
    expect(rerankTool.parameters).toBeDefined();
    expect(rerankTool.parameters.properties.query).toBeDefined();
    expect(rerankTool.parameters.properties.documents).toBeDefined();
    expect(rerankTool.parameters.properties.topK).toBeDefined();
  });

  test("warns when cohere provider has no API key", async () => {
    const { default: rerankerPlugin } = await import("./index.js");

    const logs: string[] = [];
    const services: Array<{ id: string; start: () => void }> = [];

    // Clear any existing env vars
    const originalKey = process.env.COHERE_API_KEY;
    delete process.env.COHERE_API_KEY;

    const mockApi = {
      pluginConfig: {
        enabled: true,
        provider: "cohere",
        // No API key configured
      },
      logger: {
        info: (msg: string) => logs.push(`[info] ${msg}`),
        warn: (msg: string) => logs.push(`[warn] ${msg}`),
      },
      registerTool: vi.fn(),
      registerCli: vi.fn(),
      registerService: (service: { id: string; start: () => void }) => {
        services.push(service);
      },
      on: vi.fn(),
    };

    rerankerPlugin.register(mockApi as any);

    // Start the service to trigger warning
    services[0]?.start();

    expect(logs.some((l) => l.includes("not configured"))).toBe(true);

    // Restore env var
    if (originalKey) process.env.COHERE_API_KEY = originalKey;
  });

  test("local provider does not require API key", async () => {
    const { default: rerankerPlugin } = await import("./index.js");

    const services: Array<{ id: string; start: () => void }> = [];
    const logs: string[] = [];

    const mockApi = {
      pluginConfig: {
        enabled: true,
        provider: "local",
        local: {
          baseUrl: "http://localhost:8080",
        },
      },
      logger: {
        info: (msg: string) => logs.push(`[info] ${msg}`),
        warn: (msg: string) => logs.push(`[warn] ${msg}`),
      },
      registerTool: vi.fn(),
      registerCli: vi.fn(),
      registerService: (service: { id: string; start: () => void }) => {
        services.push(service);
      },
      on: vi.fn(),
    };

    rerankerPlugin.register(mockApi as any);

    // Start the service
    services[0]?.start();

    // Should not warn about missing API key for local provider
    expect(logs.some((l) => l.includes("initialized"))).toBe(true);
    expect(logs.filter((l) => l.includes("API key")).length).toBe(0);
  });
});
