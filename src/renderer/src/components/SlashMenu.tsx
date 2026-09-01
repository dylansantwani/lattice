import React, { useEffect, useRef } from 'react'
import { I } from './Icon'
import type { SlashCommand } from './commands'

/**
 * The `/` command palette that floats above the composer. It is a pure presentational
 * list: the Composer owns the filtered commands, the highlighted index, and keyboard
 * handling, and passes them down here.
 */
export function SlashMenu({
  commands,
  activeIndex,
  query,
  onSelect,
  onHover
}: {
  commands: SlashCommand[]
  activeIndex: number
  query: string
  onSelect: (cmd: SlashCommand) => void
  onHover: (index: number) => void
}): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)

  // keep the highlighted row scrolled into view as the user arrows through
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const browsing = query.trim() === ''

  return (
    <div className="slash-menu" role="listbox" aria-label="Commands" ref={listRef}>
      {commands.length === 0 ? (
        <div className="slash-empty">No commands match “/{query}”</div>
      ) : (
        commands.map((cmd, i) => {
          // In browse mode (empty query) show a category header when the group changes.
          const header = browsing && (i === 0 || commands[i - 1]!.category !== cmd.category)
          return (
            <React.Fragment key={cmd.name}>
              {header && <div className="slash-group">{cmd.category}</div>}
              <div
                data-idx={i}
                role="option"
                aria-selected={i === activeIndex}
                className={`slash-item ${i === activeIndex ? 'active' : ''}`}
                onMouseEnter={() => onHover(i)}
                onMouseDown={(e) => {
                  // mousedown (not click) so the composer textarea never loses focus first
                  e.preventDefault()
                  onSelect(cmd)
                }}
              >
                <span className="slash-icon" aria-hidden>
                  <I name={cmd.icon} size={16} />
                </span>
                <span className="slash-name">/{cmd.name}</span>
                {cmd.argHint && <span className="slash-arg">{cmd.argHint}</span>}
                <span className="slash-hint">{cmd.hint}</span>
              </div>
            </React.Fragment>
          )
        })
      )}
      <div className="slash-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
        <span><kbd>↵</kbd> run</span>
        <span><kbd>tab</kbd> complete</span>
        <span><kbd>esc</kbd> dismiss</span>
      </div>
    </div>
  )
}
