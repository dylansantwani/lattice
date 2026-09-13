import { useEffect, useRef, useState } from 'react'

const REDUCED_MOTION =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false

/** Reveal streamed text a few characters per frame so it flows instead of jumping in chunks. */
export function useSmoothText(target: string, streaming: boolean): string {
  const smooth = streaming && !REDUCED_MOTION
  const [shown, setShown] = useState(smooth ? '' : target)
  const shownLen = useRef(smooth ? 0 : target.length)

  useEffect(() => {
    if (!smooth) {
      shownLen.current = target.length
      setShown(target)
      return
    }
    // target shrank (shouldn't for a single message) — snap back
    if (shownLen.current > target.length) {
      shownLen.current = target.length
      setShown(target.slice(0, target.length))
    }
    let cancelled = false
    let raf = 0
    const step = (): void => {
      if (cancelled) return
      const cur = shownLen.current
      if (cur < target.length) {
        const remaining = target.length - cur
        // catch-up curve: bigger gaps reveal faster, so we never fall far behind
        const inc = Math.max(2, Math.ceil(remaining / 6))
        const next = Math.min(target.length, cur + inc)
        shownLen.current = next
        setShown(target.slice(0, next))
        raf = requestAnimationFrame(step)
      }
    }
    raf = requestAnimationFrame(step)
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [target, smooth])

  return shown
}
