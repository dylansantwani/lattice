import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Todo, TodoStatus } from '@shared/types'
import { useStore } from '@/state/store'
import { I } from './Icon'
import {
  buildTodoTree,
  flattenTree,
  isFinished,
  moveId,
  orderedIds,
  partitionFinished,
  todoProgress,
  toggledStatus,
  TODO_STATUSES,
  TODO_STATUS_LABEL,
  type TodoNode
} from './todoTree'

/** Glyph + accent per status. `done` reads as a ticked box, `todo` as an empty one. */
const STATUS_META: Record<TodoStatus, { icon: string; color: string }> = {
  todo: { icon: 'check_box_outline_blank', color: 'var(--text-faint)' },
  in_progress: { icon: 'pending', color: 'var(--brass)' },
  blocked: { icon: 'block', color: 'var(--red)' },
  review: { icon: 'rate_review', color: 'var(--violet-soft)' },
  done: { icon: 'check_box', color: 'var(--green)' },
  canceled: { icon: 'disabled_by_default', color: 'var(--text-faint)' }
}

const SHOW_DONE_KEY = 'lattice.tasks.showDone'
const MAX_DEPTH = 2

function readShowDone(): boolean {
  try {
    return localStorage.getItem(SHOW_DONE_KEY) !== '0'
  } catch {
    return true
  }
}

/**
 * The Tasks panel: the thread's checklist, shared between the agent (todo_write) and the user.
 * Everything is editable in place — add, check off, change status, rename, nest a subtask, drag
 * to reorder, delete — and every edit is echoed back to the model on its next turn.
 */
