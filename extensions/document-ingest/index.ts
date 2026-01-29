/**
 * Moltbot Document Ingestion Plugin
 *
 * Supports ingesting documents in various formats:
 * - PDF (via pdf-parse)
 * - DOCX (via mammoth)
 * - TXT, MD (native)
 * - HTML (basic text extraction)
 *
 * Documents are converted to markdown and can be:
 * - Added to memory for RAG
 * - Stored as markdown files
 * - Chunked and embedded
 */

import { Type } from "@sinclair/typebox";
import type { MoltbotPluginApi } from "clawdbot/plugin-sdk";
import { stringEnum } from "clawdbot/plugin-sdk";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

// ============================================================================
// Types
// ============================================================================

type DocumentFormat = "pdf" | "docx" | "txt" | "md" | "html" | "unknown";

type ExtractedDocument = {
  content: string;
  metadata: {
    title?: string;
    author?: string;
    subject?: string;
    keywords?: string[];
    createdAt?: Date;
    modifiedAt?: Date;
    pageCount?: number;
    wordCount?: number;
    format: DocumentFormat;
    sourcePath: string;
  };
};

type IngestResult = {
  success: boolean;
  document?: ExtractedDocument;
  outputPath?: string;
  error?: string;
};

// ============================================================================
// Document Extractors
// ============================================================================

async function extractPdf(filePath: string): Promise<ExtractedDocument> {
  // Dynamic import to avoid bundling issues
  const pdfParse = (await import("pdf-parse")).default;
  const buffer = await fs.readFile(filePath);
  const data = await pdfParse(buffer);

  const metadata = data.info || {};

  return {
    content: data.text,
    metadata: {
      title: metadata.Title,
      author: metadata.Author,
      subject: metadata.Subject,
      keywords: metadata.Keywords?.split(",").map((k: string) => k.trim()),
      createdAt: metadata.CreationDate ? new Date(metadata.CreationDate) : undefined,
      modifiedAt: metadata.ModDate ? new Date(metadata.ModDate) : undefined,
      pageCount: data.numpages,
      wordCount: data.text.split(/\s+/).length,
      format: "pdf",
      sourcePath: filePath,
    },
  };
}

async function extractDocx(filePath: string): Promise<ExtractedDocument> {
  const mammoth = await import("mammoth");
  const buffer = await fs.readFile(filePath);

  // Extract as markdown for better structure preservation
  const result = await mammoth.convertToMarkdown({ buffer });
  const content = result.value;

  // Also extract raw text for word count
  const rawResult = await mammoth.extractRawText({ buffer });
  const wordCount = rawResult.value.split(/\s+/).length;

  // Get file stats for dates
  const stats = await fs.stat(filePath);

  return {
    content,
    metadata: {
      wordCount,
      createdAt: stats.birthtime,
      modifiedAt: stats.mtime,
      format: "docx",
      sourcePath: filePath,
    },
  };
}

async function extractTxt(filePath: string): Promise<ExtractedDocument> {
  const content = await fs.readFile(filePath, "utf-8");
  const stats = await fs.stat(filePath);

  return {
    content,
    metadata: {
      wordCount: content.split(/\s+/).length,
      createdAt: stats.birthtime,
      modifiedAt: stats.mtime,
      format: "txt",
      sourcePath: filePath,
    },
  };
}

async function extractMarkdown(filePath: string): Promise<ExtractedDocument> {
  const content = await fs.readFile(filePath, "utf-8");
  const stats = await fs.stat(filePath);

  // Try to extract title from first heading
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch?.[1];

  return {
    content,
    metadata: {
      title,
      wordCount: content.split(/\s+/).length,
      createdAt: stats.birthtime,
      modifiedAt: stats.mtime,
      format: "md",
      sourcePath: filePath,
    },
  };
}

