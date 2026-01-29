/**
 * Local AI Discovery Plugin Tests
 *
 * Tests the local AI discovery functionality including:
 * - Plugin registration and configuration
 * - Backend definitions
 * - Model detection helpers
 * - Tool registration
 * - Provider registration
 */

import { describe, test, expect, vi } from "vitest";

describe("local-ai-discovery plugin", () => {
  test("plugin exports correct metadata", async () => {
    const { default: localAiPlugin } = await import("./index.js");

    expect(localAiPlugin.id).toBe("local-ai-discovery");
    expect(localAiPlugin.name).toBe("Local AI Discovery");
    expect(localAiPlugin.configSchema).toBeDefined();
    expect(localAiPlugin.register).toBeInstanceOf(Function);
  });

  test("plugin has valid config schema", async () => {
    const { default: localAiPlugin } = await import("./index.js");

    expect(localAiPlugin.configSchema.jsonSchema).toBeDefined();
    const schema = localAiPlugin.configSchema.jsonSchema;

    // Check schema properties exist
    expect(schema.properties).toBeDefined();
    expect(schema.properties.enabled).toBeDefined();
    expect(schema.properties.backends).toBeDefined();
    expect(schema.properties.discoveryIntervalMs).toBeDefined();
    expect(schema.properties.timeoutMs).toBeDefined();
    expect(schema.properties.autoRegister).toBeDefined();
  });

  test("plugin registers when enabled", async () => {
    const { default: localAiPlugin } = await import("./index.js");

    const registeredTools: Array<{ tool: unknown; opts: unknown }> = [];
    const registeredClis: Array<{ registrar: unknown; opts: unknown }> = [];
    const registeredServices: Array<unknown> = [];
    const registeredProviders: Array<unknown> = [];
    const registeredHooks: Record<string, unknown[]> = {};

    const mockApi = {
      pluginConfig: {
        enabled: true,
        autoRegister: true,
        discoveryIntervalMs: 0, // Disable periodic discovery for tests
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
      registerProvider: (provider: unknown) => {
        registeredProviders.push(provider);
      },
      on: (hookName: string, handler: unknown) => {
        if (!registeredHooks[hookName]) registeredHooks[hookName] = [];
        registeredHooks[hookName].push(handler);
      },
    };

    localAiPlugin.register(mockApi as any);

    // Should register 2 tools: local_ai_discover, local_ai_status
    expect(registeredTools.length).toBe(2);
    expect(registeredTools.map((t) => (t.opts as { name: string })?.name)).toContain("local_ai_discover");
    expect(registeredTools.map((t) => (t.opts as { name: string })?.name)).toContain("local_ai_status");

    // Should register CLI commands
    expect(registeredClis.length).toBe(1);

    // Should register service
    expect(registeredServices.length).toBe(1);

    // Should register providers for auto-discovery (vllama, lmstudio, ollama)
    expect(registeredProviders.length).toBe(3);

    // Should register gateway_start hook
    expect(registeredHooks["gateway_start"]).toBeDefined();
  });

  test("plugin does not register when disabled", async () => {
    const { default: localAiPlugin } = await import("./index.js");

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
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    localAiPlugin.register(mockApi as any);

    expect(registeredTools.length).toBe(0);
    expect(logs.some((l) => l.includes("disabled by config"))).toBe(true);
  });

  test("does not register providers when autoRegister is false", async () => {
    const { default: localAiPlugin } = await import("./index.js");

    const registeredProviders: Array<unknown> = [];

    const mockApi = {
      pluginConfig: {
        enabled: true,
        autoRegister: false,
      },
      logger: { info: vi.fn(), warn: vi.fn() },
      registerTool: vi.fn(),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: (provider: unknown) => {
        registeredProviders.push(provider);
      },
      on: vi.fn(),
    };

    localAiPlugin.register(mockApi as any);

    expect(registeredProviders.length).toBe(0);
  });

  test("respects backend enabled config", async () => {
    const { default: localAiPlugin } = await import("./index.js");

    const registeredProviders: Array<{ id: string }> = [];

    const mockApi = {
      pluginConfig: {
        enabled: true,
        autoRegister: true,
        backends: {
          vllama: { enabled: false },
          lmstudio: { enabled: true },
          ollama: { enabled: false },
        },
      },
      logger: { info: vi.fn(), warn: vi.fn() },
      registerTool: vi.fn(),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: (provider: { id: string }) => {
        registeredProviders.push(provider);
      },
      on: vi.fn(),
    };

    localAiPlugin.register(mockApi as any);

    // Should only register lmstudio provider
    expect(registeredProviders.length).toBe(1);
    expect(registeredProviders[0].id).toBe("lmstudio");
  });
});

describe("model detection helpers", () => {
  // Test the detection functions indirectly via tool execution
  test("discover tool returns model information", async () => {
    const { default: localAiPlugin } = await import("./index.js");

    const registeredTools: Array<{ tool: { execute: (id: string, params: unknown) => Promise<unknown> }; opts: unknown }> = [];

    const mockApi = {
      pluginConfig: { enabled: true, autoRegister: false },
      logger: { info: vi.fn(), warn: vi.fn() },
      registerTool: (tool: unknown, opts: unknown) => {
        registeredTools.push({ tool: tool as { execute: (id: string, params: unknown) => Promise<unknown> }, opts });
      },
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    localAiPlugin.register(mockApi as any);

    const discoverTool = registeredTools.find((t) => (t.opts as { name: string })?.name === "local_ai_discover")?.tool;
    expect(discoverTool).toBeDefined();

    // Execute discover (will fail to connect but should return structured response)
    const result = await discoverTool!.execute("test-1", { refresh: true }) as { details?: { unavailable?: string[] } };

    // Should return details even if backends are offline
    expect(result.details).toBeDefined();
  });

  test("status tool returns backend status", async () => {
    const { default: localAiPlugin } = await import("./index.js");

    const registeredTools: Array<{ tool: { execute: (id: string, params: unknown) => Promise<unknown> }; opts: unknown }> = [];

    const mockApi = {
      pluginConfig: { enabled: true, autoRegister: false },
      logger: { info: vi.fn(), warn: vi.fn() },
      registerTool: (tool: unknown, opts: unknown) => {
        registeredTools.push({ tool: tool as { execute: (id: string, params: unknown) => Promise<unknown> }, opts });
      },
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    localAiPlugin.register(mockApi as any);

    const statusTool = registeredTools.find((t) => (t.opts as { name: string })?.name === "local_ai_status")?.tool;
    expect(statusTool).toBeDefined();

    // Execute status
    const result = await statusTool!.execute("test-1", {}) as { details?: { backends?: Array<{ backend: string }> } };

    expect(result.details).toBeDefined();
    expect(result.details?.backends).toBeDefined();
    expect(Array.isArray(result.details?.backends)).toBe(true);
  });
});

describe("backend definitions", () => {
  test("provider registration includes correct metadata", async () => {
    const { default: localAiPlugin } = await import("./index.js");

    const registeredProviders: Array<{ id: string; label: string; models: { baseUrl: string; api: string } }> = [];

    const mockApi = {
      pluginConfig: { enabled: true, autoRegister: true },
      logger: { info: vi.fn(), warn: vi.fn() },
      registerTool: vi.fn(),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: (provider: { id: string; label: string; models: { baseUrl: string; api: string } }) => {
        registeredProviders.push(provider);
      },
      on: vi.fn(),
    };

    localAiPlugin.register(mockApi as any);

    // Check vllama provider
    const vllama = registeredProviders.find((p) => p.id === "vllama");
    expect(vllama).toBeDefined();
    expect(vllama?.label).toBe("vLlama");
    expect(vllama?.models.baseUrl).toContain("11435");

    // Check lmstudio provider
    const lmstudio = registeredProviders.find((p) => p.id === "lmstudio");
    expect(lmstudio).toBeDefined();
    expect(lmstudio?.label).toBe("LM Studio");
    expect(lmstudio?.models.baseUrl).toContain("1234");

    // Check ollama provider
    const ollama = registeredProviders.find((p) => p.id === "ollama");
    expect(ollama).toBeDefined();
    expect(ollama?.label).toBe("Ollama");
    expect(ollama?.models.baseUrl).toContain("11434");
  });

  test("custom baseUrl overrides default", async () => {
    const { default: localAiPlugin } = await import("./index.js");

    const registeredProviders: Array<{ id: string; models: { baseUrl: string } }> = [];

    const mockApi = {
      pluginConfig: {
        enabled: true,
        autoRegister: true,
        backends: {
          ollama: {
            enabled: true,
            baseUrl: "http://custom-host:8080/v1",
          },
        },
      },
      logger: { info: vi.fn(), warn: vi.fn() },
      registerTool: vi.fn(),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: (provider: { id: string; models: { baseUrl: string } }) => {
        registeredProviders.push(provider);
      },
      on: vi.fn(),
    };

    localAiPlugin.register(mockApi as any);

    const ollama = registeredProviders.find((p) => p.id === "ollama");
    expect(ollama?.models.baseUrl).toBe("http://custom-host:8080/v1");
  });
});
