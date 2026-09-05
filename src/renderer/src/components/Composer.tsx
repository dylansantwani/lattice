import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Attachment } from '@shared/types'
import { useStore, activeThread } from '@/state/store'
import {
  acceptImageFiles,
  fmtBytes,
  hasImagePayload,
  imageFilesFrom,
  MAX_IMAGES_PER_MESSAGE,
  SUPPORTED_IMAGE_TEXT
} from './attachments'
import { describeBackgroundWork, summarizeBackgroundWork } from './backgroundWork'
import { ContextOrbit } from './ContextOrbit'
import { I } from './Icon'
import { resolveEffortTiers, effortLabel } from './effort'
import { SlashMenu } from './SlashMenu'
import { ModelQuickPicker } from './ModelQuickPicker'
import { filterCommands, findCommand, type SlashCommand } from './commands'
import { sendAction } from './composerKeys'

/** The composer's thinking-selector label for an effort tier ("No thinking" / "Think: High"). */
function thinkLabel(t: string): string {
  return t === 'off' || t === 'none' ? 'No thinking' : `Think: ${effortLabel(t)}`
}

/** The command-name token of a slash input: `/` + non-space chars, with nothing after it yet. */
function slashQuery(text: string): string | null {
  const m = text.match(/^\/([^\s]*)$/)
  return m ? m[1]! : null
}

/** Split a fully-typed `/name arg…` line into its command and (raw) argument. */
function parseSlash(text: string): { cmd: SlashCommand; arg: string } | null {
  const m = text.match(/^\/(\S+)([\s\S]*)$/)
  if (!m) return null
  const cmd = findCommand(m[1]!)
  return cmd ? { cmd, arg: m[2]!.replace(/^\s+/, '') } : null
}

/** Stable empty list so a thread with nothing staged doesn't re-render the composer every tick. */
const NO_ATTACHMENTS: Attachment[] = []

const PRESETS = [
  { key: 'manual', label: 'Manual', hint: 'Read-only tools; side-effect tools stay disabled' },
  { key: 'workspace', label: 'Auto', hint: 'Allow workspace reads and writes; shell and destructive tools ask for approval' },
  { key: 'full', label: 'Full', hint: 'Full local access' }
] as const

const MODES = [
  { key: 'plan', label: 'Plan', hint: 'Investigate and propose a plan; no mutating actions' },
  { key: 'act', label: 'Act', hint: 'Execute the task using the permitted tools' },
  { key: 'review', label: 'Review', hint: 'Inspect and assess changes; make no new edits' }
] as const