export function TasksPanel(): React.JSX.Element {
  const threadId = useStore((s) => s.activeThreadId)
  const todos = useStore((s) => s.todos)
  const addTodo = useStore((s) => s.addTodo)
  const updateTodo = useStore((s) => s.updateTodo)
  const deleteTodo = useStore((s) => s.deleteTodo)
  const clearTodos = useStore((s) => s.clearTodos)
  const reorderTodos = useStore((s) => s.reorderTodos)

  const [showDone, setShowDone] = useState(readShowDone)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [subtaskFor, setSubtaskFor] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ id: string; place: 'before' | 'after' } | null>(null)

  const tree = useMemo(() => buildTodoTree(todos), [todos])
  const { open, finished } = useMemo(() => partitionFinished(tree), [tree])
  const progress = useMemo(() => todoProgress(todos), [todos])
  const finishedCount = useMemo(() => flattenTree(finished).length, [finished])

  useEffect(() => {
    try {
      localStorage.setItem(SHOW_DONE_KEY, showDone ? '1' : '0')
    } catch {
      /* per-viewer convenience only */
    }
  }, [showDone])

  // Leaving the thread drops any half-finished inline edit.
  useEffect(() => {
    setEditingId(null)
    setSubtaskFor(null)
  }, [threadId])

  const rootIds = useMemo(() => tree.map((n) => n.item.id), [tree])

  const onDropRow = useCallback(
    (targetId: string, place: 'before' | 'after') => {
      if (!dragId) return
      const next = moveId(rootIds, dragId, targetId, place)
      if (next !== rootIds) {
        const byId = new Map(tree.map((n) => [n.item.id, n]))
        void reorderTodos(orderedIds(next.map((id) => byId.get(id)!).filter(Boolean)))
      }
      setDragId(null)
      setDropAt(null)
    },
    [dragId, rootIds, tree, reorderTodos]
  )

  const rowProps = {
    editingId,
    subtaskFor,
    dragId,
    dropAt,
    onToggle: (t: Todo) => void updateTodo(t.id, { status: toggledStatus(t.status) }),
    onStatus: (t: Todo, status: TodoStatus) => void updateTodo(t.id, { status }),
    onRename: (t: Todo, title: string) => {
      setEditingId(null)
      if (title.trim() && title.trim() !== t.title) void updateTodo(t.id, { title: title.trim() })
    },
    onEdit: (t: Todo) => setEditingId(t.id),
    onCancelEdit: () => setEditingId(null),
    onDelete: (t: Todo) => void deleteTodo(t.id),
    onAddSubtask: (t: Todo) => setSubtaskFor((cur) => (cur === t.id ? null : t.id)),
    onSubmitSubtask: (t: Todo, title: string) => {
      if (title.trim()) void addTodo(title, t.id)
    },
    onCloseSubtask: () => setSubtaskFor(null),
    onDragStart: (t: Todo) => setDragId(t.id),
    onDragEnd: () => {
      setDragId(null)
      setDropAt(null)
    },
    onDragOver: (t: Todo, place: 'before' | 'after') => {
      if (dragId && dragId !== t.id) setDropAt((cur) => (cur?.id === t.id && cur.place === place ? cur : { id: t.id, place }))
    },
    onDrop: onDropRow
  }

  const renderNodes = (nodes: TodoNode<Todo>[]): React.JSX.Element[] =>
    flattenTree(nodes).map((n) => <TodoRow key={n.item.id} node={n} {...rowProps} />)

  if (!threadId) return <div className="tasks-empty">Open a thread to see its checklist.</div>

  return (
    <div className="tasks-panel">
      <TasksHeader
        progress={progress}
        finishedCount={finishedCount}
        showDone={showDone}
        onToggleShowDone={() => setShowDone((v) => !v)}
        onClear={(mode) => void clearTodos(mode)}
        total={todos.length}
      />
      <AddTaskBox onAdd={(title) => void addTodo(title)} />
      {todos.length === 0 ? (
        <div className="tasks-empty">Nothing yet. Add a task, or the agent will plan here as it works.</div>
      ) : (
        <div className="todo-list" role="list" aria-label="Checklist">
          {renderNodes(open)}
          {finished.length > 0 && (
            <>
              <button className="todo-done-toggle" onClick={() => setShowDone((v) => !v)} aria-expanded={showDone}>
                <I name={showDone ? 'expand_more' : 'chevron_right'} size={16} />
                {finishedCount} finished
              </button>
              {showDone && renderNodes(finished)}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function TasksHeader({
  progress,
  finishedCount,
  showDone,
  onToggleShowDone,
  onClear,
  total
}: {
  progress: ReturnType<typeof todoProgress>
  finishedCount: number
  showDone: boolean
  onToggleShowDone: () => void
  onClear: (mode: 'done' | 'all') => void
  total: number
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirm, setConfirm] = useState<'done' | 'all' | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onDoc = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
        setConfirm(null)
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setMenuOpen(false)
        setConfirm(null)
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const pct = Math.round(progress.fraction * 100)
  const clearItem = (mode: 'done' | 'all', label: string, count: number): React.JSX.Element => (
    <button
      className={`todo-menu-item ${confirm === mode ? 'danger' : ''}`}
      disabled={count === 0}
      onClick={() => {
        if (confirm === mode) {
          onClear(mode)
          setMenuOpen(false)
          setConfirm(null)
        } else {
          setConfirm(mode)
        }
      }}
    >
      <I name={confirm === mode ? 'warning' : mode === 'done' ? 'cleaning_services' : 'delete_sweep'} size={15} />
      {confirm === mode ? `Delete ${count} task${count === 1 ? '' : 's'}? Click again` : `${label} (${count})`}
    </button>
  )

  return (
    <div className="tasks-head">
      <div className="tasks-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} title={`${pct}% done`}>
        <div className="tasks-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="tasks-count">
        {progress.done}/{progress.total}
        {progress.blocked > 0 && (
          <span className="tasks-blocked" title={`${progress.blocked} blocked`}>
            {' '}
            · {progress.blocked} blocked
          </span>
        )}
      </span>
      <div className="todo-menu-wrap" ref={menuRef}>
        <button
          className="icon-btn todo-menu-btn"
          aria-label="Checklist options"
          aria-expanded={menuOpen}
          onClick={() => {
            setMenuOpen((v) => !v)
            setConfirm(null)
          }}
        >
          <I name="more_horiz" size={18} />
        </button>
        {menuOpen && (
          <div className="todo-menu" role="menu">
            <button className="todo-menu-item" onClick={onToggleShowDone} disabled={finishedCount === 0}>
              <I name={showDone ? 'visibility_off' : 'visibility'} size={15} />
              {showDone ? 'Hide finished' : 'Show finished'}
            </button>
            {clearItem('done', 'Clear finished', finishedCount)}
            {clearItem('all', 'Clear all', total)}
          </div>
        )}
      </div>
    </div>
  )
}

/** The always-visible quick-add box. Enter adds and keeps focus for the next one; Esc clears. */
function AddTaskBox({ onAdd, placeholder = 'Add a task…', autoFocus, onClose, compact }: {
  onAdd: (title: string) => void
  placeholder?: string
  autoFocus?: boolean
  onClose?: () => void
  compact?: boolean
}): React.JSX.Element {
  const [text, setText] = useState('')
  return (
    <div className={`todo-add ${compact ? 'compact' : ''}`}>
      <I name="add" size={16} className="todo-add-icon" />
      <input
        className="todo-add-input"
        value={text}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (text.trim()) {
              onAdd(text)
              setText('')
            }
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setText('')
            onClose?.()
          }
        }}
        onBlur={() => {
          if (compact && !text.trim()) onClose?.()
        }}
      />
    </div>
  )
}

interface RowProps {
  node: TodoNode<Todo>
  editingId: string | null
  subtaskFor: string | null
  dragId: string | null
  dropAt: { id: string; place: 'before' | 'after' } | null
  onToggle: (t: Todo) => void
  onStatus: (t: Todo, status: TodoStatus) => void
  onRename: (t: Todo, title: string) => void
  onEdit: (t: Todo) => void
  onCancelEdit: () => void
  onDelete: (t: Todo) => void
  onAddSubtask: (t: Todo) => void
  onSubmitSubtask: (t: Todo, title: string) => void
  onCloseSubtask: () => void
  onDragStart: (t: Todo) => void
  onDragEnd: () => void
  onDragOver: (t: Todo, place: 'before' | 'after') => void
  onDrop: (targetId: string, place: 'before' | 'after') => void
}

function TodoRow(p: RowProps): React.JSX.Element {
  const { node } = p
  const t = node.item
  const meta = STATUS_META[t.status] ?? STATUS_META.todo
  const finished = isFinished(t.status)
  const editing = p.editingId === t.id
  const isRoot = node.depth === 0
  const dropHere = p.dropAt?.id === t.id ? p.dropAt.place : null

  return (
    <>
      <div
        className={[
          'todo-row',
          `depth-${node.depth}`,
          `status-${t.status}`,
          finished ? 'finished' : '',
          p.dragId === t.id ? 'dragging' : '',
          dropHere ? `drop-${dropHere}` : ''
        ].join(' ')}
        style={{ paddingLeft: 4 + node.depth * 18 }}
        role="listitem"
        draggable={isRoot && !editing}
        onDragStart={(e) => {
          if (!isRoot) return
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', t.id)
          p.onDragStart(t)
        }}
        onDragEnd={p.onDragEnd}
        onDragOver={(e) => {
          if (!p.dragId || !isRoot) return
          e.preventDefault()
          const box = e.currentTarget.getBoundingClientRect()
          p.onDragOver(t, e.clientY - box.top < box.height / 2 ? 'before' : 'after')
        }}
        onDrop={(e) => {
          if (!isRoot) return
          e.preventDefault()
          const box = e.currentTarget.getBoundingClientRect()
          p.onDrop(t.id, e.clientY - box.top < box.height / 2 ? 'before' : 'after')
        }}
      >
        {isRoot && <I name="drag_indicator" size={16} className="todo-grip" />}
        <button
          className="todo-check"
          style={{ color: meta.color }}
          aria-label={finished ? 'Reopen' : 'Mark done'}
          aria-pressed={t.status === 'done'}
          title={TODO_STATUS_LABEL[t.status]}
          onClick={() => p.onToggle(t)}
        >
          <I name={meta.icon} size={18} />
        </button>
        <div className="todo-main">
          {editing ? (
            <TitleEditor initial={t.title} onSave={(v) => p.onRename(t, v)} onCancel={p.onCancelEdit} />
          ) : (
            <span className="todo-title" onDoubleClick={() => p.onEdit(t)} title="Double-click to rename">
              {t.title}
              {t.source === 'user' && <I name="person" size={12} className="todo-by-user" />}
            </span>
          )}
          {t.details && !editing && <span className="todo-details">{t.details}</span>}
          <div className="todo-meta">
            <select
              className={`todo-status-select ${t.status !== 'todo' && t.status !== 'done' ? 'shown' : ''}`}
              style={{ color: meta.color }}
              value={t.status}
              aria-label="Status"
              onChange={(e) => p.onStatus(t, e.target.value as TodoStatus)}
            >
              {TODO_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {TODO_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="todo-actions">
          {node.depth < MAX_DEPTH && (
            <button className="todo-action" aria-label="Add subtask" title="Add subtask" onClick={() => p.onAddSubtask(t)}>
              <I name="subdirectory_arrow_right" size={15} />
            </button>
          )}
          <button className="todo-action" aria-label="Rename" title="Rename" onClick={() => p.onEdit(t)}>
            <I name="edit" size={15} />
          </button>
          <button className="todo-action danger" aria-label="Delete" title="Delete" onClick={() => p.onDelete(t)}>
            <I name="close" size={15} />
          </button>
        </div>
      </div>
      {p.subtaskFor === t.id && (
        <div style={{ paddingLeft: 26 + node.depth * 18 }}>
          <AddTaskBox
            compact
            autoFocus
            placeholder="Subtask…"
            onAdd={(title) => p.onSubmitSubtask(t, title)}
            onClose={p.onCloseSubtask}
          />
        </div>
      )}
    </>
  )
}

function TitleEditor({ initial, onSave, onCancel }: { initial: string; onSave: (v: string) => void; onCancel: () => void }): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      className="todo-title-input"
      value={value}
      aria-label="Task title"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onSave(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onSave(value)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
    />
  )
}