async function extractHtml(filePath: string): Promise<ExtractedDocument> {
  const html = await fs.readFile(filePath, "utf-8");
  const stats = await fs.stat(filePath);

  // Basic HTML to text conversion
  let content = html
    // Remove scripts and styles
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    // Convert headers to markdown
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "# $1\n\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "## $1\n\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "### $1\n\n")
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "#### $1\n\n")
    .replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "##### $1\n\n")
    .replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "###### $1\n\n")
    // Convert paragraphs
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "$1\n\n")
    // Convert lists
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n")
    // Convert line breaks
    .replace(/<br\s*\/?>/gi, "\n")
    // Remove remaining tags
    .replace(/<[^>]+>/g, "")
    // Decode HTML entities
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Clean up whitespace
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Extract title from <title> tag
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch?.[1]?.trim();

  return {
    content,
    metadata: {
      title,
      wordCount: content.split(/\s+/).length,
      createdAt: stats.birthtime,
      modifiedAt: stats.mtime,
      format: "html",
      sourcePath: filePath,
    },
  };
}

function detectFormat(filePath: string): DocumentFormat {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".pdf":
      return "pdf";
    case ".docx":
      return "docx";
    case ".doc":
      return "docx"; // Will fail for old .doc format
    case ".txt":
      return "txt";
    case ".md":
    case ".markdown":
      return "md";
    case ".html":
    case ".htm":
      return "html";
    default:
      return "unknown";
  }
}

async function extractDocument(filePath: string): Promise<ExtractedDocument> {
  const format = detectFormat(filePath);

  switch (format) {
    case "pdf":
      return extractPdf(filePath);
    case "docx":
      return extractDocx(filePath);
    case "txt":
      return extractTxt(filePath);
    case "md":
      return extractMarkdown(filePath);
    case "html":
      return extractHtml(filePath);
    default:
      throw new Error(`Unsupported document format: ${path.extname(filePath)}`);
  }
}

// ============================================================================
// Content Processing
// ============================================================================

