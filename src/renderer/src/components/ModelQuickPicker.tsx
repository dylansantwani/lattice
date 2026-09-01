import React, { useEffect, useMemo, useRef } from 'react'
import type { ModelInfo } from '@shared/types'
import { useStore, activeThread } from '@/state/store'
import { collapseVariants } from './ModelPicker'
import { modelsByBase, foldUsageByBase, quickPickModels } from './modelOrder'
import { baseStem } from './effort'
import { I } from './Icon'

const MAX_QUICK = 5

/**
 * Compact dropdown off the composer's model chip: the current model plus a few recent/most-used
 * routes for one-click switching, and a **More models…** row that opens the full picker. Selecting
 * a model routes through `store.setModel`, so a mid-chat change still raises the context warning.
 * Ordering reuses the shared quick-picks blend (`modelOrder`) that also drives the full picker's
 * top strip — recency primary, usage fallback.
 */
export function ModelQuickPicker({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const rawModels = useStore((s) => s.models)
  const recentModelIds = useStore((s) => s.recentModelIds)
  const modelUsage = useStore((s) => s.modelUsage)
  const thread = useStore(activeThread)
  const setModel = useStore((s) => s.setModel)
  const setUi = useStore((s) => s.setUi)
  const ref = useRef<HTMLDivElement>(null)

  const current = thread?.model ?? null

  // Current model pinned first, then the shared recent/most-used blend (minus the current row),
  // capped at MAX_QUICK. Same ordering the full picker's top strip uses.
  const picks = useMemo<ModelInfo[]>(() => {
    const models = collapseVariants(rawModels)
    const byBase = modelsByBase(models)
    const usage = foldUsageByBase(modelUsage)
    const qp = quickPickModels(recentModelIds, usage, byBase, MAX_QUICK + 1)
    const currentModel = current ? byBase.get(baseStem(current)) : undefined
    const out: ModelInfo[] = currentModel ? [currentModel] : []
    for (const m of qp.picks) {
      if (out.length >= MAX_QUICK) break
      if (!out.some((x) => x.id === m.id)) out.push(m)
    }
    return out
  }, [rawModels, recentModelIds, modelUsage, current])

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
          return (
            <button
              key={m.id}
              className={`model-quick-item ${isCurrent ? 'current' : ''}`}
              role="menuitemradio"
              aria-checked={isCurrent}
              onClick={() => pick(m)}
            >
              <I name={isCurrent ? 'check' : 'model_training'} size={15} />
              <span className="mq-name">{m.name}</span>
              {m.capabilities.tools && <I name="build" size={12} className="mq-tool" />}
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
          setUi({ modelPickerOpen: true })
        }}
      >
        <I name="search" size={15} />
        <span className="mq-name">More models…</span>
      </button>
    </div>
  )
}
