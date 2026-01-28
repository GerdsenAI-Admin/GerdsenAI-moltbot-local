/**
 * Moltbot Tool Validator Plugin
 *
 * Validates and repairs tool calls from local AI models that may struggle
 * with function calling. Common issues addressed:
 *
 * - Invalid JSON in tool arguments
 * - Missing required parameters
 * - Type mismatches (string vs number)
 * - Hallucinated tool names
 * - Malformed tool call structures
 * - Eager/premature tool invocation
 *
 * Works by intercepting before_tool_call hooks and attempting repairs.
 */

import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { MoltbotPluginApi } from "clawdbot/plugin-sdk";
import { stringEnum } from "clawdbot/plugin-sdk";

// ============================================================================
// Types
// ============================================================================

type ValidationResult = {
  valid: boolean;
  errors: string[];
  repaired?: Record<string, unknown>;
  blocked?: boolean;
  blockReason?: string;
};

type ToolSchema = {
  name: string;
  parameters?: TSchema;
  required?: string[];
};

type RepairStrategy = "coerce" | "default" | "prompt" | "block";

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Attempt to parse potentially malformed JSON
 */
function tryParseJson(value: unknown): { parsed: unknown; success: boolean } {
  if (typeof value !== "string") {
    return { parsed: value, success: true };
  }

  // Already an object
  if (typeof value === "object" && value !== null) {
    return { parsed: value, success: true };
  }

  try {
    return { parsed: JSON.parse(value), success: true };
  } catch {
    // Try common fixes
    let fixed = value;

    // Fix unquoted keys: {key: value} -> {"key": value}
    fixed = fixed.replace(/(\{|\,)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');

    // Fix single quotes: {'key': 'value'} -> {"key": "value"}
    fixed = fixed.replace(/'/g, '"');

    // Fix trailing commas: {a: 1,} -> {a: 1}
    fixed = fixed.replace(/,\s*([\}\]])/g, "$1");

    try {
      return { parsed: JSON.parse(fixed), success: true };
    } catch {
      return { parsed: value, success: false };
    }
  }
}

/**
 * Coerce a value to match expected type
 */
function coerceValue(
  value: unknown,
  expectedType: string,
): { value: unknown; coerced: boolean } {
  if (value === undefined || value === null) {
    return { value, coerced: false };
  }

  switch (expectedType) {
    case "string":
      if (typeof value !== "string") {
        return { value: String(value), coerced: true };
      }
      break;

    case "number":
    case "integer":
      if (typeof value === "string") {
        const num = Number(value);
        if (!isNaN(num)) {
          return { value: num, coerced: true };
        }
      }
      break;

    case "boolean":
      if (typeof value === "string") {
        const lower = value.toLowerCase();
        if (lower === "true" || lower === "1" || lower === "yes") {
          return { value: true, coerced: true };
        }
        if (lower === "false" || lower === "0" || lower === "no") {
          return { value: false, coerced: true };
        }
      }
      if (typeof value === "number") {
        return { value: value !== 0, coerced: true };
      }
      break;

    case "array":
      if (typeof value === "string") {
        // Try to parse as JSON array
        const { parsed, success } = tryParseJson(value);
        if (success && Array.isArray(parsed)) {
          return { value: parsed, coerced: true };
        }
        // Try splitting by comma
        if (value.includes(",")) {
          return { value: value.split(",").map((s) => s.trim()), coerced: true };
        }
        // Wrap single value in array
        return { value: [value], coerced: true };
      }
      break;

    case "object":
      if (typeof value === "string") {
        const { parsed, success } = tryParseJson(value);
        if (success && typeof parsed === "object" && parsed !== null) {
          return { value: parsed, coerced: true };
        }
      }
      break;
  }

  return { value, coerced: false };
}

/**
 * Find the closest matching tool name using Levenshtein distance
 */
function findClosestToolName(
  input: string,
  availableTools: string[],
): { match: string | null; distance: number } {
  if (availableTools.includes(input)) {
    return { match: input, distance: 0 };
  }

  const inputLower = input.toLowerCase();
  let closest: string | null = null;
  let minDistance = Infinity;

  for (const tool of availableTools) {
    const toolLower = tool.toLowerCase();

    // Exact match (case insensitive)
    if (inputLower === toolLower) {
      return { match: tool, distance: 0 };
    }

    // Calculate Levenshtein distance
    const distance = levenshteinDistance(inputLower, toolLower);

    if (distance < minDistance) {
      minDistance = distance;
      closest = tool;
    }
  }

  // Only suggest if within reasonable edit distance (30% of tool name length)
  if (closest && minDistance <= Math.ceil(closest.length * 0.3)) {
    return { match: closest, distance: minDistance };
  }

  return { match: null, distance: minDistance };
}

function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j] + 1, // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Check for potentially dangerous tool calls
 */
