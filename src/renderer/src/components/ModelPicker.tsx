import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ModelHealth, ModelInfo } from '@shared/types'
import { effortDefaultFor } from '@shared/effortDefaults'
import { useStore, activeThread, type ModelPickerIntent } from '@/state/store'
import { computeModelSwitchInfo } from '@/state/modelSwitch'
import { fmtTokens } from './ContextOrbit'
import { I } from './Icon'
import { baseStem, effortLabel, resolveEffortTiers } from './effort'
import { modelsByBase, foldUsageByBase, quickPickModels, favoriteModelsList } from './modelOrder'
import { fmtUsd, fmtWhen, statsFor, type ModelStats } from './modelStats'
import {
  autoHealthTargets,
  buildNav,
  buildSections,
  chipLabel,
  collapseVariantsMemo,
  DEFAULT_FILTERS,
  familyMark,
  familyOf,
  flattenSections,
  fmtLatency,
  fmtPrice,
  HEADER_ROW_H,
  HEALTH_LOOK,
  healthTitle,
  KIND_LABELS,
  inScope,
  isChat,
  isFree,
  isLocal,
  isUnhealthy,
  MANUAL_HEALTH_LIMIT,
  MODEL_ROW_H,
  nameParts,
  providerLabel,
  routeTail,
  rowOffsets,
  scopeKey,
  scopeLabel,
  siblingRoutes,
  SORT_OPTIONS,
  SOURCE_GROUP_OPTIONS,
  sourceKey,
  visibleRange,
  type CapKey,
  type NavEntry,
  type PickerFilters,
  type PickerRow,
  type PickerScope,
  type SortKey
} from './modelCatalog'

// Pure catalog logic lives in ./modelCatalog; re-exported so existing imports keep working.
export { sourceKey, chipLabel, collapseVariants, SOURCE_GROUP_OPTIONS } from './modelCatalog'

/** Stable empty lists so a missing setting never re-renders the browser every store tick. */
const NO_IDS: string[] = []
const NO_COLLAPSED: ReadonlySet<string> = new Set()
const NO_OVERRIDES: Record<string, never> = {}

const CAP_CHIPS: { key: CapKey; label: string; icon: string; title: string }[] = [
  { key: 'tools', label: 'Tools', icon: 'build', title: 'Can call tools (required for agentic work)' },
  { key: 'vision', label: 'Vision', icon: 'visibility', title: 'Accepts images' },
  { key: 'reasoning', label: 'Reasoning', icon: 'neurology', title: 'Thinks before answering' }
]

const INTENT_COPY: Record<ModelPickerIntent, { badge: string; hint: string }> = {
  thread: { badge: '', hint: '' },
  default: { badge: 'Choosing the default for new threads', hint: 'Enter sets the highlighted model as the default' },
  subagent: { badge: 'Choosing subagent models', hint: 'Enter adds or removes the highlighted model' },
  telegram: { badge: 'Choosing the messaging assistant model', hint: 'Enter sets the shared Telegram, iMessage, and voice model' }
}

/**
 * The model browser (⌘M). Three panes: a navigator of where models come from (your machines, your
 * subscriptions, clouds, free bridges — each with a count and a health roll-up), a virtualized list
 * of two-line rows, and a detail pane for the highlighted model that carries everything you might
 * want to know or set about it — capabilities, price, health, what you have spent on it, other
 * routes to the same model, and its per-model defaults — plus the one action the browser was opened
 * for (switch this thread / set the default / mark as a subagent model). Only the rows in view are
 * rendered, so a 1000+ model gateway listing stays instant.
 */
