import { useEffect, useRef, useState } from 'react'

/** Ticks once a second while `active`, returning elapsed ms since `active` became true. */
export function useElapsed(active: boolean, startedAt?: number): number {
  const start = useRef<number | null>(null)
  const [, tick] = useState(0)

  if (active && start.current === null) start.current = startedAt ?? Date.now()
  if (!active && start.current !== null) start.current = null

  useEffect(() => {
    if (!active) return
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [active])

  return active && start.current !== null ? Date.now() - start.current : 0
}

/** "1m 30s", "45s", "1h 04m". */
export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}
