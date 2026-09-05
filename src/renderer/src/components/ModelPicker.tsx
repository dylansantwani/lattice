import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ModelInfo } from '@shared/types'
import { useStore, activeThread } from '@/state/store'
import { fmtTokens } from './ContextOrbit'
import { I } from './Icon'
import { baseStem } from './effort'
import { modelsByBase, foldUsageByBase, quickPickModels, favoriteModelsList } from './modelOrder'
import {
  buildSections,
  chipLabel,
  collapseVariantsMemo,
  DEFAULT_FILTERS,
  flattenSections,
  fmtPrice,
  HEADER_ROW_H,
  isExperimental,
  isFree,
  isLocal,
  MODEL_ROW_H,
  providerLabel,
  providerMeta,
  routeTail,
  rowOffsets,
  SORT_OPTIONS,
  sourceKey,
  sourceRank,
  visibleRange,
  type CapKey,
  type PickerFilters,
  type PickerRow,
  type SortKey
} from './modelCatalog'

// Pure catalog logic lives in ./modelCatalog; re-exported so existing imports keep working.
export { sourceKey, chipLabel, collapseVariants, SOURCE_GROUP_OPTIONS } from './modelCatalog'

/** Stable empty lists so a missing setting never re-renders the picker every store tick. */
const NO_IDS: string[] = []
const NO_COLLAPSED: ReadonlySet<string> = new Set()

const CAP_CHIPS: { key: CapKey; label: string; icon: string }[] = [
  { key: 'tools', label: 'Tools', icon: 'build' },
  { key: 'vision', label: 'Vision', icon: 'visibility' },
  { key: 'reasoning', label: 'Reasoning', icon: 'neurology' }
]

/**
 * The model picker (⌘M): one search box, one row of filters, and a virtualized list of every
 * model grouped by where it comes from. Rows are single-line; the star / pin / robot toggles
 * (favorite, default for new threads, subagent-eligible) sit on the right and only light up
 * when set. Only the rows in view are rendered, so a 1000+ model gateway listing stays instant.
 */