export function Composer(): React.JSX.Element {
  const [text, setTextState] = useState('')
  const send = useStore((s) => s.send)
  // Drafts live in the store per thread (and in localStorage), so switching chats or relaunching
  // never loses what was typed; the textarea mirrors the active thread's draft.
  const drafts = useStore((s) => s.drafts)
  const setDraft = useStore((s) => s.setDraft)
  const activeId = useStore((s) => s.activeThreadId)
  const setText = (next: string): void => {
    setTextState(next)
    if (activeId) setDraft(activeId, next)
  }
  useEffect(() => {
    setTextState(activeId ? (drafts[activeId] ?? '') : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-seed when the thread changes
  }, [activeId])
  const cancel = useStore((s) => s.cancel)
  const budget = useStore((s) => s.budget)
  const setUi = useStore((s) => s.setUi)
  const thread = useStore((s) => activeThread(s))
  const models = useStore((s) => s.models)
  const setEffort = useStore((s) => s.setEffort)
  const setMode = useStore((s) => s.setMode)
  const setPreset = useStore((s) => s.setPreset)
  const setGoal = useStore((s) => s.setGoal)
  const sendKey = useStore((s) => s.settings?.sendKey ?? 'enter')
  const flash = useStore((s) => s.flash)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // ---- staged images (pasted, dropped, or chosen) ----
  // They live in the store per thread, so switching chats and coming back keeps what you staged.
  const draftAttachments = useStore((s) => s.draftAttachments)
  const setDraftAttachments = useStore((s) => s.setDraftAttachments)
  const attachments = (activeId && draftAttachments[activeId]) || NO_ATTACHMENTS
  const [dragging, setDragging] = useState(false)

  const addFiles = useCallback(
    async (files: File[]): Promise<void> => {
      if (!activeId || !files.length) return
      const current = useStore.getState().draftAttachments[activeId] ?? []
      const { added, error } = await acceptImageFiles(files, current)
      if (added.length) setDraftAttachments(activeId, [...current, ...added])
      if (error) flash(error, 'warn')
    },
    [activeId, setDraftAttachments, flash]
  )
  const removeAttachment = (id: string): void => {
    if (!activeId) return
    setDraftAttachments(activeId, attachments.filter((a) => a.id !== id))
  }

  const [quickOpen, setQuickOpen] = useState(false)

  // ---- slash command palette ----
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashEscaped, setSlashEscaped] = useState(false)
  const query = slashQuery(text)
  const slashCommands = useMemo(() => (query === null ? [] : filterCommands(query)), [query])
  const slashOpen = query !== null && !slashEscaped
  const boundedIndex = Math.min(slashIndex, Math.max(0, slashCommands.length - 1))

  const setInput = (value: string): void => {
    setText(value)
    setSlashEscaped(false)
    setSlashIndex(0)
    requestAnimationFrame(autoGrow)
  }

  /**
   * Run (or begin) a slash command. A command that requires an argument and has none yet
   * is not executed — the composer is primed with `/name ` so the user can type the argument.
   */
  const runSlash = (cmd: SlashCommand, arg: string): void => {
    if (cmd.expectsArg === 'required' && !arg.trim()) {
      setInput(`/${cmd.name} `)
      taRef.current?.focus()
      return
    }
    void cmd.run(arg)
    setText('')
    setSlashEscaped(false)
    if (taRef.current) taRef.current.style.height = 'auto'
  }

  // "Running" is three different things to the composer: a reply streaming (Enter steers, Stop
  // cancels), only background work in flight (Enter sends normally, Stop stops that work), or idle.
  const events = useStore((s) => s.events)
  const jobs = useStore((s) => s.jobs)
  const messages = useStore((s) => s.messages)
  const stopBackgroundWork = useStore((s) => s.stopBackgroundWork)
  const work = useMemo(
    () => summarizeBackgroundWork(events, jobs, messages, !!thread?.running),
    [events, jobs, messages, thread?.running]
  )
  const running = !!thread?.running && !work.backgroundOnly
  const hasDraft = !!text.trim() || attachments.length > 0
  // Hard stop: once an idle thread's context passes the block threshold, refuse to start a new turn
  // (it would overflow the window) until the user frees room. Steering an in-flight run is never
  // blocked, and slash commands (/compact, /clear, /model) route around this entirely.
  const blockThreshold = useStore((s) => s.settings?.blockThreshold ?? 0.97)
  const overContext = !running && !!budget && budget.occupancy >= blockThreshold
  const model = models.find((m) => m.id === thread?.model)
  const modelLabel = model?.name ?? thread?.model ?? 'Choose model'
  // Staging an image on a model that reports no vision support is allowed but flagged: gateway
  // capability metadata is often wrong, so this warns rather than blocks.
  const modelSeesImages = model?.capabilities.vision !== false

  // Only surface a thinking control for models that actually reason. The ladder is the model's
  // real range — declared tiers ∪ the known family range (so Opus 4.8 reaches "max", GPT-5 reaches
  // "minimal") — with "off" always available, never a hardcoded low/medium/high cap.
  const ordered = model ? resolveEffortTiers(model) : []
  const supportsEffort = ordered.length > 0
  const thinkTiers = ordered.some((t) => t === 'off' || t === 'none') ? ordered : ['off', ...ordered]
  const thinkValue =
    thread?.effort && thinkTiers.includes(thread.effort)
      ? thread.effort
      : thinkTiers.includes('high')
        ? 'high'
        : thinkTiers[0]!

  const doSend = (disposition: 'send' | 'steer' | 'queue'): void => {
    const trimmed = text.trim()
    // An image with no words is a real message ("look at this"), so a staged image is enough to send.
    if (!trimmed && !attachments.length) return
    // A fresh turn into an over-full context is refused, and the draft is kept so the user can
    // /compact or switch models and resend without retyping.
    if (disposition === 'send' && overContext) {
      flash('Context is full — compact the conversation (/compact) or switch to a larger-context model before sending.', 'warn')
      return
    }
    void send({ text: trimmed, disposition, ...(attachments.length ? { attachments } : {}) })
    setText('')
    if (activeId) setDraftAttachments(activeId, [])
    if (taRef.current) taRef.current.style.height = 'auto'
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // While the palette is open, arrows/enter/tab/escape drive it instead of the textarea.
    if (slashOpen && slashCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex((i) => (Math.min(i, slashCommands.length - 1) + 1) % slashCommands.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex((i) => (Math.min(i, slashCommands.length - 1) + slashCommands.length - 1) % slashCommands.length)
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        const cmd = slashCommands[boundedIndex]!
        setInput(`/${cmd.name}${cmd.expectsArg ? ' ' : ''}`)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        runSlash(slashCommands[boundedIndex]!, '')
        return
      }
    }
    if (e.key === 'Escape' && slashOpen) {
      e.preventDefault()
      setSlashEscaped(true)
      return
    }
    if (e.key === 'Enter') {
      const action = sendAction(sendKey, e)
      if (action === 'newline') return // Shift+Enter, or a bare Enter in mod-enter mode → newline
      // A fully-typed "/name arg" line runs the command instead of sending a message.
      const parsed = text.startsWith('/') ? parseSlash(text) : null
      if (parsed) {
        e.preventDefault()
        runSlash(parsed.cmd, parsed.arg)
        return
      }
      e.preventDefault()
      if (action === 'queue') doSend('queue')
      else doSend(running ? 'steer' : 'send')
    }
  }

  const autoGrow = (): void => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 320)}px`
  }

  return (
    <div className="composer-wrap">
      <div className="composer-inner">
        <div className="composer-controls">
          <div className="perm-seg" role="radiogroup" aria-label="Permission preset">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                className={`${thread?.permissionPreset === p.key ? 'active' : ''} ${p.key === 'full' ? 'full' : ''}`}
                role="radio"
                aria-checked={thread?.permissionPreset === p.key}
                onClick={() => void setPreset(p.key)}
                title={p.hint}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="perm-seg mode-seg" role="radiogroup" aria-label="Mode">
            {MODES.map((m) => (
              <button
                key={m.key}
                className={`${thread?.mode === m.key ? 'active' : ''} ${m.key === 'plan' ? 'plan' : ''} ${m.key === 'review' ? 'review' : ''}`}
                role="radio"
                aria-checked={thread?.mode === m.key}
                onClick={() => void setMode(m.key)}
                title={m.hint}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {thread?.goal && (
          <div className="goal-banner" title={thread.goal}>
            <I name="flag" size={14} />
            <span className="goal-label">Goal</span>
            <span className="goal-text">{thread.goal}</span>
            <button
              className="goal-clear"
              onClick={() => void setGoal('')}
              title="Clear goal"
              aria-label="Clear goal"
            >
              <I name="close" size={14} />
            </button>
          </div>
        )}

        {overContext && (
          <div className="context-block-banner" role="status">
            <I name="warning" size={14} />
            <span>
              Context is full ({Math.round((budget?.occupancy ?? 0) * 100)}%). Compact the conversation
              with <code>/compact</code> or switch to a larger-context model to keep going.
            </span>
          </div>
        )}

        {work.backgroundOnly && (
          <div className="composer-background" role="status">
            <I name="account_tree" size={14} />
            <span>
              In the background: {describeBackgroundWork(work)} · results land here when done
            </span>
            <span className="spacer" />
            <button className="link" onClick={() => setUi({ inspectorOpen: true, inspectorTab: 'agents' })}>
              Open
            </button>
            <button
              className="link"
              onClick={() => void stopBackgroundWork(work.agentIds, work.jobIds)}
              title="Stop every running subagent and job on this chat"
            >
              Stop all
            </button>
          </div>
        )}
        <div
          className={`composer ${dragging ? 'dropping' : ''}`}
          onDragOver={(e) => {
            if (!hasImagePayload(e.dataTransfer)) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
            setDragging(true)
          }}
          onDragLeave={(e) => {
            // Only when the pointer actually leaves the composer, not on every child boundary.
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
            setDragging(false)
          }}
          onDrop={(e) => {
            const files = imageFilesFrom(e.dataTransfer)
            setDragging(false)
            if (!files.length) return
            e.preventDefault()
            void addFiles(files)
          }}
        >
          {attachments.length > 0 && (
            <div className="composer-attachments" aria-label="Attached images">
              {attachments.map((a) => (
                <figure key={a.id} className="attachment-chip">
                  <img src={a.content} alt={a.name} />
                  <figcaption title={`${a.name} · ${fmtBytes(a.bytes)}`}>
                    <span className="attachment-name">{a.name}</span>
                    <span className="attachment-size">{fmtBytes(a.bytes)}</span>
                  </figcaption>
                  <button
                    className="attachment-remove"
                    onClick={() => removeAttachment(a.id)}
                    title="Remove this image"
                    aria-label={`Remove ${a.name}`}
                  >
                    <I name="close" size={13} />
                  </button>
                </figure>
              ))}
              {!modelSeesImages && (
                <div className="attachment-warning" role="status">
                  <I name="visibility_off" size={14} />
                  {modelLabel} doesn’t report vision support — it may not be able to see these.
                </div>
              )}
            </div>
          )}
          {slashOpen && (
            <SlashMenu
              commands={slashCommands}
              activeIndex={boundedIndex}
              query={query ?? ''}
              onSelect={(cmd) => runSlash(cmd, '')}
              onHover={setSlashIndex}
            />
          )}
          <textarea
            ref={taRef}
            rows={1}
            placeholder={running ? 'Steer the run…' : 'Message, or / for commands…'}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setSlashEscaped(false)
              setSlashIndex(0)
              autoGrow()
            }}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              // Only swallow the paste when it really carries an image; copied text, and text
              // copied alongside an image, must still land in the textarea.
              if (!hasImagePayload(e.clipboardData)) return
              e.preventDefault()
              void addFiles(imageFilesFrom(e.clipboardData))
            }}
          />
          <div className="composer-row">
            <div className="model-chip-wrap">
              <button
                className="model-chip"
                onClick={() => setQuickOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={quickOpen}
                title={`${modelLabel}${model?.capabilities.tools ? ' · tools enabled' : ''} — switch model (⌘M for all)`}
              >
                <I name="model_training" size={15} />
                <span className="name">{modelLabel}</span>
                <I name="expand_more" size={14} />
              </button>
              <ModelQuickPicker open={quickOpen} onClose={() => setQuickOpen(false)} />
            </div>
            {supportsEffort && (
              // The visible label sizes the control to the selected tier; the native <select>
              // is overlaid transparently so longer labels like "Extra high" get room while
              // shorter ones like "High" leave no dead space.
              <label className="think-control" title="Thinking effort — reasoning is kept out of the chat">
                <span className="think-value" aria-hidden="true">{thinkLabel(thinkValue)}</span>
                <I name="expand_more" size={14} />
                <select
                  className="think-select"
                  value={thinkValue}
                  onChange={(e) => void setEffort(e.target.value)}
                  aria-label="Thinking effort"
                >
                  {thinkTiers.map((t) => (
                    <option key={t} value={t}>
                      {thinkLabel(t)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button
              className="icon-btn"
              onClick={() => fileRef.current?.click()}
              disabled={!activeId || attachments.length >= MAX_IMAGES_PER_MESSAGE}
              title={
                attachments.length >= MAX_IMAGES_PER_MESSAGE
                  ? `${MAX_IMAGES_PER_MESSAGE} images is the limit for one message`
                  : `Attach an image (${SUPPORTED_IMAGE_TEXT}) — or just paste or drop one`
              }
              aria-label="Attach an image"
            >
              <I name="add_circle" size={17} />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              hidden
              onChange={(e) => {
                void addFiles(Array.from(e.target.files ?? []))
                e.target.value = '' // so choosing the same file twice in a row still fires
              }}
            />
            <div className="spacer" />
            <ContextOrbit
              budget={budget}
              onClick={() => setUi({ inspectorOpen: true, inspectorTab: 'context' })}
            />
            <div className="execute-wrap">
              {running ? (
                hasDraft ? (
                  // A typed draft turns Stop into Steer: the draft is injected at the next safe
                  // boundary (same path as pressing ↵ while running) rather than killing the run.
                  <button
                    className="execute-btn steer"
                    onClick={() => doSend('steer')}
                    aria-label="Steer the run with your draft"
                    title="Steer the run with your draft (↵)"
                  >
                    Steer
                    <I name="keyboard_return" size={15} />
                  </button>
                ) : (
                  <button
                    className="execute-btn stop"
                    onClick={() => void cancel()}
                    aria-label="Stop the run"
                  >
                    Stop
                    <I name="stop" size={15} />
                  </button>
                )
              ) : (
                <button
                  className="execute-btn"
                  onClick={() => doSend('send')}
                  disabled={!hasDraft || overContext}
                  title={overContext ? 'Context is full — compact or switch models to send' : undefined}
                >
                  Execute
                  <I name="keyboard_return" size={15} />
                </button>
              )}
              <div className="send-hint" role="tooltip">
                {running ? (
                  <>
                    <span><kbd>↵</kbd> steer</span>
                    <span><kbd>⌘</kbd><kbd>↵</kbd> queue after run</span>
                    <span><kbd>⇧</kbd><kbd>↵</kbd> newline</span>
                  </>
                ) : (
                  <>
                    <span><kbd>↵</kbd> send</span>
                    <span><kbd>⌘</kbd><kbd>↵</kbd> queue</span>
                    <span><kbd>⇧</kbd><kbd>↵</kbd> newline</span>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
