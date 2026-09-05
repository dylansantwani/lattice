import { useMemo } from 'react'
import type { RunEvent } from '@shared/types'
import { useStore } from '@/state/store'
import { indexSubagents, type SubagentIndex } from './subagents'

/**
 * The subagent index is folded from the thread's whole event list, so it's computed once per
 * events snapshot (keyed by array identity) and shared by every consumer on screen — the
 * transcript's subagent cards, the Agents panel, and the inspector's tab badge — not once per
 * card per event, which would be O(cards × events) on every streamed delta.
 */
const indexCache = new WeakMap<RunEvent[], SubagentIndex>()

export function useSubagentIndex(): SubagentIndex {
  const events = useStore((s) => s.events)
  return useMemo(() => {
    let idx = indexCache.get(events)
    if (!idx) {
      idx = indexSubagents(events)
      indexCache.set(events, idx)
    }
    return idx
  }, [events])
}
