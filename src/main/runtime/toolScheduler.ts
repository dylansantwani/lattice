/** Fair, process-wide read/write scheduling. Paths conflict with their ancestors. */
export interface ToolLease { resources: string[]; write: boolean }
interface Waiting {
  lease: ToolLease
  signal: AbortSignal
  start: () => void
  cancel: () => void
}
const running = new Set<ToolLease>()
const waiting: Waiting[] = []

function sameResource(a: string, b: string): boolean {
  if (a === b) return true
  if (!a.startsWith('path:') || !b.startsWith('path:')) return false
  const left = a.slice(5).replace(/\/$/, '')
  const right = b.slice(5).replace(/\/$/, '')
  return left.startsWith(right + '/') || right.startsWith(left + '/')
}
function conflict(a: ToolLease, b: ToolLease): boolean {
  return (a.write || b.write) && a.resources.some(x => b.resources.some(y => sameResource(x, y)))
}
function drain(): void {
  for (let i = 0; i < waiting.length;) {
    const next = waiting[i]!
    if ([...running].some(x => conflict(x, next.lease)) || waiting.slice(0, i).some(x => conflict(x.lease, next.lease))) {
      i++
      continue
    }
    waiting.splice(i, 1)
    next.start()
  }
}

export function scheduleTool<T>(lease: ToolLease, signal: AbortSignal, execute: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Tool call canceled while waiting for its resource.'))
  return new Promise<T>((resolve, reject) => {
    const entry: Waiting = {
      lease, signal,
      start: () => {
        signal.removeEventListener('abort', entry.cancel)
        running.add(lease)
        Promise.resolve().then(() => {
          if (signal.aborted) throw new Error('Tool call canceled before execution.')
          return execute()
        }).then(resolve, reject).finally(() => { running.delete(lease); drain() })
      },
      cancel: () => {
        const index = waiting.indexOf(entry)
        if (index >= 0) waiting.splice(index, 1)
        reject(new Error('Tool call canceled while waiting for its resource.'))
        drain()
      }
    }
    signal.addEventListener('abort', entry.cancel, { once: true })
    waiting.push(entry)
    drain()
  })
}