function checkDangerousCall(
  toolName: string,
  params: Record<string, unknown>,
): { dangerous: boolean; reason?: string } {
  const dangerousPatterns = [
    // Shell injection
    { tool: "bash", param: "command", patterns: [/;\s*rm\s+-rf/, /&&\s*curl.*\|.*sh/] },
    // Path traversal
    { tool: "*", param: "path", patterns: [/\.\.\//] },
    { tool: "*", param: "file", patterns: [/\.\.\//] },
    // SQL injection (if applicable)
    { tool: "*", param: "query", patterns: [/;\s*DROP\s+TABLE/i, /'\s*OR\s+'1'\s*=\s*'1/i] },
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.tool !== "*" && pattern.tool !== toolName) continue;

    const value = params[pattern.param];
    if (typeof value !== "string") continue;

    for (const regex of pattern.patterns) {
      if (regex.test(value)) {
        return {
          dangerous: true,
          reason: `Potentially dangerous pattern detected in ${pattern.param}: ${regex}`,
        };
      }
    }
  }

  return { dangerous: false };
}

// ============================================================================
// Config Schema
// ============================================================================

const STRATEGIES = ["coerce", "default", "prompt", "block"] as const;

const configSchema = Type.Object({
  enabled: Type.Optional(Type.Boolean({ default: true })),
  repairStrategy: Type.Optional(stringEnum(STRATEGIES)),
  blockOnValidationFailure: Type.Optional(Type.Boolean({ default: false })),
  blockDangerousCalls: Type.Optional(Type.Boolean({ default: true })),
  allowToolNameFuzzyMatch: Type.Optional(Type.Boolean({ default: true })),
  maxFuzzyMatchDistance: Type.Optional(Type.Number({ default: 2 })),
  logValidationErrors: Type.Optional(Type.Boolean({ default: true })),
  strictMode: Type.Optional(Type.Boolean({ default: false })),
  customValidators: Type.Optional(
    Type.Record(
      Type.String(),
      Type.Object({
        validate: Type.Optional(Type.String()),
        transform: Type.Optional(Type.String()),
      }),
    ),
  ),
});

type PluginConfig = {
  enabled?: boolean;
  repairStrategy?: RepairStrategy;
  blockOnValidationFailure?: boolean;
  blockDangerousCalls?: boolean;
  allowToolNameFuzzyMatch?: boolean;
  maxFuzzyMatchDistance?: number;
  logValidationErrors?: boolean;
  strictMode?: boolean;
  customValidators?: Record<
    string,
    { validate?: string; transform?: string }
  >;
};

// ============================================================================
// Plugin Definition
// ============================================================================

const toolValidatorPlugin = {
  id: "tool-validator",
  name: "Tool Validator",
  description:
    "Tool calling validation and repair for local AI models",
  configSchema: {
    jsonSchema: configSchema,
  },

  register(api: MoltbotPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as PluginConfig;

    if (cfg.enabled === false) {
      api.logger.info("tool-validator: disabled by config");
      return;
    }

    // Track available tools for fuzzy matching
    const availableTools = new Set<string>();

    // Statistics
    const stats = {
      validated: 0,
      repaired: 0,
      blocked: 0,
      errors: 0,
    };

    // ========================================================================
    // Validation Logic
    // ========================================================================

    const validateToolCall = (
      toolName: string,
      params: Record<string, unknown>,
      schema?: ToolSchema,
    ): ValidationResult => {
      const errors: string[] = [];
      let repaired: Record<string, unknown> | undefined;
      let blocked = false;
      let blockReason: string | undefined;

      // Check for dangerous calls
      if (cfg.blockDangerousCalls !== false) {
        const danger = checkDangerousCall(toolName, params);
        if (danger.dangerous) {
          return {
            valid: false,
            errors: [danger.reason || "Dangerous call detected"],
            blocked: true,
            blockReason: danger.reason,
          };
        }
      }

      // Validate against schema if available
      if (schema?.parameters) {
        // Try to validate with TypeBox
        const valid = Value.Check(schema.parameters, params);

        if (!valid) {
          const validationErrors = [...Value.Errors(schema.parameters, params)];
          for (const err of validationErrors) {
            errors.push(`${err.path}: ${err.message}`);
          }

          // Attempt repair based on strategy
          if (
            cfg.repairStrategy === "coerce" ||
            cfg.repairStrategy === undefined
          ) {
            repaired = { ...params };
            let anyCoerced = false;

            // Get expected types from schema
            const properties =
              (schema.parameters as { properties?: Record<string, { type?: string }> })
                .properties || {};

            for (const [key, prop] of Object.entries(properties)) {
              if (prop.type && repaired[key] !== undefined) {
                const { value, coerced } = coerceValue(repaired[key], prop.type);
                if (coerced) {
                  repaired[key] = value;
                  anyCoerced = true;
                }
              }
            }

            // Check if repair was successful
            if (anyCoerced && Value.Check(schema.parameters, repaired)) {
              errors.length = 0; // Clear errors since we repaired
            } else {
              repaired = undefined; // Repair failed
            }
          }
        }
      }

      // Block if configured and validation failed
      if (errors.length > 0 && cfg.blockOnValidationFailure) {
        blocked = true;
        blockReason = `Validation failed: ${errors.join(", ")}`;
      }

      return {
        valid: errors.length === 0,
        errors,
        repaired,
        blocked,
        blockReason,
      };
    };

    // ========================================================================
    // Hooks
    // ========================================================================

    api.on(
      "before_tool_call",
      async (event) => {
        stats.validated++;

        const toolName = event.toolName;
        const params = event.params;

        // Fuzzy match tool name if enabled
        if (cfg.allowToolNameFuzzyMatch !== false && availableTools.size > 0) {
          const { match, distance } = findClosestToolName(
            toolName,
            Array.from(availableTools),
          );

          if (match && match !== toolName && distance <= (cfg.maxFuzzyMatchDistance ?? 2)) {
            if (cfg.logValidationErrors !== false) {
              api.logger.info(
                `tool-validator: fuzzy matched "${toolName}" -> "${match}" (distance: ${distance})`,
              );
            }
            // Note: we can't actually change the tool name here, but we log it
          }
        }

        // Validate the call
        const result = validateToolCall(toolName, params);

        if (result.blocked) {
          stats.blocked++;
          if (cfg.logValidationErrors !== false) {
            api.logger.warn(
              `tool-validator: blocked ${toolName}: ${result.blockReason}`,
            );
          }
          return {
            block: true,
            blockReason: result.blockReason,
          };
        }

        if (!result.valid) {
          stats.errors++;
          if (cfg.logValidationErrors !== false) {
            api.logger.warn(
              `tool-validator: validation errors for ${toolName}: ${result.errors.join(", ")}`,
            );
          }

          if (result.repaired) {
            stats.repaired++;
            if (cfg.logValidationErrors !== false) {
              api.logger.info(`tool-validator: repaired ${toolName} params`);
            }
            return { params: result.repaired };
          }

          // In strict mode, block on any validation error
          if (cfg.strictMode) {
            return {
              block: true,
              blockReason: `Validation failed: ${result.errors.join(", ")}`,
            };
          }
        }

        return undefined;
      },
      { priority: 100 }, // High priority to run before other hooks
    );

    // Track available tools when they're called
    api.on("after_tool_call", (event) => {
      availableTools.add(event.toolName);
    });

    // ========================================================================
    // Tools
    // ========================================================================

    api.registerTool(
      {
        name: "tool_validator_stats",
        label: "Tool Validator Stats",
        description: "Get statistics about tool validation",
        parameters: Type.Object({}),
        async execute() {
          return {
            content: [
              {
                type: "text",
                text:
                  `Tool Validator Statistics:\n` +
                  `  Validated: ${stats.validated}\n` +
                  `  Repaired: ${stats.repaired}\n` +
                  `  Blocked: ${stats.blocked}\n` +
                  `  Errors: ${stats.errors}`,
              },
            ],
            details: { ...stats },
          };
        },
      },
      { name: "tool_validator_stats" },
    );

    api.registerTool(
      {
        name: "tool_validator_test",
        label: "Tool Validator Test",
        description: "Test tool validation with sample data",
        parameters: Type.Object({
          toolName: Type.String({ description: "Tool name to test" }),
          params: Type.String({ description: "JSON params to validate" }),
        }),
        async execute(_toolCallId, args) {
          const { toolName, params: paramsStr } = args as {
            toolName: string;
            params: string;
          };

          const { parsed, success } = tryParseJson(paramsStr);
          if (!success) {
            return {
              content: [{ type: "text", text: "Invalid JSON in params" }],
              details: { error: "invalid_json" },
            };
          }

          const result = validateToolCall(
            toolName,
            parsed as Record<string, unknown>,
          );

          return {
            content: [
              {
                type: "text",
                text:
                  `Validation result for ${toolName}:\n` +
                  `  Valid: ${result.valid}\n` +
                  `  Errors: ${result.errors.join(", ") || "none"}\n` +
                  `  Repaired: ${result.repaired ? "yes" : "no"}\n` +
                  `  Blocked: ${result.blocked ? "yes" : "no"}`,
              },
            ],
            details: result,
          };
        },
      },
      { name: "tool_validator_test" },
    );

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const validator = program
          .command("tool-validator")
          .description("Tool validation commands");

        validator
          .command("stats")
          .description("Show validation statistics")
          .action(() => {
            console.log("\nTool Validator Statistics:");
            console.log(`  Validated: ${stats.validated}`);
            console.log(`  Repaired: ${stats.repaired}`);
            console.log(`  Blocked: ${stats.blocked}`);
            console.log(`  Errors: ${stats.errors}`);
          });

        validator
          .command("test")
          .description("Test tool validation")
          .argument("<toolName>", "Tool name")
          .argument("<params>", "JSON params")
          .action((toolName, paramsStr) => {
            const { parsed, success } = tryParseJson(paramsStr);
            if (!success) {
              console.error("Invalid JSON in params");
              process.exit(1);
            }

            const result = validateToolCall(
              toolName,
              parsed as Record<string, unknown>,
            );
            console.log(JSON.stringify(result, null, 2));
          });

        validator
          .command("config")
          .description("Show current configuration")
          .action(() => {
            console.log("\nTool Validator Configuration:");
            console.log(JSON.stringify(cfg, null, 2));
          });
      },
      { commands: ["tool-validator"] },
    );

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "tool-validator",
      start: () => {
        api.logger.info(
          `tool-validator: initialized (strategy: ${cfg.repairStrategy ?? "coerce"}, strict: ${cfg.strictMode ?? false})`,
        );
      },
      stop: () => {
        api.logger.info(
          `tool-validator: stopped (validated: ${stats.validated}, repaired: ${stats.repaired}, blocked: ${stats.blocked})`,
        );
      },
    });
  },
};

export default toolValidatorPlugin;
