/**
 * Document Ingest Plugin Tests
 *
 * Tests the document ingestion functionality including:
 * - Plugin registration and configuration
 * - Format detection
 * - Content cleaning
 * - Tool registration
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("document-ingest plugin", () => {
  test("plugin exports correct metadata", async () => {
    const { default: documentIngestPlugin } = await import("./index.js");

    expect(documentIngestPlugin.id).toBe("document-ingest");
    expect(documentIngestPlugin.name).toBe("Document Ingest");
    expect(documentIngestPlugin.configSchema).toBeDefined();
    expect(documentIngestPlugin.register).toBeInstanceOf(Function);
  });

  test("plugin has valid config schema", async () => {
    const { default: documentIngestPlugin } = await import("./index.js");

    expect(documentIngestPlugin.configSchema.jsonSchema).toBeDefined();
    const schema = documentIngestPlugin.configSchema.jsonSchema;

    // Check schema properties exist
    expect(schema.properties).toBeDefined();
    expect(schema.properties.enabled).toBeDefined();
    expect(schema.properties.outputDir).toBeDefined();
    expect(schema.properties.addToMemory).toBeDefined();
    expect(schema.properties.includeMetadata).toBeDefined();
    expect(schema.properties.cleanContent).toBeDefined();
    expect(schema.properties.supportedFormats).toBeDefined();
    expect(schema.properties.maxFileSizeMb).toBeDefined();
  });

  test("plugin registers when enabled", async () => {
    const { default: documentIngestPlugin } = await import("./index.js");

    const registeredTools: Array<{ tool: unknown; opts: unknown }> = [];
    const registeredClis: Array<{ registrar: unknown; opts: unknown }> = [];
    const registeredServices: Array<unknown> = [];

    const mockApi = {
      pluginConfig: {
        enabled: true,
        addToMemory: false, // Disable memory for tests
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
      resolvePath: (p: string) => p,
    };

    documentIngestPlugin.register(mockApi as any);

    // Should register 3 tools: document_ingest, document_extract, document_batch_ingest
    expect(registeredTools.length).toBe(3);
    expect(registeredTools.map((t) => (t.opts as { name: string })?.name)).toContain("document_ingest");
    expect(registeredTools.map((t) => (t.opts as { name: string })?.name)).toContain("document_extract");
    expect(registeredTools.map((t) => (t.opts as { name: string })?.name)).toContain("document_batch_ingest");

    // Should register CLI commands
    expect(registeredClis.length).toBe(1);

    // Should register service
    expect(registeredServices.length).toBe(1);
  });

  test("plugin does not register when disabled", async () => {
    const { default: documentIngestPlugin } = await import("./index.js");

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
      resolvePath: (p: string) => p,
    };

    documentIngestPlugin.register(mockApi as any);

    expect(registeredTools.length).toBe(0);
    expect(logs.some((l) => l.includes("disabled by config"))).toBe(true);
  });
});

describe("format detection", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-doc-test-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("extracts text files correctly", async () => {
    const { default: documentIngestPlugin } = await import("./index.js");

    const testContent = "This is a test document.\nWith multiple lines.\n";
    const testFile = path.join(tmpDir, "test.txt");
    await fs.writeFile(testFile, testContent);

    const registeredTools: Array<{ tool: { execute: (id: string, params: unknown) => Promise<unknown> }; opts: unknown }> = [];

    const mockApi = {
      pluginConfig: {
        enabled: true,
        addToMemory: false,
        includeMetadata: false,
        cleanContent: false,
      },
      logger: { info: vi.fn(), warn: vi.fn() },
      registerTool: (tool: unknown, opts: unknown) => {
        registeredTools.push({ tool: tool as { execute: (id: string, params: unknown) => Promise<unknown> }, opts });
      },
      registerCli: vi.fn(),
      registerService: vi.fn(),
      resolvePath: (p: string) => p,
    };

    documentIngestPlugin.register(mockApi as any);

    const extractTool = registeredTools.find((t) => (t.opts as { name: string })?.name === "document_extract")?.tool;

    const result = await extractTool!.execute("test-1", {
      filePath: testFile,
      includeMetadata: false,
    }) as { content?: Array<{ text: string }> };

    expect(result.content?.[0]?.text).toContain("This is a test document");
  });

  test("extracts markdown files correctly", async () => {
    const { default: documentIngestPlugin } = await import("./index.js");

    const testContent = "# Test Title\n\nThis is **bold** text.\n\n- Item 1\n- Item 2\n";
    const testFile = path.join(tmpDir, "test.md");
    await fs.writeFile(testFile, testContent);

    const registeredTools: Array<{ tool: { execute: (id: string, params: unknown) => Promise<unknown> }; opts: unknown }> = [];

    const mockApi = {
      pluginConfig: {
        enabled: true,
        addToMemory: false,
        includeMetadata: false,
      },
      logger: { info: vi.fn(), warn: vi.fn() },
      registerTool: (tool: unknown, opts: unknown) => {
        registeredTools.push({ tool: tool as { execute: (id: string, params: unknown) => Promise<unknown> }, opts });
      },
      registerCli: vi.fn(),
      registerService: vi.fn(),
      resolvePath: (p: string) => p,
    };

    documentIngestPlugin.register(mockApi as any);

    const extractTool = registeredTools.find((t) => (t.opts as { name: string })?.name === "document_extract")?.tool;

    const result = await extractTool!.execute("test-1", {
      filePath: testFile,
      includeMetadata: false,
    }) as { content?: Array<{ text: string }>; details?: { title?: string } };

    expect(result.content?.[0]?.text).toContain("Test Title");
    expect(result.details?.title).toBe("Test Title");
  });

  test("extracts HTML files correctly", async () => {
    const { default: documentIngestPlugin } = await import("./index.js");

    const testContent = `
      <!DOCTYPE html>
      <html>
      <head><title>Test Page</title></head>
      <body>
        <h1>Heading</h1>
        <p>Paragraph text.</p>
        <ul>
          <li>Item 1</li>
          <li>Item 2</li>
        </ul>
      </body>
      </html>
    `;
    const testFile = path.join(tmpDir, "test.html");
    await fs.writeFile(testFile, testContent);

    const registeredTools: Array<{ tool: { execute: (id: string, params: unknown) => Promise<unknown> }; opts: unknown }> = [];

    const mockApi = {
      pluginConfig: {
        enabled: true,
        addToMemory: false,
        includeMetadata: false,
      },
      logger: { info: vi.fn(), warn: vi.fn() },
      registerTool: (tool: unknown, opts: unknown) => {
        registeredTools.push({ tool: tool as { execute: (id: string, params: unknown) => Promise<unknown> }, opts });
      },
      registerCli: vi.fn(),
      registerService: vi.fn(),
      resolvePath: (p: string) => p,
    };

    documentIngestPlugin.register(mockApi as any);

    const extractTool = registeredTools.find((t) => (t.opts as { name: string })?.name === "document_extract")?.tool;

    const result = await extractTool!.execute("test-1", {
      filePath: testFile,
      includeMetadata: false,
    }) as { content?: Array<{ text: string }>; details?: { title?: string } };

    expect(result.content?.[0]?.text).toContain("Heading");
    expect(result.content?.[0]?.text).toContain("Paragraph text");
    expect(result.details?.title).toBe("Test Page");
  });

  test("rejects unsupported formats", async () => {
    const { default: documentIngestPlugin } = await import("./index.js");

    const testFile = path.join(tmpDir, "test.xyz");
    await fs.writeFile(testFile, "test content");

    const registeredTools: Array<{ tool: { execute: (id: string, params: unknown) => Promise<unknown> }; opts: unknown }> = [];

    const mockApi = {
      pluginConfig: {
        enabled: true,
        addToMemory: false,
        supportedFormats: ["pdf", "txt", "md"],
      },
      logger: { info: vi.fn(), warn: vi.fn() },
      registerTool: (tool: unknown, opts: unknown) => {
        registeredTools.push({ tool: tool as { execute: (id: string, params: unknown) => Promise<unknown> }, opts });
      },
      registerCli: vi.fn(),
      registerService: vi.fn(),
      resolvePath: (p: string) => p,
    };

    documentIngestPlugin.register(mockApi as any);

    const ingestTool = registeredTools.find((t) => (t.opts as { name: string })?.name === "document_ingest")?.tool;

    const result = await ingestTool!.execute("test-1", {
      filePath: testFile,
      addToMemory: false,
    }) as { details?: { success?: boolean; error?: string } };

    expect(result.details?.success).toBe(false);
    expect(result.details?.error).toContain("Unsupported format");
  });
});

describe("file size limits", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-doc-size-test-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("rejects files exceeding size limit", async () => {
    const { default: documentIngestPlugin } = await import("./index.js");

    // Create a file slightly larger than 1KB for testing (using small limit)
    const testFile = path.join(tmpDir, "large.txt");
    await fs.writeFile(testFile, "x".repeat(2000)); // 2KB

    const registeredTools: Array<{ tool: { execute: (id: string, params: unknown) => Promise<unknown> }; opts: unknown }> = [];

    const mockApi = {
      pluginConfig: {
        enabled: true,
        addToMemory: false,
        maxFileSizeMb: 0.001, // ~1KB limit
      },
      logger: { info: vi.fn(), warn: vi.fn() },
      registerTool: (tool: unknown, opts: unknown) => {
        registeredTools.push({ tool: tool as { execute: (id: string, params: unknown) => Promise<unknown> }, opts });
      },
      registerCli: vi.fn(),
      registerService: vi.fn(),
      resolvePath: (p: string) => p,
    };

    documentIngestPlugin.register(mockApi as any);

    const ingestTool = registeredTools.find((t) => (t.opts as { name: string })?.name === "document_ingest")?.tool;

    const result = await ingestTool!.execute("test-1", {
      filePath: testFile,
      addToMemory: false,
    }) as { details?: { success?: boolean; error?: string } };

    expect(result.details?.success).toBe(false);
    expect(result.details?.error).toContain("too large");
  });
});

describe("batch ingestion", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-batch-test-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("batch ingest processes multiple files", async () => {
    const { default: documentIngestPlugin } = await import("./index.js");

    // Create test files
    await fs.writeFile(path.join(tmpDir, "file1.txt"), "Content 1");
    await fs.writeFile(path.join(tmpDir, "file2.txt"), "Content 2");
    await fs.writeFile(path.join(tmpDir, "file3.md"), "# Markdown");

    const registeredTools: Array<{ tool: { execute: (id: string, params: unknown) => Promise<unknown> }; opts: unknown }> = [];

    const mockApi = {
      pluginConfig: {
        enabled: true,
        addToMemory: false,
      },
      logger: { info: vi.fn(), warn: vi.fn() },
      registerTool: (tool: unknown, opts: unknown) => {
        registeredTools.push({ tool: tool as { execute: (id: string, params: unknown) => Promise<unknown> }, opts });
      },
      registerCli: vi.fn(),
      registerService: vi.fn(),
      resolvePath: (p: string) => p,
    };

    documentIngestPlugin.register(mockApi as any);

    const batchTool = registeredTools.find((t) => (t.opts as { name: string })?.name === "document_batch_ingest")?.tool;

    const result = await batchTool!.execute("test-1", {
      directory: tmpDir,
      formats: ["txt", "md"],
      addToMemory: false,
    }) as { details?: { total?: number; successful?: number } };

    expect(result.details?.total).toBe(3);
    expect(result.details?.successful).toBe(3);
  });
});
