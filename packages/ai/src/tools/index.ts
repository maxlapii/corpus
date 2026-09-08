/** All registered tools, grouped by zone. */

import type { ToolDefinition } from '../tool-types.js'
import { EXTERNAL_TOOLS } from './external.js'
import { INTERNAL_MANAGEMENT_TOOLS } from './internal-management.js'
import { INTERNAL_SELF_TOOLS } from './internal-self.js'

export const ALL_TOOLS: readonly ToolDefinition<any>[] = [
  ...EXTERNAL_TOOLS,
  ...INTERNAL_SELF_TOOLS,
  ...INTERNAL_MANAGEMENT_TOOLS,
]

export * from './external.js'
export * from './internal-self.js'
export * from './internal-management.js'
