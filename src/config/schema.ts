import { z } from 'zod';

export const ViewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const ClaudeIntegrationMode = z.enum(['off', 'advisory', 'enforced']);

/**
 * .agentview/config.json — project-level configuration.
 * Every field is optional; setup fills in what it detects and
 * inspect falls back to detection for anything missing.
 */
export const AgentViewConfigSchema = z
  .object({
    $schema: z.string().optional(),
    /** Dev server command, e.g. "npm run dev". Empty string means "no dev server; url must be set". */
    devCommand: z.string().optional(),
    /** Working directory for the dev command, relative to project root. */
    cwd: z.string().optional(),
    /** Route inspected by default, e.g. "/". */
    defaultRoute: z.string().default('/'),
    /** Explicit URL override; skips port discovery entirely. */
    url: z.string().optional(),
    /** Port we expect the dev server on. Discovery may override with evidence. */
    expectedPort: z.number().int().min(1).max(65535).optional(),
    /** Ms to wait for the dev server to become reachable. */
    startupTimeoutMs: z.number().int().positive().default(60_000),
    /** Ms budget for navigation + render settle per page. */
    pageTimeoutMs: z.number().int().positive().default(20_000),
    desktopViewport: ViewportSchema.default({ width: 1440, height: 900 }),
    mobileViewport: ViewportSchema.default({ width: 390, height: 844 }),
    /** Routes inspected by `inspect --all` and watch mode. */
    routes: z.array(z.string()).default(['/']),
    /** Redact sensitive headers/params in saved network data. Keep on. */
    redact: z.boolean().default(true),
    /** Claude Code integration mode. */
    claudeIntegration: ClaudeIntegrationMode.default('off'),
    /** Automatic verification via Claude hooks. */
    autoInspect: ClaudeIntegrationMode.default('off'),
    /** Framework id detected at setup ("next", "vite", "generic"). */
    framework: z.string().optional(),
    /** Package manager detected at setup ("npm" | "pnpm" | "yarn" | "bun"). */
    packageManager: z.string().optional(),
    /** Allow non-localhost URLs (privacy guard). */
    allowRemote: z.boolean().default(false),
  })
  .strict();

export type AgentViewConfig = z.infer<typeof AgentViewConfigSchema>;
export type AgentViewConfigInput = z.input<typeof AgentViewConfigSchema>;

export const DEFAULT_CONFIG: AgentViewConfig = AgentViewConfigSchema.parse({});
