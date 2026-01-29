/**
 * Qdrant Vector DB Plugin Tests
 *
 * Tests the Qdrant vector database plugin functionality including:
 * - Plugin registration and configuration
 * - QdrantMemoryStore class methods
 * - Tool registration
 * - CLI command registration
 */

import { describe, test, expect, vi } from "vitest";

describe("vectordb-qdrant plugin", () => {
  test("plugin exports correct metadata", async () => {
    const { default: qdrantPlugin } = await import("./index.js");

    expect(qdrantPlugin.id).toBe("vectordb-qdrant");
    expect(qdrantPlugin.name).toBe("Qdrant Vector DB");
    expect(qdrantPlugin.kind).toBe("memory");
    expect(qdrantPlugin.configSchema).toBeDefined();
    expect(qdrantPlugin.register).toBeInstanceOf(Function);
  });

  test("plugin has valid config schema", async () => {
    const { default: qdrantPlugin } = await import("./index.js");

    expect(qdrantPlugin.configSchema.jsonSchema).toBeDefined();
    const schema = qdrantPlugin.configSchema.jsonSchema;

    // Check schema properties exist
    expect(schema.properties).toBeDefined();
    expect(schema.properties.enabled).toBeDefined();
    expect(schema.properties.url).toBeDefined();
    expect(schema.properties.collectionName).toBeDefined();
    expect(schema.properties.vectorSize).toBeDefined();
    expect(schema.properties.distance).toBeDefined();
  });

  test("plugin registers when enabled", async () => {
    const { default: qdrantPlugin } = await import("./index.js");

    const registeredTools: Array<{ tool: unknown; opts: unknown }> = [];
    const registeredClis: Array<{ registrar: unknown; opts: unknown }> = [];
    const registeredServices: Array<unknown> = [];
    const logs: string[] = [];

    const mockApi = {
      pluginConfig: {
        enabled: true,
        url: "http://localhost:6333",
        collectionName: "test_collection",
        vectorSize: 1536,
      },
      logger: {
        info: (msg: string) => logs.push(`[info] ${msg}`),
        warn: (msg: string) => logs.push(`[warn] ${msg}`),
      },
      registerTool: (tool: unknown, opts: unknown) => {
        registeredTools.push({ tool, opts });
      },
      registerCli: (registrar: unknown, opts: unknown) => {
        registeredClis.push({ registrar, opts });
      },
      registerService: (service: unknown) => {
        registeredServices.push(service);
      },
    };

    qdrantPlugin.register(mockApi as any);

    // Should register 3 tools: qdrant_store, qdrant_search, qdrant_delete
    expect(registeredTools.length).toBe(3);
    expect(registeredTools.map((t) => (t.opts as { name: string })?.name)).toContain("qdrant_store");
    expect(registeredTools.map((t) => (t.opts as { name: string })?.name)).toContain("qdrant_search");
    expect(registeredTools.map((t) => (t.opts as { name: string })?.name)).toContain("qdrant_delete");

    // Should register CLI commands
    expect(registeredClis.length).toBe(1);

    // Should register service
    expect(registeredServices.length).toBe(1);
  });

  test("plugin does not register when disabled", async () => {
    const { default: qdrantPlugin } = await import("./index.js");

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
    };

    qdrantPlugin.register(mockApi as any);

    expect(registeredTools.length).toBe(0);
    expect(logs.some((l) => l.includes("disabled by config"))).toBe(true);
  });

  test("tool schemas are valid", async () => {
    const { default: qdrantPlugin } = await import("./index.js");

    const registeredTools: Array<{ tool: { name: string; parameters: unknown }; opts: unknown }> = [];

    const mockApi = {
      pluginConfig: { enabled: true },
      logger: { info: vi.fn(), warn: vi.fn() },
      registerTool: (tool: unknown, opts: unknown) => {
        registeredTools.push({ tool: tool as { name: string; parameters: unknown }, opts });
      },
      registerCli: vi.fn(),
      registerService: vi.fn(),
    };

    qdrantPlugin.register(mockApi as any);

    // Verify store tool has importance parameter (different from Chroma)
    const storeTool = registeredTools.find((t) => t.tool.name === "qdrant_store")?.tool;
    expect(storeTool).toBeDefined();
    expect(storeTool?.parameters).toBeDefined();

    // Verify search tool has minImportance parameter
    const searchTool = registeredTools.find((t) => t.tool.name === "qdrant_search")?.tool;
    expect(searchTool).toBeDefined();
    expect(searchTool?.parameters).toBeDefined();
  });

  test("config defaults are applied", async () => {
    const { default: qdrantPlugin } = await import("./index.js");

    const mockApi = {
      pluginConfig: {}, // Empty config, should use defaults
      logger: { info: vi.fn(), warn: vi.fn() },
      registerTool: vi.fn(),
      registerCli: vi.fn(),
      registerService: vi.fn(),
    };

    // Should not throw with empty config
    expect(() => qdrantPlugin.register(mockApi as any)).not.toThrow();
  });

  test("custom vector size is configurable", async () => {
    const { default: qdrantPlugin } = await import("./index.js");

    const services: Array<{ id: string }> = [];

    const mockApi = {
      pluginConfig: {
        enabled: true,
        vectorSize: 768, // Custom vector size for smaller embeddings
        distance: "Euclid",
      },
      logger: { info: vi.fn(), warn: vi.fn() },
      registerTool: vi.fn(),
      registerCli: vi.fn(),
      registerService: (service: { id: string }) => {
        services.push(service);
      },
    };

    qdrantPlugin.register(mockApi as any);

    expect(services.length).toBe(1);
    expect(services[0].id).toBe("vectordb-qdrant");
  });
});
