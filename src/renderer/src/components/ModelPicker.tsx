import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '@/state/store'
import { fmtTokens } from './ContextOrbit'

export function ModelPicker(): React.JSX.Element | null {
  const open = useStore((s) => s.ui.modelPickerOpen)
  const setUi = useStore((s) => s.setUi)
  const models = useStore((s) => s.models)
  const setModel = useStore((s) => s.setModel)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setSelected(0)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim()
    const list = q
      ? models.filter(
          (m) =>
            m.id.toLowerCase().includes(q) ||
            m.name.toLowerCase().includes(q) ||
            m.provider.toLowerCase().includes(q)
        )
      : models
    return list.slice(0, 60)
  }, [models, query])

  if (!open) return null

  const choose = (id: string): void => {
    void setModel(id)
    setUi({ modelPickerOpen: false })
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') setUi({ modelPickerOpen: false })
    else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.min(s + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter' && filtered[selected]) {
      choose(filtered[selected].id)
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setUi({ modelPickerOpen: false })}>
      <div className="palette" onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          placeholder={`Search ${models.length} models…`}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setSelected(0)
          }}
        />
        <div className="palette-list">
          {filtered.map((m, i) => (
            <button
              key={m.id}
              className={`palette-item ${i === selected ? 'selected' : ''}`}
              onMouseEnter={() => setSelected(i)}
              onClick={() => choose(m.id)}
            >
              <div>
                <div className="name">{m.id}</div>
                <div className="caps">
                  {[
                    m.capabilities.reasoning && 'reasoning',
                    m.capabilities.vision && 'vision',
                    m.capabilities.tools && 'tools'
                  ]
                    .filter(Boolean)
                    .join(' · ') || '—'}
                </div>
              </div>
              <div className="meta">
                <span>{fmtTokens(m.contextLength)} ctx</span>
                <span>{fmtTokens(m.maxOutputTokens)} out</span>
              </div>
            </button>
          ))}
          {filtered.length === 0 && (
            <div style={{ padding: 16, color: 'var(--text-faint)', fontSize: 13 }}>
              {models.length === 0 ? 'No models — check provider settings.' : 'No matches.'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
