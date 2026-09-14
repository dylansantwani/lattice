/**
 * Fleet lab — mounts the real Agent Fleet screen (<FleetScreen/>) outside Electron, on fleets read
 * from the local DB through vite.harness.config.ts. `window.lattice` is stubbed with read-only
 * endpoints; every write is a no-op. URL params:
 *   ?fleet=<id>            which fleet to select first (default: most recently updated)
 *   &running=Name,Name     mark those agents as running, to see live lines/pulses
 *   &theme=graphite|paper  app theme
 */
import React, { useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/instrument-sans'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import 'material-symbols/outlined.css'
import '@/theme/global.css'
import { useStore } from '@/state/store'
import { FleetScreen } from '@/components/Fleet'
import { DEFAULT_SETTINGS, type FleetAgentView, type ModelInfo } from '@shared/types'

const params = new URLSearchParams(location.search)
const running = new Set((params.get('running') ?? '').split(',').map((s) => s.trim()).filter(Boolean))
const json = async <T,>(path: string): Promise<T> => {
  const r = await fetch(path)
  if (!r.ok) throw new Error(await r.text())
  return r.json() as Promise<T>
}

const api: Record<string, (...args: never[]) => unknown> = {
  listFleets: async () => {
    const rows = await json<{ id: string }[]>('/api/fleets')
    const first = params.get('fleet')
    return first ? [...rows.filter((f) => f.id === first), ...rows.filter((f) => f.id !== first)] : rows
  },
  listAgents: async (id: string) =>
    (await json<FleetAgentView[]>(`/api/fleet/${id}/agents`)).map((a) =>
      running.has(a.name)
        ? { ...a, running: true, status: 'running', statusText: 'running · web_fetch', activity: 'Fetching ebay.com sold listings' }
        : a
    ),
  listFleetActivity: async (id: string) => json(`/api/fleet/${id}/activity`),
  listFleetChanges: async (id: string) => json(`/api/fleet/${id}/changes`),
  getThread: async (id: string) => {
    const dump = await json<{ events: unknown[]; messages: unknown[] }>(`/api/thread/${id}`)
    return { ...dump, events: dump.events.slice(-400) }
  },
  getSessionActivity: async () => ({ messages: [], tools: [] }),
  getContextBudget: async (threadId: string) => {
    const n = [...threadId].reduce((a, c) => a + c.charCodeAt(0), 0)
    const occupancy = ((n % 70) + 5) / 100
    return { model: '', contextLength: 256000, segments: {}, usedTokens: Math.round(occupancy * 200000), usableTokens: 200000, occupancy }
  },
  getAgentWorkingMemory: async (agentId: string) => ({ agentId, path: '~/agents/memory.md', content: '# Working memory\n', exists: false, chars: 18, softLimit: 6000 }),
  onPush: () => () => {}
}
;(window as unknown as { lattice: unknown }).lattice = new Proxy(api, {
  get: (target, key: string) => target[key] ?? (async () => undefined)
})

function Lab(): React.JSX.Element {
  useEffect(() => {
    document.documentElement.dataset.theme = params.get('theme') ?? 'graphite'
    document.documentElement.dataset.density = 'comfortable'
    useStore.setState({
      ready: true,
      settings: { ...DEFAULT_SETTINGS },
      ui: { ...useStore.getState().ui, fleetOpen: true }
    })
    void json<ModelInfo[]>('/api/models').then((models) => useStore.setState({ models })).catch(() => {})
  }, [])
  return <FleetScreen />
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Lab />)