export function ModelPicker(): React.JSX.Element | null {
  const open = useStore((s) => s.ui.modelPickerOpen)
  const setUi = useStore((s) => s.setUi)
  const rawModels = useStore((s) => s.models)
  const thread = useStore(activeThread)
  const setModel = useStore((s) => s.setModel)
  const setDefaultModel = useStore((s) => s.setDefaultModel)
  const toggleSubagentModel = useStore((s) => s.toggleSubagentModel)
  const toggleFavoriteModel = useStore((s) => s.toggleFavoriteModel)
  const subagentModels = useStore((s) => s.settings?.subagentModels) ?? NO_IDS
  const favoriteModels = useStore((s) => s.settings?.favoriteModels) ?? NO_IDS
  const recentModelIds = useStore((s) => s.recentModelIds)
  const modelUsage = useStore((s) => s.modelUsage)
  const defaultModel = useStore((s) => s.settings?.defaultModel)

  const [filters, setFilters] = useState<PickerFilters>(DEFAULT_FILTERS)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(NO_COLLAPSED)
  const [selected, setSelected] = useState(0)
  // Whether the last selection change came from the keyboard (scroll to keep it in view) or the
  // mouse (never scroll — that would fight the pointer).
  const selectedByKey = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(400)

  const models = useMemo(() => collapseVariantsMemo(rawModels), [rawModels])
  const byBase = useMemo(() => modelsByBase(models), [models])
  const usageByBase = useMemo(() => foldUsageByBase(modelUsage), [modelUsage])
  const quickPicks = useMemo(() => quickPickModels(recentModelIds, usageByBase, byBase), [recentModelIds, byBase, usageByBase])
  const favorites = useMemo(() => favoriteModelsList(favoriteModels, models), [favoriteModels, models])
  const favSet = useMemo(() => new Set(favorites.map((m) => m.id)), [favorites])
  const subagentSet = useMemo(() => new Set(subagentModels), [subagentModels])
  const defaultBase = defaultModel ? baseStem(defaultModel) : null
  const currentId = thread?.model

  // Distinct sources with counts, ranked so subscriptions and local rigs lead and free bridges trail.
  const sources = useMemo(() => {
    const counts = new Map<string, number>()
    for (const m of models) counts.set(sourceKey(m), (counts.get(sourceKey(m)) ?? 0) + 1)
    return [...counts.entries()]
      .map(([id, count]) => ({ id, count, label: providerLabel(id), local: providerMeta(id).local === true }))
      .sort((a, b) => sourceRank(a.id) - sourceRank(b.id) || b.count - a.count || a.label.localeCompare(b.label))
  }, [models])
  const hasLocal = useMemo(() => sources.some((s) => s.local), [sources])
  const hasFree = useMemo(() => models.some(isFree), [models])
  const experimentalCount = useMemo(() => models.filter(isExperimental).length, [models])

  const sections = useMemo(
    () => buildSections(models, filters, { favorites, usageByBase, quickPicks }),
    [models, filters, favorites, usageByBase, quickPicks]
  )
  const { rows, models: visibleModels } = useMemo(() => flattenSections(sections, collapsed), [sections, collapsed])
  const { offsets, total } = useMemo(() => rowOffsets(rows), [rows])
  const [first, last] = visibleRange(offsets, total, scrollTop, viewportH)

  const patch = useCallback((p: Partial<PickerFilters>) => {
    setFilters((f) => ({ ...f, ...p }))
    setSelected(0)
    selectedByKey.current = true
  }, [])

  // Fresh state every time the picker opens — and ONLY then. Resetting on every model-list refresh
  // (the old behavior) wiped a half-typed search whenever the gateway re-listed.
  useEffect(() => {
    if (!open) return
    setFilters(DEFAULT_FILTERS)
    setCollapsed(NO_COLLAPSED)
    setSelected(0)
    setScrollTop(0)
    selectedByKey.current = true
    const id = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(id)
  }, [open])

  useEffect(() => {
    setSelected((i) => Math.max(0, Math.min(i, visibleModels.length - 1)))
  }, [visibleModels.length])

  // Track the list's real height so the virtual window matches the viewport.
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el || !open) return
    const measure = (): void => setViewportH(el.clientHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [open])

  // Keep the keyboard-selected row in view. Mouse hover never scrolls.
  useEffect(() => {
    const el = listRef.current
    if (!el || !selectedByKey.current) return
    const rowIndex = rows.findIndex((r) => r.kind === 'model' && r.index === selected)
    if (rowIndex < 0) return
    const top = offsets[rowIndex]!
    const bottom = top + MODEL_ROW_H
    if (top < el.scrollTop) el.scrollTop = Math.max(0, top - HEADER_ROW_H)
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight
  }, [selected, rows, offsets])

  if (!open) return null

  const close = (): void => setUi({ modelPickerOpen: false })
  const choose = (id: string): void => {
    void setModel(id)
    close()
  }
  const toggleSection = (key: string): void => {
    setCollapsed((c) => {
      const next = new Set(c)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const n = visibleModels.length
    const page = Math.max(1, Math.floor(viewportH / MODEL_ROW_H) - 1)
    // Functional updates: a burst of key repeats lands within one render, and reading the stale
    // `selected` from the closure would collapse three presses into one step.
    const move = (delta: number | ((i: number) => number)): void => {
      selectedByKey.current = true
      setSelected((i) => Math.max(0, Math.min(typeof delta === 'number' ? i + delta : delta(i), n - 1)))
    }
    if (event.key === 'Escape') close()
    else if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(-1)
    } else if (event.key === 'PageDown') {
      event.preventDefault()
      move(page)
    } else if (event.key === 'PageUp') {
      event.preventDefault()
      move(-page)
    } else if (event.key === 'Home' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      move(() => 0)
    } else if (event.key === 'End' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      move(() => n - 1)
    } else if (event.key === 'Enter' && visibleModels[selected]) {
      event.preventDefault()
      choose(visibleModels[selected].id)
    }
  }

  const chip = (active: boolean, label: React.ReactNode, onClick: () => void, opts: { icon?: string; title?: string; className?: string } = {}): React.JSX.Element => (
    <button
      key={String(label)}
      className={`cap-chip ${opts.className ?? ''} ${active ? 'active' : ''}`}
      aria-pressed={active}
      title={opts.title}
      onClick={onClick}
    >
      {opts.icon && <I name={opts.icon} size={13} />}
      {label}
    </button>
  )

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div className="palette model-palette" onKeyDown={onKeyDown} role="dialog" aria-label="Choose model">
        <div className="model-search">
          <I name="search" size={18} className="model-search-icon" />
          <input
            ref={inputRef}
            placeholder="Search models…"
            value={filters.query}
            onChange={(event) => patch({ query: event.target.value })}
            aria-label="Search models"
            aria-activedescendant={visibleModels[selected] ? `model-option-${visibleModels[selected].id}` : undefined}
            spellCheck={false}
          />
          <span className="model-count" title={`${models.length} models available`}>
            {visibleModels.length === models.length ? models.length : `${visibleModels.length} of ${models.length}`}
          </span>
          <kbd className="model-kbd" onClick={close} title="Close">
            esc
          </kbd>
        </div>

        <div className="model-filters" aria-label="Model filters">
          <div className="cap-chips" role="group" aria-label="Filters">
            {favorites.length > 0 &&
              chip(filters.favOnly, `Favorites · ${favorites.length}`, () => patch({ favOnly: !filters.favOnly }), {
                icon: 'star',
                className: 'fav',
                title: 'Only starred models'
              })}
            {hasLocal &&
              chip(filters.localOnly, 'Local', () => patch({ localOnly: !filters.localOnly }), {
                icon: 'hard_drive',
                title: 'Only models on your own machines'
              })}
            {hasFree &&
              chip(filters.freeOnly, 'Free', () => patch({ freeOnly: !filters.freeOnly }), {
                icon: 'savings',
                title: 'Local, or priced at $0'
              })}
            {CAP_CHIPS.map((c) =>
              chip(filters.caps[c.key], c.label, () => patch({ caps: { ...filters.caps, [c.key]: !filters.caps[c.key] } }), {
                icon: c.icon
              })
            )}
            {experimentalCount > 0 &&
              chip(filters.showExperimental, `Experimental · ${experimentalCount}`, () => patch({ showExperimental: !filters.showExperimental }), {
                icon: 'science',
                title: 'Free, no-auth web bridges and community pools — hidden by default'
              })}
          </div>
          <div className="filter-spacer" />
          <select
            className="mini-select"
            value={filters.source}
            aria-label="Source"
            title="Source"
            onChange={(e) => patch({ source: e.target.value })}
          >
            <option value="all">All sources</option>
            {sources.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} ({p.count})
              </option>
            ))}
          </select>
          <select
            className="mini-select"
            value={filters.sort}
            aria-label="Sort"
            disabled={!!filters.query.trim()}
            title={filters.query.trim() ? 'Sorted by relevance while searching' : 'Sort'}
            onChange={(e) => patch({ sort: e.target.value as SortKey })}
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div
          className="palette-list model-list"
          ref={listRef}
          role="listbox"
          aria-label="Models"
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        >
          {rows.length === 0 ? (
            <div className="model-picker-empty">{models.length === 0 ? 'No models — check provider settings.' : 'No matching models.'}</div>
          ) : (
            <div className="model-list-inner" style={{ height: total }}>
              {rows.slice(first, last + 1).map((row, i) => {
                const idx = first + i
                const top = offsets[idx]!
                if (row.kind === 'header') return <SectionHeader key={row.key} row={row} top={top} onToggle={() => toggleSection(row.section.key)} />
                const model = row.model
                return (
                  <ModelRow
                    key={row.key}
                    model={model}
                    top={top}
                    selected={row.index === selected}
                    current={model.id === currentId}
                    favorite={favSet.has(model.id)}
                    isDefault={baseStem(model.id) === defaultBase}
                    subagent={subagentSet.has(model.id)}
                    used={usageByBase.get(baseStem(model.id)) ?? 0}
                    onHover={() => {
                      selectedByKey.current = false
                      setSelected(row.index)
                    }}
                    onChoose={() => choose(model.id)}
                    onStar={() => void toggleFavoriteModel(model.id)}
                    onPin={() => void setDefaultModel(model.id)}
                    onRobot={() => void toggleSubagentModel(model.id)}
                  />
                )
              })}
            </div>
          )}
        </div>

        <div className="model-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> select
          </span>
          <span className="model-foot-legend">
            <I name="star" size={12} className="star" /> favorite
            <I name="push_pin" size={12} className="pin" /> default
            <I name="smart_toy" size={12} className="robot" /> subagent
          </span>
        </div>
      </div>
    </div>
  )
}

