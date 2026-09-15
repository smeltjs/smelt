export { createSmeltMcpServer, SERVER_NAME, SERVER_VERSION } from './server.ts';
export type { SmeltMcpServer, SmeltMcpServerOptions } from './server.ts';
export { RETRIEVE_BATCH_TOOL_NAME, RETRIEVE_TOOL_NAME } from '@smeltjs/core';
export {
  REPO_MAP_TOOL_NAME,
  SERVER_INSTRUCTIONS,
  SMELT_FILE_TOOL_NAME,
  SMELT_STATS_TOOL_NAME,
  TOOL_SURFACE_BUDGET_BYTES,
  toolSurface,
} from './surface.ts';
export type { ToolSurface, ToolSurfaceInput } from './surface.ts';
export { resolveMcpStore } from './store.ts';
export type { ResolvedMcpStore } from './store.ts';