function generateDocumentHeader(doc: ExtractedDocument): string {
  const lines: string[] = [];

  if (doc.metadata.title) {
    lines.push(`# ${doc.metadata.title}`);
    lines.push("");
  }

  const metaLines: string[] = [];
  if (doc.metadata.author) metaLines.push(`**Author:** ${doc.metadata.author}`);
  if (doc.metadata.subject) metaLines.push(`**Subject:** ${doc.metadata.subject}`);
  if (doc.metadata.pageCount) metaLines.push(`**Pages:** ${doc.metadata.pageCount}`);
  if (doc.metadata.wordCount) metaLines.push(`**Words:** ${doc.metadata.wordCount}`);
  if (doc.metadata.format) metaLines.push(`**Format:** ${doc.metadata.format.toUpperCase()}`);

  if (metaLines.length > 0) {
    lines.push(metaLines.join(" | "));
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

function cleanContent(content: string): string {
  return content
    // Normalize line endings
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    // Remove excessive whitespace
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    // Remove non-printable characters (except newlines)
    .replace(/[^\x20-\x7E\n\u00A0-\uFFFF]/g, "")
    .trim();
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ============================================================================
// Config Schema
// ============================================================================

const FORMATS = ["pdf", "docx", "txt", "md", "html"] as const;

const configSchema = Type.Object({
  enabled: Type.Optional(Type.Boolean({ default: true })),
  outputDir: Type.Optional(Type.String()),
  addToMemory: Type.Optional(Type.Boolean({ default: true })),
  includeMetadata: Type.Optional(Type.Boolean({ default: true })),
  cleanContent: Type.Optional(Type.Boolean({ default: true })),
  supportedFormats: Type.Optional(Type.Array(stringEnum(FORMATS))),
  maxFileSizeMb: Type.Optional(Type.Number({ default: 50 })),
});

type PluginConfig = {
  enabled?: boolean;
  outputDir?: string;
  addToMemory?: boolean;
  includeMetadata?: boolean;
  cleanContent?: boolean;
  supportedFormats?: DocumentFormat[];
  maxFileSizeMb?: number;
};

// ============================================================================
// Plugin Definition
// ============================================================================

const documentIngestPlugin = {
  id: "document-ingest",
  name: "Document Ingest",
  description: "Document ingestion pipeline for PDF, DOCX, and other formats",
  configSchema: {
    jsonSchema: configSchema,
  },

  register(api: MoltbotPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as PluginConfig;

    if (cfg.enabled === false) {
      api.logger.info("document-ingest: disabled by config");
      return;
    }

    const supportedFormats = cfg.supportedFormats || ["pdf", "docx", "txt", "md", "html"];
    const maxFileSizeBytes = (cfg.maxFileSizeMb ?? 50) * 1024 * 1024;

    const ingestDocument = async (
      filePath: string,
      options?: { outputDir?: string; addToMemory?: boolean },
    ): Promise<IngestResult> => {
      try {
        // Validate file exists and check size
        const stats = await fs.stat(filePath);
        if (stats.size > maxFileSizeBytes) {
          return {
            success: false,
            error: `File too large: ${Math.round(stats.size / 1024 / 1024)}MB exceeds ${cfg.maxFileSizeMb ?? 50}MB limit`,
          };
        }

        // Check format
        const format = detectFormat(filePath);
        if (!supportedFormats.includes(format)) {
          return {
            success: false,
            error: `Unsupported format: ${format}. Supported: ${supportedFormats.join(", ")}`,
          };
        }

        // Extract document
        const doc = await extractDocument(filePath);

        // Clean content if enabled
        if (cfg.cleanContent !== false) {
          doc.content = cleanContent(doc.content);
        }

        // Build output content
        let outputContent = "";
        if (cfg.includeMetadata !== false) {
          outputContent = generateDocumentHeader(doc);
        }
        outputContent += doc.content;

        // Determine output path
        const outputDir = options?.outputDir || cfg.outputDir;
        let outputPath: string | undefined;

        if (outputDir) {
          await fs.mkdir(outputDir, { recursive: true });
          const baseName = path.basename(filePath, path.extname(filePath));
          const hash = hashContent(doc.content);
          outputPath = path.join(outputDir, `${baseName}-${hash}.md`);
          await fs.writeFile(outputPath, outputContent, "utf-8");
        }

        // Add to memory if enabled
        if (options?.addToMemory ?? cfg.addToMemory) {
          // Memory directory is typically workspace/memory
          const memoryDir = api.resolvePath("memory");
          await fs.mkdir(memoryDir, { recursive: true });
          const baseName = path.basename(filePath, path.extname(filePath));
          const memoryPath = path.join(memoryDir, `${baseName}.md`);
          await fs.writeFile(memoryPath, outputContent, "utf-8");
          api.logger.info(`document-ingest: added to memory: ${memoryPath}`);
        }

        return {
          success: true,
          document: doc,
          outputPath,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: message,
        };
      }
    };

    // ========================================================================
    // Tools
    // ========================================================================

    api.registerTool(
      {
        name: "document_ingest",
        label: "Document Ingest",
        description:
          "Ingest a document (PDF, DOCX, TXT, MD, HTML) and extract its content as markdown. Optionally adds to memory for RAG.",
        parameters: Type.Object({
          filePath: Type.String({ description: "Path to the document file" }),
          addToMemory: Type.Optional(
            Type.Boolean({
              description: "Add extracted content to memory (default: true)",
            }),
          ),
          outputDir: Type.Optional(
            Type.String({
              description: "Directory to save the extracted markdown",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { filePath, addToMemory, outputDir } = params as {
            filePath: string;
            addToMemory?: boolean;
            outputDir?: string;
          };

          const resolved = api.resolvePath(filePath);
          const result = await ingestDocument(resolved, { addToMemory, outputDir });

          if (!result.success) {
            return {
              content: [
                { type: "text", text: `Failed to ingest document: ${result.error}` },
              ],
              details: { success: false, error: result.error },
            };
          }

          const doc = result.document!;
          const summary = [
            `Successfully ingested: ${path.basename(filePath)}`,
            `Format: ${doc.metadata.format.toUpperCase()}`,
            doc.metadata.pageCount ? `Pages: ${doc.metadata.pageCount}` : null,
            `Words: ${doc.metadata.wordCount}`,
            result.outputPath ? `Saved to: ${result.outputPath}` : null,
            addToMemory !== false ? "Added to memory for RAG" : null,
          ]
            .filter(Boolean)
            .join("\n");

          return {
            content: [{ type: "text", text: summary }],
            details: {
              success: true,
              format: doc.metadata.format,
              pageCount: doc.metadata.pageCount,
              wordCount: doc.metadata.wordCount,
              outputPath: result.outputPath,
              contentPreview: doc.content.slice(0, 500),
            },
          };
        },
      },
      { name: "document_ingest" },
    );

    api.registerTool(
      {
        name: "document_extract",
        label: "Document Extract",
        description:
          "Extract text content from a document without saving. Returns the full extracted text.",
        parameters: Type.Object({
          filePath: Type.String({ description: "Path to the document file" }),
          includeMetadata: Type.Optional(
            Type.Boolean({
              description: "Include document metadata in output (default: true)",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { filePath, includeMetadata = true } = params as {
            filePath: string;
            includeMetadata?: boolean;
          };

          try {
            const resolved = api.resolvePath(filePath);
            const doc = await extractDocument(resolved);
            let content = doc.content;

            if (cfg.cleanContent !== false) {
              content = cleanContent(content);
            }

            if (includeMetadata) {
              content = generateDocumentHeader(doc) + content;
            }

            return {
              content: [{ type: "text", text: content }],
              details: {
                format: doc.metadata.format,
                pageCount: doc.metadata.pageCount,
                wordCount: doc.metadata.wordCount,
                title: doc.metadata.title,
                author: doc.metadata.author,
              },
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              content: [
                { type: "text", text: `Failed to extract document: ${message}` },
              ],
              details: { error: message },
            };
          }
        },
      },
      { name: "document_extract" },
    );

    api.registerTool(
      {
        name: "document_batch_ingest",
        label: "Document Batch Ingest",
        description:
          "Ingest multiple documents from a directory. Supports filtering by format.",
        parameters: Type.Object({
          directory: Type.String({ description: "Directory containing documents" }),
          formats: Type.Optional(
            Type.Array(Type.String(), {
              description: "File formats to include (default: all supported)",
            }),
          ),
          recursive: Type.Optional(
            Type.Boolean({ description: "Search subdirectories (default: false)" }),
          ),
          addToMemory: Type.Optional(
            Type.Boolean({
              description: "Add extracted content to memory (default: true)",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const {
            directory,
            formats = supportedFormats,
            recursive = false,
            addToMemory = true,
          } = params as {
            directory: string;
            formats?: string[];
            recursive?: boolean;
            addToMemory?: boolean;
          };

          const resolved = api.resolvePath(directory);
          const results: Array<{ file: string; success: boolean; error?: string }> = [];

          const processDir = async (dir: string) => {
            const entries = await fs.readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);

              if (entry.isDirectory() && recursive) {
                await processDir(fullPath);
              } else if (entry.isFile()) {
                const format = detectFormat(entry.name);
                if (formats.includes(format)) {
                  const result = await ingestDocument(fullPath, { addToMemory });
                  results.push({
                    file: entry.name,
                    success: result.success,
                    error: result.error,
                  });
                }
              }
            }
          };

          await processDir(resolved);

          const successful = results.filter((r) => r.success).length;
          const failed = results.filter((r) => !r.success).length;

          const summary = [
            `Batch ingestion complete: ${successful} successful, ${failed} failed`,
            "",
            ...results.map((r) =>
              r.success ? `+ ${r.file}` : `- ${r.file}: ${r.error}`,
            ),
          ].join("\n");

          return {
            content: [{ type: "text", text: summary }],
            details: {
              total: results.length,
              successful,
              failed,
              results,
            },
          };
        },
      },
      { name: "document_batch_ingest" },
    );

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const docs = program
          .command("docs")
          .description("Document ingestion commands");

        docs
          .command("ingest")
          .description("Ingest a document")
          .argument("<file>", "Document file path")
          .option("--output <dir>", "Output directory")
          .option("--no-memory", "Don't add to memory")
          .action(async (file, opts) => {
            const result = await ingestDocument(file, {
              outputDir: opts.output,
              addToMemory: opts.memory !== false,
            });

            if (!result.success) {
              console.error(`Error: ${result.error}`);
              process.exit(1);
            }

            console.log(`\nIngested: ${file}`);
            console.log(`Format: ${result.document!.metadata.format}`);
            if (result.document!.metadata.pageCount) {
              console.log(`Pages: ${result.document!.metadata.pageCount}`);
            }
            console.log(`Words: ${result.document!.metadata.wordCount}`);
            if (result.outputPath) {
              console.log(`Output: ${result.outputPath}`);
            }
          });

        docs
          .command("extract")
          .description("Extract text from a document")
          .argument("<file>", "Document file path")
          .option("--no-metadata", "Don't include metadata")
          .option("--json", "Output as JSON")
          .action(async (file, opts) => {
            try {
              const doc = await extractDocument(file);
              let content = doc.content;

              if (cfg.cleanContent !== false) {
                content = cleanContent(content);
              }

              if (opts.json) {
                console.log(
                  JSON.stringify(
                    {
                      content: opts.metadata !== false ? generateDocumentHeader(doc) + content : content,
                      metadata: doc.metadata,
                    },
                    null,
                    2,
                  ),
                );
              } else {
                if (opts.metadata !== false) {
                  console.log(generateDocumentHeader(doc));
                }
                console.log(content);
              }
            } catch (err) {
              console.error(`Error: ${err instanceof Error ? err.message : err}`);
              process.exit(1);
            }
          });

        docs
          .command("batch")
          .description("Batch ingest documents from a directory")
          .argument("<directory>", "Directory containing documents")
          .option("-r, --recursive", "Search subdirectories")
          .option("--formats <list>", "Comma-separated list of formats")
          .option("--no-memory", "Don't add to memory")
          .action(async (directory, opts) => {
            const formats = opts.formats
              ? opts.formats.split(",")
              : supportedFormats;

            console.log(`\nIngesting documents from: ${directory}`);
            console.log(`Formats: ${formats.join(", ")}`);
            console.log(`Recursive: ${opts.recursive ? "yes" : "no"}`);
            console.log("-".repeat(50));

            let successful = 0;
            let failed = 0;

            const processDir = async (dir: string) => {
              const entries = await fs.readdir(dir, { withFileTypes: true });

              for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory() && opts.recursive) {
                  await processDir(fullPath);
                } else if (entry.isFile()) {
                  const format = detectFormat(entry.name);
                  if (formats.includes(format)) {
                    const result = await ingestDocument(fullPath, {
                      addToMemory: opts.memory !== false,
                    });
                    if (result.success) {
                      console.log(`+ ${entry.name}`);
                      successful++;
                    } else {
                      console.log(`- ${entry.name}: ${result.error}`);
                      failed++;
                    }
                  }
                }
              }
            };

            await processDir(directory);

            console.log("-".repeat(50));
            console.log(`Complete: ${successful} successful, ${failed} failed`);
          });
      },
      { commands: ["docs"] },
    );

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "document-ingest",
      start: () => {
        api.logger.info(
          `document-ingest: initialized with formats [${supportedFormats.join(", ")}]`,
        );
      },
      stop: () => {
        api.logger.info("document-ingest: stopped");
      },
    });
  },
};

export default documentIngestPlugin;