function SectionHeader({ row, top, onToggle }: { row: Extract<PickerRow, { kind: 'header' }>; top: number; onToggle: () => void }): React.JSX.Element {
  const { section, collapsed } = row
  return (
    <button
      className={`model-section-label ${collapsed ? 'collapsed' : ''}`}
      style={{ top, height: HEADER_ROW_H }}
      onClick={onToggle}
      aria-expanded={!collapsed}
      title={section.hint}
    >
      <I name={collapsed ? 'chevron_right' : 'expand_more'} size={15} />
      <span className="model-section-name">{section.label}</span>
      {typeof section.count === 'number' && <span className="model-section-count">{section.count}</span>}
    </button>
  )
}

interface RowProps {
  model: ModelInfo
  top: number
  selected: boolean
  current: boolean
  favorite: boolean
  isDefault: boolean
  subagent: boolean
  used: number
  onHover: () => void
  onChoose: () => void
  onStar: () => void
  onPin: () => void
  onRobot: () => void
}

const ModelRow = React.memo(function ModelRow(p: RowProps): React.JSX.Element {
  const { model, top } = p
  const local = isLocal(model)
  const caps = model.capabilities
  const price = model.pricing
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    fn()
  }
  return (
    <div
      id={`model-option-${model.id}`}
      className={`model-option ${p.selected ? 'selected' : ''} ${p.current ? 'current' : ''}`}
      style={{ top, height: MODEL_ROW_H }}
      role="option"
      aria-selected={p.current}
      onMouseEnter={p.onHover}
      onClick={p.onChoose}
      title={model.id}
    >
      <div className="model-option-name">
        {p.current && <I name="check" size={15} className="model-current-mark" />}
        <span className="model-option-title">{model.name}</span>
      </div>
      <div className="model-option-route">
        <span className={`provider-chip ${local ? 'local' : ''}`} title={`Source: ${providerLabel(sourceKey(model))}`}>
          {local && <I name="hard_drive" size={11} />}
          {chipLabel(model)}
        </span>
        <span className="route-tail">{routeTail(model)}</span>
      </div>
      <div className="model-option-meta">
        <span title="Context window">{fmtTokens(model.contextLength)}</span>
        {price && (
          <span title={`$${price.inputPerMTok} in / $${price.outputPerMTok} out per million tokens`}>
            {fmtPrice(price.inputPerMTok)}/{fmtPrice(price.outputPerMTok)}
          </span>
        )}
        {p.used > 0 && <span title={`Selected ${p.used}×`}>{p.used}×</span>}
      </div>
      <div className="model-option-caps" aria-label="Capabilities">
        <I name="build" size={14} className={caps.tools ? 'on' : ''} />
        <I name="visibility" size={14} className={caps.vision ? 'on' : ''} />
        <I name="neurology" size={14} className={caps.reasoning ? 'on' : ''} />
      </div>
      <div className="model-option-toggles">
        <button className={`model-toggle star ${p.favorite ? 'on' : ''}`} title={p.favorite ? 'Unstar' : 'Favorite'} aria-label="Favorite" aria-pressed={p.favorite} onClick={stop(p.onStar)}>
          <I name={p.favorite ? 'star' : 'star_outline'} size={16} />
        </button>
        <button className={`model-toggle pin ${p.isDefault ? 'on' : ''}`} title={p.isDefault ? 'Default for new threads' : 'Make default for new threads'} aria-label="Default model" aria-pressed={p.isDefault} onClick={stop(p.onPin)}>
          <I name="push_pin" size={16} />
        </button>
        <button className={`model-toggle robot ${p.subagent ? 'on' : ''}`} title={p.subagent ? 'Subagent model — click to unmark' : 'Allow as a subagent model'} aria-label="Subagent model" aria-pressed={p.subagent} onClick={stop(p.onRobot)}>
          <I name="smart_toy" size={16} />
        </button>
      </div>
    </div>
  )
})
