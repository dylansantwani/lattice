import type { ToolContext, ToolDefinition } from './types'
import * as store from '../store/eventStore'

function numberArg(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback
}

/** Model-facing access to durable tool evidence after result pruning or compaction. */
export const resultTools: ToolDefinition[] = [
  {
    name: 'read_tool_result',
    description:
      'Re-read an earlier tool result that was pruned from this conversation, by the call_id shown in its ' +
      'placeholder ("Retrieve it with read_tool_result…") or in a compaction checkpoint. Only works with those ' +
      'ids — to read a file, use fs_read. Paged with offset.',
    parameters: {
      type: 'object',
      properties: {
        call_id: { type: 'string', description: 'The stable tool call id from the pruned result placeholder or checkpoint' },
        offset: { type: 'number', description: 'Character offset for paging a large result' },
        limit: { type: 'number', description: 'Maximum characters to return' }
      },
      required: ['call_id']
    },
    resource: 'filesystem',
    action: 'read',
    riskTier: 'R0',
    allowedInPlan: true,
    summarize: (args) => `Read stored tool result ${args.call_id}`,
    async run(args, ctx: ToolContext) {
      if (typeof args.call_id !== 'string' || !args.call_id.trim()) throw new Error('call_id is required.')
      const result = store.readToolResult(ctx.threadMeta.id, args.call_id, {
        offset: numberArg(args.offset, 0), limit: numberArg(args.limit, 12_000)
      })
      // Local models invent ids when they mistake this for a file reader; say how to recover in one step.
      if (!result) {
        return {
          found: false,
          call_id: args.call_id,
          hint: 'No stored result has that call_id. Ids come only from a pruned-result placeholder or compaction checkpoint in this conversation; to read a file, use fs_read.'
        }
      }
      return { found: true, ...result }
    }
  },
  {
    name: 'search_tool_results',
    description:
      'Search the results of tool calls made earlier in this conversation, including ones pruned from context or ' +
      'folded into compaction history. Not a file or code search — use grep_search for that. Returns a bounded page and next_offset.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword or tool name to search' },
        offset: { type: 'number' },
        page_size: { type: 'number', description: 'Number of result records, up to 50' },
        limit: { type: 'number', description: 'Maximum characters per result' }
      },
      required: ['query']
    },
    resource: 'filesystem',
    action: 'read',
    riskTier: 'R0',
    allowedInPlan: true,
    summarize: (args) => `Search stored tool results: ${args.query}`,
    async run(args, ctx: ToolContext) {
      if (typeof args.query !== 'string') throw new Error('query is required.')
      const page = store.searchToolResults(ctx.threadMeta.id, args.query, {
        offset: numberArg(args.offset, 0), pageSize: numberArg(args.page_size, 20), limit: numberArg(args.limit, 12_000)
      })
      return { items: page.items, ...(page.nextOffset === undefined ? {} : { next_offset: page.nextOffset }) }
    }
  }
]

