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

export { formatElapsed } from '@shared/view/format'
