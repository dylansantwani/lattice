import React, { useEffect, useMemo, useRef } from 'react'
import type { ModelInfo } from '@shared/types'
import { useStore, activeThread } from '@/state/store'
import { chipLabel, collapseVariantsMemo, familyMark, fmtLatency, HEALTH_LOOK, healthTitle, isLocal, nameParts } from './modelCatalog'
import { modelsByBase, foldUsageByBase, quickPickModels, favoriteModelsList } from './modelOrder'
import { baseStem } from './effort'
import { I } from './Icon'

const MAX_QUICK = 7

/**
 * Compact dropdown off the composer's model chip: the current model, then your favorites, then the
 * shared recent/most-used blend (`modelOrder`), for one-click switching — each row with its source
 * and its last health ping when one exists — and a **Browse all models…** row that opens the full
 * browser. Selecting a model routes through `store.setModel`, so a mid-chat change still raises
 * the context warning.
 */
export function ModelQuickPicker({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element | null {
  const rawModels = useStore((s) => s.models)
  const recentModelIds = useStore((s) => s.recentModelIds)
  const modelUsage = useStore((s) => s.modelUsage)
  const favoriteIds = useStore((s) => s.settings?.favoriteModels)
  const modelHealth = useStore((s) => s.modelHealth)
  const thread = useStore(activeThread)
  const setModel = useStore((s) => s.setModel)
  const openModelPicker = useStore((s) => s.openModelPicker)
  const ref = useRef<HTMLDivElement>(null)

  const current = thread?.model ?? null

  // Current model pinned first, then favorites (starring order), then the recent/most-used blend,
  // de-duplicated and capped at MAX_QUICK.
  const { picks, favSet } = useMemo(() => {
    const models = collapseVariantsMemo(rawModels)
    const byBase = modelsByBase(models)
    const usage = foldUsageByBase(modelUsage)
    const favorites = favoriteModelsList(favoriteIds ?? [], models)
    const qp = quickPickModels(recentModelIds, usage, byBase, MAX_QUICK + 1)
    const currentModel = current ? byBase.get(baseStem(current)) : undefined
    const out: ModelInfo[] = currentModel ? [currentModel] : []
    for (const m of [...favorites, ...qp.picks]) {
      if (out.length >= MAX_QUICK) break
      if (!out.some((x) => x.id === m.id)) out.push(m)
    }
    return { picks: out, favSet: new Set(favorites.map((m) => m.id)) }
  }, [rawModels, recentModelIds, modelUsage, favoriteIds, current])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    // Defer the outside-click listener a frame so the click that opened the menu doesn't
    // immediately close it.
    const raf = requestAnimationFrame(() => document.addEventListener('mousedown', onDoc))
    document.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null

  const currentBase = current ? baseStem(current) : null
  const pick = (m: ModelInfo): void => {
    onClose()
    if (baseStem(m.id) !== currentBase) void setModel(m.id)
  }

  return (
    <div className="model-quick" ref={ref} role="menu" aria-label="Quick model picker">
      {picks.length === 0 ? (
        <div className="model-quick-empty">No models loaded yet</div>
      ) : (
        picks.map((m) => {
          const isCurrent = baseStem(m.id) === currentBase
          const { mark, hue } = familyMark(m)
          const { title, tag } = nameParts(m)
          const h = modelHealth[m.id]
          const pinged = h && h.status !== 'unknown'
          return (
            <button key={m.id} className={`model-quick-item ${isCurrent ? 'current' : ''}`} role="menuitemradio" aria-checked={isCurrent} onClick={() => pick(m)} title={m.id}>
              <span className="mb-avatar" style={{ ['--hue' as string]: hue }} aria-hidden="true">
                {mark}
              </span>
              <span className="mq-body">
                <span className="mq-name">
                  {title}
                  {tag && <span className="mb-tag">{tag}</span>}
                </span>
                <span className="mq-sub">
                  <span className={`mb-src ${isLocal(m) ? 'local' : ''}`}>{chipLabel(m)}</span>
                  {favSet.has(m.id) && <I name="star" size={11} className="mq-star" />}
                  {pinged && (
                    <span className={`mq-health tone-${HEALTH_LOOK[h.status as Exclude<typeof h.status, 'unknown'>].tone}`} title={healthTitle(h)}>
                      <span className={`mb-health tone-${HEALTH_LOOK[h.status as Exclude<typeof h.status, 'unknown'>].tone}`} />
                      {h.status === 'live' || h.status === 'slow' ? fmtLatency(h.latencyMs) : HEALTH_LOOK[h.status as Exclude<typeof h.status, 'unknown'>].label.toLowerCase()}
                    </span>
                  )}
                </span>
              </span>
              {isCurrent ? <I name="check" size={15} className="mq-check" /> : m.capabilities.tools ? <I name="build" size={12} className="mq-tool" /> : null}
            </button>
          )
        })
      )}
      <div className="model-quick-sep" />
      <button
        className="model-quick-item more"
        role="menuitem"
        onClick={() => {
          onClose()
          openModelPicker({ intent: 'thread' })
        }}
      >
        <I name="search" size={15} />
        <span className="mq-name">Browse all models…</span>
        <kbd className="mq-kbd">⌘M</kbd>
      </button>
    </div>
  )
}
