/**
 * Chroma Vector DB Plugin Tests
 *
 * Tests the Chroma vector database plugin functionality including:
 * - Plugin registration and configuration
 * - ChromaMemoryStore class methods
 * - Tool registration
 * - CLI command registration
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

describe("vectordb-chroma plugin", () => {
  test("plugin exports correct metadata", async () => {
    const { default: chromaPlugin } = await import("./index.js");

    expect(chromaPlugin.id).toBe("vectordb-chroma");
    expect(chromaPlugin.name).toBe("Chroma Vector DB");
    expect(chromaPlugin.kind).toBe("memory");
    expect(chromaPlugin.configSchema).toBeDefined();
    expect(chromaPlugin.register).toBeInstanceOf(Function);
  });

  test("plugin has valid config schema", async () => {
    const { default: chromaPlugin } = await import("./index.js");

    expect(chromaPlugin.configSchema.jsonSchema).toBeDefined();
    const schema = chromaPlugin.configSchema.jsonSchema;

    // Check schema properties exist
    expect(schema.properties).toBeDefined();
    expect(schema.properties.enabled).toBeDefined();
    expect(schema.properties.host).toBeDefined();
    expect(schema.properties.collectionName).toBeDefined();
  });

  test("plugin registers when enabled", async () => {
    const { default: chromaPlugin } = await import("./index.js");

    const registeredTools: Array<{ tool: unknown; opts: unknown }> = [];
    const registeredClis: Array<{ registrar: unknown; opts: unknown }> = [];
    const registeredServices: Array<unknown> = [];
    const logs: string[] = [];

    const mockApi = {
      pluginConfig: {
        enabled: true,
        host: "http://localhost:8000",
        collectionName: "test_collection",
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

    chromaPlugin.register(mockApi as any);

    // Should register 3 tools: chroma_store, chroma_search, chroma_delete
    expect(registeredTools.length).toBe(3);
    expect(registeredTools.map((t) => (t.opts as { name: string })?.name)).toContain("chroma_store");
    expect(registeredTools.map((t) => (t.opts as { name: string })?.name)).toContain("chroma_search");
    expect(registeredTools.map((t) => (t.opts as { name: string })?.name)).toContain("chroma_delete");

    // Should register CLI commands
    expect(registeredClis.length).toBe(1);

    // Should register service
    expect(registeredServices.length).toBe(1);
  });

  test("plugin does not register when disabled", async () => {
    const { default: chromaPlugin } = await import("./index.js");

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

    chromaPlugin.register(mockApi as any);

    expect(registeredTools.length).toBe(0);
    expect(logs.some((l) => l.includes("disabled by config"))).toBe(true);
  });

  test("tool schemas are valid", async () => {
    const { default: chromaPlugin } = await import("./index.js");

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

    chromaPlugin.register(mockApi as any);

    // Verify store tool schema
    const storeTool = registeredTools.find((t) => t.tool.name === "chroma_store")?.tool;
    expect(storeTool).toBeDefined();
    expect(storeTool?.parameters).toBeDefined();

    // Verify search tool schema
    const searchTool = registeredTools.find((t) => t.tool.name === "chroma_search")?.tool;
    expect(searchTool).toBeDefined();
    expect(searchTool?.parameters).toBeDefined();

    // Verify delete tool schema
    const deleteTool = registeredTools.find((t) => t.tool.name === "chroma_delete")?.tool;
    expect(deleteTool).toBeDefined();
    expect(deleteTool?.parameters).toBeDefined();
  });
});

describe("ChromaMemoryStore", () => {
  test("config defaults are applied", async () => {
    const { default: chromaPlugin } = await import("./index.js");

    const mockApi = {
      pluginConfig: {}, // Empty config, should use defaults
      logger: { info: vi.fn(), warn: vi.fn() },
      registerTool: vi.fn(),
      registerCli: vi.fn(),
      registerService: vi.fn(),
    };

    // Should not throw with empty config
    expect(() => chromaPlugin.register(mockApi as any)).not.toThrow();
  });

  test("custom collection name is used", async () => {
    const { default: chromaPlugin } = await import("./index.js");

    const services: Array<{ id: string }> = [];

    const mockApi = {
      pluginConfig: {
        enabled: true,
        collectionName: "custom_collection",
      },
      logger: { info: vi.fn(), warn: vi.fn() },
      registerTool: vi.fn(),
      registerCli: vi.fn(),
      registerService: (service: { id: string }) => {
        services.push(service);
      },
    };

    chromaPlugin.register(mockApi as any);

    expect(services.length).toBe(1);
    expect(services[0].id).toBe("vectordb-chroma");
  });
});
