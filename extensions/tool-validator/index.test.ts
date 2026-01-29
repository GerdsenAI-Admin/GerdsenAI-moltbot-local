/**
 * Tool Validator Plugin Tests
 *
 * Tests the tool validation and repair functionality including:
 * - JSON parsing and repair
 * - Type coercion
 * - Tool name fuzzy matching
 * - Dangerous call detection
 * - Hook integration
 */

import { describe, test, expect, vi } from "vitest";

describe("tool-validator plugin", () => {
  test("plugin exports correct metadata", async () => {
    const { default: toolValidatorPlugin } = await import("./index.js");

    expect(toolValidatorPlugin.id).toBe("tool-validator");
    expect(toolValidatorPlugin.name).toBe("Tool Validator");
    expect(toolValidatorPlugin.configSchema).toBeDefined();
    expect(toolValidatorPlugin.register).toBeInstanceOf(Function);
  });

  test("plugin has valid config schema", async () => {
    const { default: toolValidatorPlugin } = await import("./index.js");

    expect(toolValidatorPlugin.configSchema.jsonSchema).toBeDefined();
    const schema = toolValidatorPlugin.configSchema.jsonSchema;

    // Check schema properties exist
    expect(schema.properties).toBeDefined();
    expect(schema.properties.enabled).toBeDefined();
    expect(schema.properties.repairStrategy).toBeDefined();
    expect(schema.properties.blockOnValidationFailure).toBeDefined();
    expect(schema.properties.blockDangerousCalls).toBeDefined();
    expect(schema.properties.allowToolNameFuzzyMatch).toBeDefined();
    expect(schema.properties.logValidationErrors).toBeDefined();
    expect(schema.properties.strictMode).toBeDefined();
  });

  test("plugin registers when enabled", async () => {
    const { default: toolValidatorPlugin } = await import("./index.js");

    const registeredTools: Array<{ tool: unknown; opts: unknown }> = [];
    const registeredClis: Array<{ registrar: unknown; opts: unknown }> = [];
    const registeredServices: Array<unknown> = [];
    const registeredHooks: Record<string, Array<{ handler: unknown; opts?: unknown }>> = {};

    const mockApi = {
      pluginConfig: {
        enabled: true,
        repairStrategy: "coerce",
        blockDangerousCalls: true,
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
      on: (hookName: string, handler: unknown, opts?: unknown) => {
        if (!registeredHooks[hookName]) registeredHooks[hookName] = [];
        registeredHooks[hookName].push({ handler, opts });
      },
    };

    toolValidatorPlugin.register(mockApi as any);

    // Should register 2 tools: tool_validator_stats, tool_validator_test
    expect(registeredTools.length).toBe(2);
    expect(registeredTools.map((t) => (t.opts as { name: string })?.name)).toContain("tool_validator_stats");
    expect(registeredTools.map((t) => (t.opts as { name: string })?.name)).toContain("tool_validator_test");

    // Should register CLI commands
    expect(registeredClis.length).toBe(1);

    // Should register service
    expect(registeredServices.length).toBe(1);

    // Should register hooks with high priority
    expect(registeredHooks["before_tool_call"]).toBeDefined();
    expect(registeredHooks["after_tool_call"]).toBeDefined();
  });

  test("plugin does not register when disabled", async () => {
    const { default: toolValidatorPlugin } = await import("./index.js");

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

    toolValidatorPlugin.register(mockApi as any);

    expect(registeredTools.length).toBe(0);
    expect(logs.some((l) => l.includes("disabled by config"))).toBe(true);
  });

  test("before_tool_call hook has high priority", async () => {
    const { default: toolValidatorPlugin } = await import("./index.js");

    const registeredHooks: Record<string, Array<{ handler: unknown; opts?: { priority?: number } }>> = {};

    const mockApi = {
      pluginConfig: { enabled: true },
      logger: { info: vi.fn(), warn: vi.fn() },
      registerTool: vi.fn(),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      on: (hookName: string, handler: unknown, opts?: { priority?: number }) => {
        if (!registeredHooks[hookName]) registeredHooks[hookName] = [];
        registeredHooks[hookName].push({ handler, opts });
      },
    };

    toolValidatorPlugin.register(mockApi as any);

    // Check that before_tool_call has high priority (100)
    const beforeHook = registeredHooks["before_tool_call"]?.[0];
    expect(beforeHook?.opts?.priority).toBe(100);
  });
});

describe("validation helpers", () => {
  test("JSON parsing handles malformed input", async () => {
    // Test the tryParseJson function behavior via the test tool
    const { default: toolValidatorPlugin } = await import("./index.js");

    const registeredTools: Array<{ tool: { execute: (id: string, params: unknown) => Promise<unknown> }; opts: unknown }> = [];

    const mockApi = {
      pluginConfig: { enabled: true },
      logger: { info: vi.fn(), warn: vi.fn() },
      registerTool: (tool: unknown, opts: unknown) => {
        registeredTools.push({ tool: tool as { execute: (id: string, params: unknown) => Promise<unknown> }, opts });
      },
      registerCli: vi.fn(),
      registerService: vi.fn(),
      on: vi.fn(),
    };

    toolValidatorPlugin.register(mockApi as any);

    const testTool = registeredTools.find((t) => (t.opts as { name: string })?.name === "tool_validator_test")?.tool;
    expect(testTool).toBeDefined();

    // Test with invalid JSON
    const result = await testTool!.execute("test-1", {
      toolName: "test_tool",
      params: "not valid json {",
    }) as { details?: { error?: string } };

    expect(result.details?.error).toBe("invalid_json");
  });

  test("stats tool returns validation statistics", async () => {
    const { default: toolValidatorPlugin } = await import("./index.js");

    const registeredTools: Array<{ tool: { execute: (id: string, params: unknown) => Promise<unknown> }; opts: unknown }> = [];

    const mockApi = {
      pluginConfig: { enabled: true },
      logger: { info: vi.fn(), warn: vi.fn() },
      registerTool: (tool: unknown, opts: unknown) => {
        registeredTools.push({ tool: tool as { execute: (id: string, params: unknown) => Promise<unknown> }, opts });
      },
      registerCli: vi.fn(),
      registerService: vi.fn(),
      on: vi.fn(),
    };

    toolValidatorPlugin.register(mockApi as any);

    const statsTool = registeredTools.find((t) => (t.opts as { name: string })?.name === "tool_validator_stats")?.tool;
    expect(statsTool).toBeDefined();

    const result = await statsTool!.execute("test-1", {}) as { details?: { validated?: number } };

    expect(result.details).toBeDefined();
    expect(typeof result.details?.validated).toBe("number");
  });
});

describe("dangerous call detection", () => {
  test("detects shell injection patterns", async () => {
    const { default: toolValidatorPlugin } = await import("./index.js");

    const registeredTools: Array<{ tool: { execute: (id: string, params: unknown) => Promise<unknown> }; opts: unknown }> = [];

    const mockApi = {
      pluginConfig: { enabled: true, blockDangerousCalls: true },
      logger: { info: vi.fn(), warn: vi.fn() },
      registerTool: (tool: unknown, opts: unknown) => {
        registeredTools.push({ tool: tool as { execute: (id: string, params: unknown) => Promise<unknown> }, opts });
      },
      registerCli: vi.fn(),
      registerService: vi.fn(),
      on: vi.fn(),
    };

    toolValidatorPlugin.register(mockApi as any);

    const testTool = registeredTools.find((t) => (t.opts as { name: string })?.name === "tool_validator_test")?.tool;

    // Test dangerous bash command
    const result = await testTool!.execute("test-1", {
      toolName: "bash",
      params: JSON.stringify({ command: "ls; rm -rf /" }),
    }) as { details?: { blocked?: boolean } };

    expect(result.details?.blocked).toBe(true);
  });

  test("detects path traversal patterns", async () => {
    const { default: toolValidatorPlugin } = await import("./index.js");

    const registeredTools: Array<{ tool: { execute: (id: string, params: unknown) => Promise<unknown> }; opts: unknown }> = [];

    const mockApi = {
      pluginConfig: { enabled: true, blockDangerousCalls: true },
      logger: { info: vi.fn(), warn: vi.fn() },
      registerTool: (tool: unknown, opts: unknown) => {
        registeredTools.push({ tool: tool as { execute: (id: string, params: unknown) => Promise<unknown> }, opts });
      },
      registerCli: vi.fn(),
      registerService: vi.fn(),
      on: vi.fn(),
    };

    toolValidatorPlugin.register(mockApi as any);

    const testTool = registeredTools.find((t) => (t.opts as { name: string })?.name === "tool_validator_test")?.tool;

    // Test path traversal
    const result = await testTool!.execute("test-1", {
      toolName: "read_file",
      params: JSON.stringify({ path: "../../../etc/passwd" }),
    }) as { details?: { blocked?: boolean } };

    expect(result.details?.blocked).toBe(true);
  });

  test("allows safe tool calls", async () => {
    const { default: toolValidatorPlugin } = await import("./index.js");

    const registeredTools: Array<{ tool: { execute: (id: string, params: unknown) => Promise<unknown> }; opts: unknown }> = [];

    const mockApi = {
      pluginConfig: { enabled: true, blockDangerousCalls: true },
      logger: { info: vi.fn(), warn: vi.fn() },
      registerTool: (tool: unknown, opts: unknown) => {
        registeredTools.push({ tool: tool as { execute: (id: string, params: unknown) => Promise<unknown> }, opts });
      },
      registerCli: vi.fn(),
      registerService: vi.fn(),
      on: vi.fn(),
    };

    toolValidatorPlugin.register(mockApi as any);

    const testTool = registeredTools.find((t) => (t.opts as { name: string })?.name === "tool_validator_test")?.tool;

    // Test safe call
    const result = await testTool!.execute("test-1", {
      toolName: "read_file",
      params: JSON.stringify({ path: "/home/user/file.txt" }),
    }) as { details?: { valid?: boolean; blocked?: boolean } };

    expect(result.details?.valid).toBe(true);
    expect(result.details?.blocked).toBe(false);
  });
});