export function ModelPicker(): React.JSX.Element | null {
  const open = useStore((s) => s.ui.modelPickerOpen)
  const intent = useStore((s) => s.ui.modelPickerIntent)
  const focusId = useStore((s) => s.ui.modelPickerFocus)
  const setUi = useStore((s) => s.setUi)
  const rawModels = useStore((s) => s.models)
  const thread = useStore(activeThread)
  const messageCount = useStore((s) => s.messages.length)
  const budget = useStore((s) => s.budget)
  const settings = useStore((s) => s.settings)
  const providersConfigured = (settings?.providers.length ?? 0) > 0
  const setModel = useStore((s) => s.setModel)
  const setDefaultModel = useStore((s) => s.setDefaultModel)
  const toggleSubagentModel = useStore((s) => s.toggleSubagentModel)
  const toggleFavoriteModel = useStore((s) => s.toggleFavoriteModel)
  const setModelEffortDefault = useStore((s) => s.setModelEffortDefault)
  const setModelContextOverride = useStore((s) => s.setModelContextOverride)
  const setModelSourceOverride = useStore((s) => s.setModelSourceOverride)
  const reloadModels = useStore((s) => s.reloadModels)
  const flash = useStore((s) => s.flash)
  const subagentModels = settings?.subagentModels ?? NO_IDS
  const favoriteModels = settings?.favoriteModels ?? NO_IDS
  const recentModelIds = useStore((s) => s.recentModelIds)
  const modelUsage = useStore((s) => s.modelUsage)
  const defaultModel = settings?.defaultModel
  const modelHealth = useStore((s) => s.modelHealth)
  const modelHealthChecking = useStore((s) => s.modelHealthChecking)
  const checkModelHealth = useStore((s) => s.checkModelHealth)
  const healthPingsOn = settings?.modelHealthPings ?? true
  const modelStats = useStore((s) => s.modelStats)
  const loadModelStats = useStore((s) => s.loadModelStats)

  const [filters, setFilters] = useState<PickerFilters>(DEFAULT_FILTERS)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(NO_COLLAPSED)
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set(['local', 'subscription', 'cloud']))
  const [selected, setSelected] = useState(0)
  const [reloading, setReloading] = useState(false)
  // Whether the last selection change came from the keyboard (scroll to keep it in view) or the
  // mouse (never scroll — that would fight the pointer).
  const selectedByKey = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(400)
  // A model id to highlight once the rows exist (deep link from Settings or a sibling-route jump).
  const pendingFocus = useRef<string | null>(null)

  const models = useMemo(() => collapseVariantsMemo(rawModels), [rawModels])
  const byId = useMemo(() => new Map(models.map((m) => [m.id, m])), [models])
  const byBase = useMemo(() => modelsByBase(models), [models])
  const usageByBase = useMemo(() => foldUsageByBase(modelUsage), [modelUsage])
  const quickPicks = useMemo(() => quickPickModels(recentModelIds, usageByBase, byBase, 8), [recentModelIds, byBase, usageByBase])
  const favorites = useMemo(() => favoriteModelsList(favoriteModels, models), [favoriteModels, models])
  const favSet = useMemo(() => new Set(favorites.map((m) => m.id)), [favorites])
  const subagentSet = useMemo(() => new Set(subagentModels), [subagentModels])
  const checkingSet = useMemo(() => new Set(modelHealthChecking), [modelHealthChecking])
  const defaultBase = defaultModel ? baseStem(defaultModel) : null
  const currentId = thread?.model

  const navCtx = useMemo(() => ({ favorites, quickPicks }), [favorites, quickPicks])
  const nav = useMemo(() => buildNav(models, navCtx, modelHealth, checkingSet), [models, navCtx, modelHealth, checkingSet])
  // Only counts models we actually pinged and found unusable, so the chip appears once there is
  // something real to hide and never advertises a filter that would empty an unchecked list.
  const unhealthyCount = useMemo(() => models.reduce((n, m) => n + (isUnhealthy(modelHealth[m.id]) ? 1 : 0), 0), [models, modelHealth])
  const hasFree = useMemo(() => models.some(isFree), [models])

  const sections = useMemo(
    () => buildSections(models, filters, { favorites, usageByBase, quickPicks, health: modelHealth }),
    [models, filters, favorites, usageByBase, quickPicks, modelHealth]
  )
  const { rows, models: visibleModels } = useMemo(() => flattenSections(sections, collapsed), [sections, collapsed])
  const { offsets, total } = useMemo(() => rowOffsets(rows), [rows])
  const [first, last] = visibleRange(offsets, total, scrollTop, viewportH)
  const selectedModel = visibleModels[selected]
  // Distinct models on screen: the Favorites/Recent lead sections repeat rows that also sit in
  // their source section, and the header must never claim "660 of 657". (Every hook lives above
  // the `if (!open) return null` below — a hook after it crashes React on close.)
  const shownCount = useMemo(() => new Set(visibleModels.map((m) => m.id)).size, [visibleModels])

  // Explicit sweep: re-ping what is on screen right now, newest answer wins. Capped so one click
  // cannot fire a thousand requests at a gateway.
  const sweeping = modelHealthChecking.length > 0
  const sweepHealth = useCallback(() => {
    void checkModelHealth(visibleModels.slice(0, MANUAL_HEALTH_LIMIT).map((m) => m.id), true)
  }, [visibleModels, checkModelHealth])

  const patch = useCallback((p: Partial<PickerFilters>) => {
    setFilters((f) => ({ ...f, ...p }))
    setSelected(0)
    selectedByKey.current = true
    if (listRef.current) listRef.current.scrollTop = 0
  }, [])
  const setScope = useCallback(
    (scope: PickerScope) => {
      patch({ scope, query: '' })
      inputRef.current?.focus()
    },
    [patch]
  )

  // Fresh state every time the browser opens — and ONLY then. Resetting on every model-list refresh
  // wiped a half-typed search whenever the gateway re-listed. A deep link (`focusId`) lands on that
  // model: in the default view when it lives there, otherwise scoped to its source.
  useEffect(() => {
    if (!open) return
    let scope: PickerScope = DEFAULT_FILTERS.scope
    if (focusId) {
      const target = byId.get(focusId) ?? byBase.get(baseStem(focusId))
      if (target) {
        pendingFocus.current = target.id
        if (!inScope(target, scope, navCtx) && !favSet.has(target.id)) scope = { kind: 'source', source: sourceKey(target) }
      }
    }
    setFilters({ ...DEFAULT_FILTERS, scope })
    setCollapsed(NO_COLLAPSED)
    setSelected(0)
    setScrollTop(0)
    selectedByKey.current = true
    void loadModelStats()
    const id = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Land the pending highlight as soon as the model is among the rendered rows.
  useEffect(() => {
    const want = pendingFocus.current
    if (!want) return
    const idx = visibleModels.findIndex((m) => m.id === want)
    if (idx < 0) return
    pendingFocus.current = null
    selectedByKey.current = true
    setSelected(idx)
    if (focusId) setUi({ modelPickerFocus: null })
  }, [visibleModels, focusId, setUi])

  useEffect(() => {
    setSelected((i) => Math.max(0, Math.min(i, visibleModels.length - 1)))
  }, [visibleModels.length])

  // Ping the models the browser LEADS with as it opens — the model in use, your favorites, your
  // recents — so a dead route is visible before you pick it and lose a turn to it. Never the whole
  // catalog: a ping is a real (tiny) request and this list runs to four figures; everything else is
  // checked on demand. Local rigs are skipped: a ping there cold-loads the model. Once per opening.
  const autoPinged = useRef(false)
  useEffect(() => {
    if (!open) {
      autoPinged.current = false
      return
    }
    if (autoPinged.current || !healthPingsOn) return
    const ids = autoHealthTargets(thread?.model, favorites, quickPicks.picks, models)
    if (!ids.length) return
    autoPinged.current = true
    void checkModelHealth(ids)
  }, [open, healthPingsOn, thread?.model, favorites, quickPicks, models, checkModelHealth])

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
    if (top < el.scrollTop + HEADER_ROW_H) el.scrollTop = Math.max(0, top - HEADER_ROW_H)
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight
  }, [selected, rows, offsets])

  if (!open) return null

  const close = (): void => setUi({ modelPickerOpen: false, modelPickerIntent: 'thread', modelPickerFocus: null })

  /** The browser's headline action for a model, by intent. */
  const primary = (model: ModelInfo, effort?: string): void => {
    if (intent === 'default') {
      void setDefaultModel(model.id)
      flash(`${model.name} is now the default for new threads`)
      close()
      return
    }
    if (intent === 'subagent') {
      const adding = !subagentSet.has(model.id)
      void toggleSubagentModel(model.id)
      flash(adding ? `${model.name} added to subagent models` : `${model.name} removed from subagent models`)
      return
    }
    if (intent === 'telegram') {
      void window.lattice.channels
        .setAssistantModel(model.id)
        .then(() => flash(`${model.name} will answer messaging-assistant requests`))
        .catch((error: Error) => flash(`Could not change the messaging model: ${error.message}`, 'error'))
      close()
      return
    }
    if (model.id === currentId && (!effort || effort === thread?.effort)) {
      close()
      return
    }
    void setModel(model.id, effort)
    close()
  }

  /** Highlight a model wherever it lives: in the current view if visible, else scoped to its source. */
  const jumpTo = (id: string): void => {
    const idx = visibleModels.findIndex((m) => m.id === id)
    selectedByKey.current = true
    if (idx >= 0) {
      setSelected(idx)
      return
    }
    const target = byId.get(id)
    if (!target) return
    pendingFocus.current = id
    setFilters((f) => ({ ...f, query: '', scope: { kind: 'source', source: sourceKey(target) } }))
  }

  const toggleSection = (key: string): void => {
    setCollapsed((c) => {
      const next = new Set(c)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const toggleGroup = (key: string): void => {
    setExpandedGroups((c) => {
      const next = new Set(c)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const refresh = async (): Promise<void> => {
    setReloading(true)
    try {
      await reloadModels()
    } finally {
      setReloading(false)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    // Typing into a detail-pane field (context override) must not drive the list.
    const target = event.target as HTMLElement
    const inField = target !== inputRef.current && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')
    if (inField) return
    const n = visibleModels.length
    const page = Math.max(1, Math.floor(viewportH / MODEL_ROW_H) - 1)
    // Functional updates: a burst of key repeats lands within one render, and reading the stale
    // `selected` from the closure would collapse three presses into one step.
    const move = (delta: number | ((i: number) => number)): void => {
      selectedByKey.current = true
      setSelected((i) => Math.max(0, Math.min(typeof delta === 'number' ? i + delta : delta(i), n - 1)))
    }
    const mod = event.metaKey || event.ctrlKey
    if (event.key === 'ArrowDown') {
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
    } else if (event.key === 'Home' && mod) {
      event.preventDefault()
      move(() => 0)
    } else if (event.key === 'End' && mod) {
      event.preventDefault()
      move(() => n - 1)
    } else if (event.key === 'Enter' && selectedModel) {
      event.preventDefault()
      if (mod) void setDefaultModel(selectedModel.id)
      else primary(selectedModel)
    } else if (mod && event.key.toLowerCase() === 's' && selectedModel) {
      event.preventDefault()
      void toggleFavoriteModel(selectedModel.id)
    } else if (mod && event.key.toLowerCase() === 'g' && selectedModel) {
      event.preventDefault()
      void toggleSubagentModel(selectedModel.id)
    } else if (mod && event.key.toLowerCase() === 'p' && selectedModel) {
      event.preventDefault()
      void checkModelHealth([selectedModel.id], true)
    }
  }

  const chip = (active: boolean, label: React.ReactNode, onClick: () => void, opts: { icon?: string; title?: string; className?: string } = {}): React.JSX.Element => (
    <button key={String(label)} className={`mb-chip ${opts.className ?? ''} ${active ? 'active' : ''}`} aria-pressed={active} title={opts.title} onClick={onClick}>
      {opts.icon && <I name={opts.icon} size={13} />}
      {label}
    </button>
  )

  const scopeEntry = nav.pinned.find((e) => e.key === scopeKey(filters.scope))
  const totalChat = nav.pinned[0]?.count ?? 0
  const intentCopy = INTENT_COPY[intent]

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div className="palette model-browser" onKeyDown={onKeyDown} role="dialog" aria-label="Model browser">
        <div className="mb-top">
          <I name="search" size={18} className="mb-top-icon" />
          <input
            ref={inputRef}
            placeholder={filters.scope.kind === 'all' ? 'Search every model…' : `Search ${scopeLabel(filters.scope)}…`}
            value={filters.query}
            onChange={(event) => patch({ query: event.target.value })}
            aria-label="Search models"
            aria-activedescendant={selectedModel ? `model-option-${selectedModel.id}` : undefined}
            spellCheck={false}
          />
          {intentCopy.badge && (
            <span className="mb-intent" title={intentCopy.hint}>
              <I name={intent === 'default' ? 'push_pin' : intent === 'telegram' ? 'send' : 'smart_toy'} size={13} />
              {intentCopy.badge}
            </span>
          )}
          <span className="mb-count" title={`${totalChat} chat models in the default view · ${models.length} listed in all`}>
            {shownCount >= totalChat && filters.scope.kind === 'all' && !filters.query ? `${totalChat} models` : `${shownCount} of ${totalChat}`}
          </span>
          <kbd className="mb-kbd" onClick={close} title="Close">
            esc
          </kbd>
        </div>

        <div className="mb-body">
          <nav className="mb-nav" aria-label="Model sources">
            {nav.pinned.map((e) => (
              <NavRow key={e.key} entry={e} active={scopeKey(filters.scope) === e.key} onClick={() => setScope(e.scope)} icon={e.key === 'favorites' ? 'star' : e.key === 'recent' ? 'history' : 'apps'} />
            ))}
            {nav.groups.map((g) => {
              const expanded = expandedGroups.has(g.group)
              return (
                <div key={g.group} className="mb-nav-group">
                  <button className="mb-nav-grouphead" onClick={() => toggleGroup(g.group)} aria-expanded={expanded}>
                    <I name={expanded ? 'expand_more' : 'chevron_right'} size={14} />
                    <span>{g.label}</span>
                    <span className="mb-nav-groupcount">{g.count}</span>
                  </button>
                  {expanded && g.entries.map((e) => <NavRow key={e.key} entry={e} active={scopeKey(filters.scope) === e.key} onClick={() => setScope(e.scope)} />)}
                </div>
              )
            })}
            {nav.nonChat > 0 && (
              <div className="mb-nav-group">
                <NavRow
                  entry={{ scope: { kind: 'nonchat' }, key: 'nonchat', label: 'Not for chat', count: nav.nonChat, hint: 'Image, audio, video, embedding and rerank models — listed by your providers but unable to take a turn', health: { ok: 0, bad: 0, checking: 0 } }}
                  active={filters.scope.kind === 'nonchat'}
                  onClick={() => setScope({ kind: 'nonchat' })}
                  icon="block"
                  muted
                />
              </div>
            )}
            <div className="mb-nav-foot">
              <button className="mb-nav-action" onClick={() => void refresh()} disabled={reloading} title="Re-list models from every enabled provider">
                <I name="sync" size={14} className={reloading ? 'spin' : ''} />
                {reloading ? 'Refreshing…' : 'Refresh list'}
              </button>
              <button
                className="mb-nav-action"
                onClick={() => {
                  close()
                  setUi({ settingsOpen: true, settingsTab: 'providers' })
                }}
                title="Add or check providers"
              >
                <I name="cloud" size={14} />
                Providers…
              </button>
            </div>
          </nav>

          <section className="mb-main">
            <div className="mb-tools" aria-label="Filters">
              {CAP_CHIPS.map((c) => chip(filters.caps[c.key], c.label, () => patch({ caps: { ...filters.caps, [c.key]: !filters.caps[c.key] } }), { icon: c.icon, title: c.title }))}
              {hasFree && chip(filters.freeOnly, 'Free', () => patch({ freeOnly: !filters.freeOnly }), { icon: 'savings', title: 'Local, or priced at $0' })}
              {unhealthyCount > 0 &&
                chip(filters.healthyOnly, `Live only`, () => patch({ healthyOnly: !filters.healthyOnly }), {
                  icon: 'ecg_heart',
                  title: `Hide the ${unhealthyCount} pinged model${unhealthyCount === 1 ? '' : 's'} that came back unusable. Models never checked are never hidden.`
                })}
              <div className="mb-spacer" />
              <select
                className="mini-select"
                value={filters.sort}
                aria-label="Sort"
                disabled={!!filters.query.trim() || filters.scope.kind === 'favorites' || filters.scope.kind === 'recent' || filters.scope.kind === 'nonchat'}
                title={filters.query.trim() ? 'Sorted by relevance while searching' : 'Sort'}
                onChange={(e) => patch({ sort: e.target.value as SortKey })}
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button
                className={`mb-chip ${sweeping ? 'active' : ''}`}
                onClick={sweepHealth}
                disabled={sweeping || visibleModels.length === 0}
                title={`Ping the first ${Math.min(visibleModels.length, MANUAL_HEALTH_LIMIT)} model${Math.min(visibleModels.length, MANUAL_HEALTH_LIMIT) === 1 ? '' : 's'} shown (one tiny request each) and show which are live`}
              >
                <I name={sweeping ? 'sync' : 'network_ping'} size={13} className={sweeping ? 'spin' : ''} />
                {sweeping ? 'Pinging…' : 'Ping shown'}
              </button>
            </div>

            <div className="mb-list" ref={listRef} role="listbox" aria-label="Models" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
              {rows.length === 0 || visibleModels.length === 0 ? (
                <EmptyState
                  providersConfigured={providersConfigured}
                  anyModels={models.length > 0}
                  filtered={rows.length > 0 || filters.query.trim().length > 0 || filters.scope.kind !== 'all' || filters.freeOnly || filters.healthyOnly || Object.values(filters.caps).some(Boolean)}
                  scope={filters.scope}
                  onClear={() => patch({ ...DEFAULT_FILTERS })}
                  onProviders={() => {
                    close()
                    setUi({ settingsOpen: true, settingsTab: 'providers' })
                  }}
                  onRefresh={() => void refresh()}
                />
              ) : (
                <div className="mb-list-inner" style={{ height: total }}>
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
                        stats={statsFor(modelStats ?? undefined, model.id)}
                        health={modelHealth[model.id]}
                        checking={checkingSet.has(model.id)}
                        onHover={() => {
                          selectedByKey.current = false
                          setSelected(row.index)
                        }}
                        onChoose={() => primary(model)}
                      />
                    )
                  })}
                </div>
              )}
            </div>
          </section>

          <aside className="mb-detail" aria-label="Model details">
            {selectedModel ? (
              <DetailPane
                key={selectedModel.id}
                model={selectedModel}
                models={models}
                intent={intent}
                currentId={currentId}
                currentEffort={thread?.effort}
                messageCount={messageCount}
                contextTokens={budget?.usedTokens ?? 0}
                contextExact={budget?.exact ?? true}
                favorite={favSet.has(selectedModel.id)}
                isDefault={baseStem(selectedModel.id) === defaultBase}
                subagent={subagentSet.has(selectedModel.id)}
                health={modelHealth[selectedModel.id]}
                checking={checkingSet.has(selectedModel.id)}
                stats={statsFor(modelStats ?? undefined, selectedModel.id)}
                siblings={siblingRoutes(selectedModel, models)}
                siblingHealth={modelHealth}
                defaultEffort={settings?.defaultEffort}
                effortByModel={settings?.defaultEffortByModel}
                contextOverride={settings?.modelContextOverrides?.[selectedModel.id]}
                sourceOverride={settings?.modelSourceOverrides?.[selectedModel.id]}
                hasCostOverride={!!(settings?.costOverrides ?? NO_OVERRIDES)[selectedModel.id]}
                onPrimary={(effort) => primary(selectedModel, effort)}
                onStar={() => void toggleFavoriteModel(selectedModel.id)}
                onDefault={() => {
                  void setDefaultModel(selectedModel.id)
                  flash(`${selectedModel.name} is now the default for new threads`)
                }}
                onSubagent={() => void toggleSubagentModel(selectedModel.id)}
                onPing={() => void checkModelHealth([selectedModel.id], true)}
                onJump={jumpTo}
                onEffortDefault={(tier) => void setModelEffortDefault(selectedModel.id, tier)}
                onContextOverride={(tokens) => void setModelContextOverride(selectedModel.id, tokens)}
                onSourceOverride={(key) => void setModelSourceOverride(selectedModel.id, key)}
                onCostOverride={() => {
                  close()
                  setUi({ costEditorModel: selectedModel.id })
                }}
              />
            ) : (
              <div className="mb-detail-empty">
                <I name="model_training" size={28} />
                <p>{scopeEntry?.hint ?? 'Highlight a model to see what it can do, what it costs, whether it is live, and what you have used it for.'}</p>
              </div>
            )}
          </aside>
        </div>

        <div className="mb-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> {intent === 'default' ? 'set default' : intent === 'subagent' ? 'toggle subagent' : intent === 'telegram' ? 'use for messaging' : 'use'}
          </span>
          <span>
            <kbd>⌘↵</kbd> default
          </span>
          <span>
            <kbd>⌘S</kbd> star
          </span>
          <span>
            <kbd>⌘G</kbd> subagent
          </span>
          <span>
            <kbd>⌘P</kbd> ping
          </span>
          <span className="mb-foot-legend">
            <I name="star" size={12} className="star" /> favorite
            <I name="push_pin" size={12} className="pin" /> default
            <I name="smart_toy" size={12} className="robot" /> subagent
          </span>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------- navigator

function NavRow({ entry, active, onClick, icon, muted }: { entry: NavEntry; active: boolean; onClick: () => void; icon?: string; muted?: boolean }): React.JSX.Element {
  const h = entry.health
  return (
    <button className={`mb-nav-row ${active ? 'active' : ''} ${muted ? 'muted' : ''}`} onClick={onClick} title={entry.hint} aria-pressed={active}>
      {icon ? <I name={icon} size={15} /> : entry.local ? <I name="hard_drive" size={15} className="local" /> : <span className="mb-nav-dot" />}
      <span className="mb-nav-label">{entry.label}</span>
      {(h.ok > 0 || h.bad > 0 || h.checking > 0) && (
        <span className="mb-nav-health" title={`${h.ok} live · ${h.bad} down or limited${h.checking ? ` · ${h.checking} checking` : ''}`}>
          {h.checking > 0 && <span className="mb-health checking" />}
          {h.ok > 0 && <span className="mb-health tone-ok" />}
          {h.bad > 0 && <span className="mb-health tone-bad" />}
        </span>
      )}
      <span className="mb-nav-count">{entry.count}</span>
    </button>
  )
}

// ---------------------------------------------------------------------------- list

function SectionHeader({ row, top, onToggle }: { row: Extract<PickerRow, { kind: 'header' }>; top: number; onToggle: () => void }): React.JSX.Element {
  const { section, collapsed } = row
  return (
    <button className={`mb-section ${collapsed ? 'collapsed' : ''}`} style={{ top, height: HEADER_ROW_H }} onClick={onToggle} aria-expanded={!collapsed} title={section.hint}>
      <I name={collapsed ? 'chevron_right' : 'expand_more'} size={15} />
      <span className="mb-section-name">{section.label}</span>
      {typeof section.count === 'number' && <span className="mb-section-count">{section.count}</span>}
      {section.hint && <span className="mb-section-hint">{section.hint}</span>}
    </button>
  )
}

/**
 * The status dot for a model. A model that has never been pinged shows NOTHING — an absent dot
 * means "not checked", never "fine" — so the list stays quiet until health is actually known.
 */
function HealthDot({ health, checking }: { health?: ModelHealth; checking: boolean }): React.JSX.Element | null {
  if (checking) return <span className="mb-health checking" title="Pinging this model…" aria-label="Checking this model" />
  if (!health || health.status === 'unknown') return null
  const title = healthTitle(health)
  return <span className={`mb-health ${health.status} tone-${HEALTH_LOOK[health.status].tone}`} title={title} role="img" aria-label={`Health: ${title}`} />
}

function HealthBadge({ health, checking }: { health?: ModelHealth; checking: boolean }): React.JSX.Element | null {
  if (checking) {
    return (
      <span className="mb-hbadge checking">
        <HealthDot checking />
        pinging
      </span>
    )
  }
  if (!health || health.status === 'unknown') return null
  const text = health.status === 'live' || health.status === 'slow' ? fmtLatency(health.latencyMs) || HEALTH_LOOK[health.status].label.toLowerCase() : HEALTH_LOOK[health.status].label.toLowerCase()
  return (
    <span className={`mb-hbadge tone-${HEALTH_LOOK[health.status].tone}`} title={healthTitle(health)}>
      <HealthDot health={health} checking={false} />
      {text}
    </span>
  )
}

function Avatar({ model, size = 26 }: { model: ModelInfo; size?: number }): React.JSX.Element {
  const { mark, hue } = familyMark(model)
  return (
    <span className="mb-avatar" style={{ ['--hue' as string]: hue, width: size, height: size, fontSize: Math.round(size * 0.38) }} aria-hidden="true">
      {mark}
    </span>
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
  stats?: ModelStats
  health?: ModelHealth
  checking: boolean
  onHover: () => void
  onChoose: () => void
}

const ModelRow = React.memo(function ModelRow(p: RowProps): React.JSX.Element {
  const { model, top } = p
  const local = isLocal(model)
  const free = isFree(model)
  const caps = model.capabilities
  const price = model.pricing
  const { title, tag } = nameParts(model)
  return (
    <div
      id={`model-option-${model.id}`}
      className={`mb-row ${p.selected ? 'selected' : ''} ${p.current ? 'current' : ''}`}
      style={{ top, height: MODEL_ROW_H }}
      role="option"
      aria-selected={p.selected}
      onMouseEnter={p.onHover}
      onClick={p.onChoose}
    >
      <Avatar model={model} />
      <div className="mb-row-main">
        <div className="mb-row-l1">
          <span className="mb-name">
            {title}
            {tag && <span className="mb-tag">{tag}</span>}
          </span>
          {p.current && <span className="mb-pill current">current</span>}
          {p.isDefault && <I name="push_pin" size={13} className="mb-mark pin" />}
          {p.favorite && <I name="star" size={13} className="mb-mark star" />}
          {p.subagent && <I name="smart_toy" size={13} className="mb-mark robot" />}
        </div>
        <div className="mb-row-l2">
          <span className={`mb-src ${local ? 'local' : ''}`} title={`Source: ${providerLabel(sourceKey(model))}`}>
            {local && <I name="hard_drive" size={11} />}
            {chipLabel(model)}
          </span>
          <span className="mb-id">{routeTail(model)}</span>
          {p.stats && p.stats.requests > 0 && (
            <span className="mb-used" title={`${p.stats.requests} turn${p.stats.requests === 1 ? '' : 's'} · ${fmtUsd(p.stats.costUsd)}${p.stats.costEstimated ? ' est.' : ''} · last ${fmtWhen(p.stats.lastAt)}`}>
              · {p.stats.requests}× {p.stats.costUsd > 0 && fmtUsd(p.stats.costUsd)}
            </span>
          )}
        </div>
      </div>
      <div className="mb-row-meta">
        <span className="mb-caps" aria-label="Capabilities">
          <I name="build" size={13} className={caps.tools ? 'on' : ''} />
          <I name="visibility" size={13} className={caps.vision ? 'on' : ''} />
          <I name="neurology" size={13} className={caps.reasoning ? 'on' : ''} />
        </span>
        <span className="mb-ctx" title="Context window">
          {fmtTokens(model.contextLength)}
        </span>
        <span className="mb-price" title={price ? `$${price.inputPerMTok} in / $${price.outputPerMTok} out per million tokens` : free ? 'Free to run' : 'No price reported'}>
          {price && !free ? `${fmtPrice(price.inputPerMTok)}/${fmtPrice(price.outputPerMTok)}` : free ? 'free' : '—'}
        </span>
        <span className="mb-hcell">
          <HealthBadge health={p.health} checking={p.checking} />
        </span>
      </div>
    </div>
  )
})

function EmptyState(p: {
  providersConfigured: boolean
  anyModels: boolean
  filtered: boolean
  scope: PickerScope
  onClear: () => void
  onProviders: () => void
  onRefresh: () => void
}): React.JSX.Element {
  if (!p.providersConfigured) {
    return (
      <div className="mb-empty">
        <I name="cloud_off" size={30} />
        <h4>No providers yet</h4>
        <p>Lattice lists models from OpenAI-compatible endpoints — a gateway like OmniRoute, a local Ollama or llama.cpp server, OpenRouter, a rented GPU pod. Add one to fill this list.</p>
        <button className="btn primary" onClick={p.onProviders}>
          Add a provider
        </button>
      </div>
    )
  }
  if (!p.anyModels) {
    return (
      <div className="mb-empty">
        <I name="hourglass_empty" size={30} />
        <h4>No models listed</h4>
        <p>Your providers returned nothing yet. If one is unreachable, its status shows in Settings → Providers.</p>
        <div className="mb-empty-actions">
          <button className="btn" onClick={p.onRefresh}>
            Refresh list
          </button>
          <button className="btn" onClick={p.onProviders}>
            Check providers
          </button>
        </div>
      </div>
    )
  }
  if (p.scope.kind === 'favorites') {
    return (
      <div className="mb-empty">
        <I name="star_outline" size={30} />
        <h4>No favorites yet</h4>
        <p>Star a model (⌘S, or the star in its details) and it leads the list every time you open the browser.</p>
      </div>
    )
  }
  if (p.scope.kind === 'recent') {
    return (
      <div className="mb-empty">
        <I name="history" size={30} />
        <h4>Nothing chosen yet</h4>
        <p>Models you pick show up here, most recent first.</p>
      </div>
    )
  }
  return (
    <div className="mb-empty">
      <I name="search_off" size={30} />
      <h4>Nothing matches</h4>
      <p>No model in {scopeLabel(p.scope).toLowerCase()} fits the search and filters.</p>
      {p.filtered && (
        <button className="btn" onClick={p.onClear}>
          Clear search and filters
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------- detail pane

interface DetailProps {
  model: ModelInfo
  models: ModelInfo[]
  intent: ModelPickerIntent
  currentId?: string
  currentEffort?: string
  messageCount: number
  contextTokens: number
  contextExact: boolean
  favorite: boolean
  isDefault: boolean
  subagent: boolean
  health?: ModelHealth
  checking: boolean
  stats?: ModelStats
  siblings: ModelInfo[]
  siblingHealth: Record<string, ModelHealth>
  defaultEffort?: string
  effortByModel?: Record<string, string>
  contextOverride?: number
  sourceOverride?: string
  hasCostOverride: boolean
  onPrimary: (effort?: string) => void
  onStar: () => void
  onDefault: () => void
  onSubagent: () => void
  onPing: () => void
  onJump: (id: string) => void
  onEffortDefault: (tier: string | null) => void
  onContextOverride: (tokens: number | null) => void
  onSourceOverride: (key: string | null) => void
  onCostOverride: () => void
}

function DetailPane(p: DetailProps): React.JSX.Element {
  const { model } = p
  const isCurrent = model.id === p.currentId
  const local = isLocal(model)
  const free = isFree(model)
  const { title, tag } = nameParts(model)
  const family = familyOf(model)
  const source = sourceKey(model)
  const price = model.pricing
  const [copied, setCopied] = useState(false)
  const [showOverrides, setShowOverrides] = useState(!!(p.contextOverride || p.sourceOverride || p.effortByModel?.[model.id] || p.hasCostOverride))
  const [ctxDraft, setCtxDraft] = useState(p.contextOverride ? String(p.contextOverride) : '')

  // The reasoning ladder this model accepts, with "off" always offered (the composer does the same).
  const tiers = resolveEffortTiers(model)
  const thinkTiers = tiers.length ? (tiers.some((t) => t === 'off' || t === 'none') ? tiers : ['off', ...tiers]) : []
  // What a thread on this model would start at: the thread's own tier when it is the current model,
  // otherwise the per-model default → the global default, clamped to what the model accepts.
  const inherited = effortDefaultFor(model.id, { defaultEffortByModel: p.effortByModel }) ?? p.defaultEffort
  const seed = isCurrent && p.currentEffort ? p.currentEffort : inherited
  const seedTier = seed && thinkTiers.includes(seed) ? seed : thinkTiers.includes('high') ? 'high' : thinkTiers[0]
  const [effort, setEffort] = useState<string | undefined>(seedTier)
  const effortChanged = !!effort && effort !== seedTier

  const copyId = (): void => {
    void navigator.clipboard?.writeText(model.id).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  const switchInfo =
    isChat(model) && p.intent === 'thread' && !isCurrent && p.currentId && p.messageCount > 0
      ? computeModelSwitchInfo({ currentModel: p.currentId, targetModel: model.id, target: model, contextTokens: p.contextTokens, models: p.models })
      : null

  const chat = isChat(model)
  let primaryLabel: string
  let primaryIcon: string
  let primaryDisabled = false
  if (!chat) {
    primaryLabel = `${KIND_LABELS[model.kind ?? 'chat']} — not a chat model`
    primaryIcon = 'block'
    primaryDisabled = true
  } else if (p.intent === 'default') {
    primaryLabel = p.isDefault ? 'Default for new threads' : 'Set as default'
    primaryIcon = 'push_pin'
    primaryDisabled = p.isDefault
  } else if (p.intent === 'subagent') {
    primaryLabel = p.subagent ? 'Remove from subagent models' : 'Add as subagent model'
    primaryIcon = 'smart_toy'
  } else if (p.intent === 'telegram') {
    primaryLabel = 'Use for messaging'
    primaryIcon = 'send'
  } else if (isCurrent) {
    primaryLabel = effortChanged ? `Apply thinking: ${effortLabel(effort!)}` : 'Current model'
    primaryIcon = effortChanged ? 'neurology' : 'check'
    primaryDisabled = !effortChanged
  } else {
    primaryLabel = p.currentId ? (p.messageCount > 0 ? 'Switch this thread' : 'Use in this thread') : 'Use this model'
    primaryIcon = 'swap_horiz'
  }

  const overrideEffort = p.effortByModel?.[model.id]
  const reported = (model.raw as { context_length?: number } | undefined)?.context_length

  return (
    <div className="mb-dp">
      <div className="mb-dp-head">
        <Avatar model={model} size={40} />
        <div className="mb-dp-title">
          <h3>
            {title}
            {tag && <span className="mb-tag">{tag}</span>}
          </h3>
          <div className="mb-dp-sub">
            <span>{family}</span>
            <span className="mb-dp-dot">·</span>
            <span className={local ? 'local' : ''}>{providerLabel(source)}</span>
          </div>
        </div>
      </div>
      <button className="mb-dp-id" onClick={copyId} title="Copy the route id">
        <span>{model.id}</span>
        <I name={copied ? 'check' : 'content_copy'} size={13} />
      </button>

      {chat && thinkTiers.length > 0 && p.intent === 'thread' && (
        <div className="mb-dp-effort" role="radiogroup" aria-label="Thinking effort">
          <span className="mb-dp-label">Thinking</span>
          <div className="mb-seg">
            {thinkTiers.map((t) => (
              <button key={t} className={`mb-seg-btn ${effort === t ? 'on' : ''}`} role="radio" aria-checked={effort === t} onClick={() => setEffort(t)} title={t === 'off' || t === 'none' ? 'No thinking' : effortLabel(t)}>
                {t === 'off' || t === 'none' ? 'Off' : t === 'xhigh' ? 'X-high' : effortLabel(t)}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mb-dp-actions">
        <button className="btn primary mb-dp-primary" disabled={primaryDisabled} onClick={() => p.onPrimary(p.intent === 'thread' && thinkTiers.length ? effort : undefined)}>
          <I name={primaryIcon} size={15} />
          {primaryLabel}
        </button>
        <div className="mb-dp-toggles" hidden={!chat}>
          <button className={`mb-toggle star ${p.favorite ? 'on' : ''}`} aria-pressed={p.favorite} onClick={p.onStar} title={p.favorite ? 'Unstar (⌘S)' : 'Favorite (⌘S)'}>
            <I name={p.favorite ? 'star' : 'star_outline'} size={16} />
          </button>
          {p.intent !== 'default' && (
            <button className={`mb-toggle pin ${p.isDefault ? 'on' : ''}`} aria-pressed={p.isDefault} onClick={p.onDefault} disabled={p.isDefault} title={p.isDefault ? 'Default for new threads' : 'Make default for new threads (⌘↵)'}>
              <I name="push_pin" size={16} />
            </button>
          )}
          {p.intent !== 'subagent' && (
            <button className={`mb-toggle robot ${p.subagent ? 'on' : ''}`} aria-pressed={p.subagent} onClick={p.onSubagent} title={p.subagent ? 'Subagent model — click to unmark (⌘G)' : 'Allow as a subagent model (⌘G)'}>
              <I name="smart_toy" size={16} />
            </button>
          )}
        </div>
      </div>

      {switchInfo && (
        <div className={`mb-dp-note ${switchInfo.fitsInTarget ? '' : 'warn'}`}>
          <I name={switchInfo.fitsInTarget ? 'swap_horiz' : 'warning'} size={14} />
          <span>
            Switching carries {fmtTokens(switchInfo.contextTokens)}
            {p.contextExact ? '' : ' (est.)'} of context into a fresh cache
            {switchInfo.estInputCost !== undefined && ` — about ${fmtUsd(switchInfo.estInputCost)} to re-read once`}
            {!switchInfo.fitsInTarget && `. That is more than this model's ${fmtTokens(switchInfo.targetContextLength)} window; the oldest turns may be dropped.`}
          </span>
        </div>
      )}

      <dl className="mb-facts">
        <div>
          <dt>Context</dt>
          <dd>
            {fmtTokens(model.contextLength)}
            {p.contextOverride ? <span className="mb-facts-note">set by you</span> : null}
          </dd>
        </div>
        <div>
          <dt>Max output</dt>
          <dd>{model.maxOutputTokens ? fmtTokens(model.maxOutputTokens) : '—'}</dd>
        </div>
        <div>
          <dt>Input</dt>
          <dd>{price && !free ? `${fmtPrice(price.inputPerMTok)} /M` : free ? 'free' : '—'}</dd>
        </div>
        <div>
          <dt>Output</dt>
          <dd>{price && !free ? `${fmtPrice(price.outputPerMTok)} /M` : free ? 'free' : '—'}</dd>
        </div>
        {price?.cachedInputPerMTok !== undefined && !free && (
          <div>
            <dt>Cached input</dt>
            <dd>{fmtPrice(price.cachedInputPerMTok)} /M</dd>
          </div>
        )}
        {price?.reasoningPerMTok !== undefined && !free && (
          <div>
            <dt>Reasoning</dt>
            <dd>{fmtPrice(price.reasoningPerMTok)} /M</dd>
          </div>
        )}
      </dl>

      <div className="mb-dp-caps">
        <span className={`mb-capchip ${model.capabilities.tools ? 'on' : ''}`} title={model.capabilities.tools ? 'Calls tools' : 'No tool calling reported'}>
          <I name="build" size={13} /> Tools
        </span>
        <span className={`mb-capchip ${model.capabilities.vision ? 'on' : ''}`} title={model.capabilities.vision ? 'Accepts images' : 'No vision reported'}>
          <I name="visibility" size={13} /> Vision
        </span>
        <span className={`mb-capchip ${model.capabilities.reasoning ? 'on' : ''}`} title={tiers.length ? `Thinking tiers: ${tiers.join(' · ')}` : 'No reasoning reported'}>
          <I name="neurology" size={13} /> {tiers.length ? `Thinks · ${tiers.length} tiers` : 'Reasoning'}
        </span>
      </div>

      <section className="mb-dp-section">
        <header>
          <span>Health</span>
          <button className="mb-link" onClick={p.onPing} disabled={p.checking} title="Send this model a tiny request now (⌘P)">
            <I name={p.checking ? 'sync' : 'network_ping'} size={13} className={p.checking ? 'spin' : ''} />
            {p.checking ? 'Pinging…' : 'Ping now'}
          </button>
        </header>
        <HealthLine health={p.health} checking={p.checking} local={local} />
      </section>

      <section className="mb-dp-section">
        <header>
          <span>Your usage</span>
          {p.stats && p.stats.requests > 0 && <span className="mb-dp-when">last {fmtWhen(p.stats.lastAt)}</span>}
        </header>
        {p.stats && p.stats.requests > 0 ? (
          <div className="mb-stats">
            <Stat label="Turns" value={p.stats.failed ? `${p.stats.requests} · ${p.stats.failed} failed` : String(p.stats.requests)} warn={p.stats.failed > 0} />
            <Stat label="Spend" value={p.stats.costUsd > 0 ? `${fmtUsd(p.stats.costUsd)}${p.stats.costEstimated ? ' est.' : ''}` : free ? 'free' : '$0'} />
            <Stat label="Tokens" value={fmtTokens(p.stats.totalTokens)} />
            <Stat label="Speed" value={p.stats.tps ? `${p.stats.tps} tok/s` : '—'} />
            <Stat label="First token" value={p.stats.avgTtftMs !== null ? fmtLatency(p.stats.avgTtftMs) : '—'} />
            <Stat label="Cache hits" value={p.stats.cacheHitPct !== null ? `${p.stats.cacheHitPct}%` : '—'} />
          </div>
        ) : (
          <p className="mb-dp-muted">You have not run a turn on this model yet.</p>
        )}
      </section>

      {p.siblings.length > 0 && (
        <section className="mb-dp-section">
          <header>
            <span>Same model, other routes</span>
          </header>
          <div className="mb-siblings">
            {p.siblings.slice(0, 6).map((s) => {
              const h = p.siblingHealth[s.id]
              return (
                <button key={s.id} className="mb-sibling" onClick={() => p.onJump(s.id)} title={`${s.id}${h && h.status !== 'unknown' ? ` — ${healthTitle(h)}` : ''}`}>
                  <span className={`mb-src ${isLocal(s) ? 'local' : ''}`}>{chipLabel(s)}</span>
                  <span className="mb-sibling-id">{routeTail(s)}</span>
                  {s.pricing && !isFree(s) && <span className="mb-sibling-price">{fmtPrice(s.pricing.inputPerMTok)}/{fmtPrice(s.pricing.outputPerMTok)}</span>}
                  {isFree(s) && <span className="mb-sibling-price">free</span>}
                  <HealthDot health={h} checking={false} />
                </button>
              )
            })}
            {p.siblings.length > 6 && <span className="mb-dp-muted">+{p.siblings.length - 6} more</span>}
          </div>
        </section>
      )}

      <section className="mb-dp-section">
        <header>
          <button className="mb-dp-disclose" onClick={() => setShowOverrides((v) => !v)} aria-expanded={showOverrides}>
            <I name={showOverrides ? 'expand_more' : 'chevron_right'} size={15} />
            Per-model settings
            {(overrideEffort || p.contextOverride || p.sourceOverride || p.hasCostOverride) && <span className="mb-pill">set</span>}
          </button>
        </header>
        {showOverrides && (
          <div className="mb-overrides">
            {thinkTiers.length > 0 && (
              <label className="mb-ov">
                <span className="mb-ov-label">Default thinking</span>
                <select value={overrideEffort ?? ''} onChange={(e) => p.onEffortDefault(e.target.value || null)} aria-label="Default thinking effort for this model">
                  <option value="">Inherit ({inherited ? effortLabel(inherited) : 'no thinking'})</option>
                  {thinkTiers.map((t) => (
                    <option key={t} value={t}>
                      {t === 'off' || t === 'none' ? 'No thinking' : effortLabel(t)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="mb-ov">
              <span className="mb-ov-label">
                Context window
                <small>{reported ? `reports ${fmtTokens(reported)}` : 'no figure reported'}</small>
              </span>
              <div className="mb-ov-inline">
                <input
                  type="number"
                  min={1024}
                  step={1024}
                  placeholder={String(model.contextLength)}
                  value={ctxDraft}
                  onChange={(e) => setCtxDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      const n = Number(ctxDraft)
                      if (Number.isFinite(n) && n > 0) p.onContextOverride(n)
                    }
                  }}
                  aria-label="Context window override in tokens"
                />
                <button
                  className="btn"
                  disabled={!ctxDraft || Number(ctxDraft) === p.contextOverride || !(Number(ctxDraft) > 0)}
                  onClick={() => p.onContextOverride(Number(ctxDraft))}
                >
                  Set
                </button>
                {p.contextOverride && (
                  <button
                    className="btn"
                    onClick={() => {
                      setCtxDraft('')
                      p.onContextOverride(null)
                    }}
                    title="Use the provider-reported window again"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
            <label className="mb-ov">
              <span className="mb-ov-label">
                Listed under
                <small>the source group this model files under</small>
              </span>
              <select value={p.sourceOverride ?? ''} onChange={(e) => p.onSourceOverride(e.target.value || null)} aria-label="Source group override">
                <option value="">Automatic ({providerLabel(model.ownedBy && !p.sourceOverride ? source : source)})</option>
                {SOURCE_GROUP_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="mb-ov">
              <span className="mb-ov-label">
                Cost rates
                <small>{p.hasCostOverride ? 'your own rates are in use' : price ? 'list price is used to estimate' : 'no price — spend shows as $0'}</small>
              </span>
              <button className="btn" onClick={p.onCostOverride}>
                {p.hasCostOverride ? 'Edit rates…' : 'Set rates…'}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }): React.JSX.Element {
  return (
    <div className={`mb-stat ${warn ? 'warn' : ''}`}>
      <span className="mb-stat-label">{label}</span>
      <span className="mb-stat-value">{value}</span>
    </div>
  )
}

function HealthLine({ health, checking, local }: { health?: ModelHealth; checking: boolean; local: boolean }): React.JSX.Element {
  if (checking) {
    return (
      <div className="mb-healthline">
        <HealthDot checking />
        <span>Pinging…</span>
      </div>
    )
  }
  if (!health || health.status === 'unknown') {
    return (
      <p className="mb-dp-muted">
        {local ? 'Not checked — a ping would load the model onto the machine, so local rigs are only pinged when you ask.' : 'Not checked yet.'}
        {health?.error ? ` ${health.error}` : ''}
      </p>
    )
  }
  const look = HEALTH_LOOK[health.status]
  const latency = fmtLatency(health.latencyMs)
  return (
    <div className="mb-healthline">
      <HealthDot health={health} checking={false} />
      <span className={`mb-healthword tone-${look.tone}`}>{look.label}</span>
      {latency && <span className="mb-healthlat">{latency}</span>}
      <span className="mb-dp-when">checked {fmtWhen(health.checkedAt)}</span>
      {health.error && <span className="mb-healtherr">{health.error}</span>}
    </div>
  )
}
