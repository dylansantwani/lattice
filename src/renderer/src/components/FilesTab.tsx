import React from 'react'
import { useStore } from '@/state/store'
import { Markdown } from './Markdown'
import { I } from './Icon'
import { lineDiff, diffStat, type DiffRow } from './filesDiff'
import type { FileChange, FsEntry, FsFile } from '@shared/types'

const KIND_LABEL: Record<FileChange['kind'], string> = {
  create: 'new',
  edit: 'edited',
  delete: 'deleted',
  move: 'moved'
}

function baseName(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdx'])
function extOf(path: string): string {
  const b = baseName(path)
  const i = b.lastIndexOf('.')
  return i > 0 ? b.slice(i + 1).toLowerCase() : ''
}

export function FilesTab(): React.JSX.Element {
  const [mode, setMode] = React.useState<'changes' | 'browse'>('changes')
  return (
    <div className="files-tab">
      <div className="files-modeseg" role="tablist">
        <button role="tab" aria-selected={mode === 'changes'} className={mode === 'changes' ? 'active' : ''} onClick={() => setMode('changes')}>
          Changes
        </button>
        <button role="tab" aria-selected={mode === 'browse'} className={mode === 'browse' ? 'active' : ''} onClick={() => setMode('browse')}>
          Browse
        </button>
      </div>
      {mode === 'changes' ? <ChangesView /> : <BrowseView />}
    </div>
  )
}

// --------------------------------------------------------------------------- Changes (session diff)

function ChangesView(): React.JSX.Element {
  const threadId = useStore((s) => s.activeThreadId)
  const filesChangedAt = useStore((s) => s.filesChangedAt)
  const [changes, setChanges] = React.useState<FileChange[]>([])
  const [openPath, setOpenPath] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!threadId) {
      setChanges([])
      return
    }
    void window.lattice.fileChanges(threadId).then(setChanges)
  }, [threadId, filesChangedAt])

  if (changes.length === 0)
    return (
      <div style={{ color: 'var(--text-faint)', padding: '4px 2px' }}>
        No file changes yet. Files the agent creates, edits, or deletes on this thread show up here
        with a before → after diff.
      </div>
    )

  return (
    <div className="files-changes">
      {changes.map((c) => {
        const { added, removed } = diffStat(c.before, c.after)
        const open = openPath === c.path
        return (
          <div key={c.path} className="file-change">
            <button className="file-change-row" onClick={() => setOpenPath(open ? null : c.path)} title={c.path}>
              <I name={open ? 'expand_more' : 'chevron_right'} size={16} />
              <span className={`file-change-kind k-${c.kind}`}>{KIND_LABEL[c.kind]}</span>
              <span className="file-change-name">{baseName(c.path)}</span>
              <span className="file-change-stat">
                {added > 0 && <span className="d-add">+{added}</span>}
                {removed > 0 && <span className="d-del">−{removed}</span>}
              </span>
            </button>
            {open && (
              <div className="file-change-body">
                <div className="file-change-path">{c.path}</div>
                {c.kind === 'delete' ? (
                  <div className="files-note">File was deleted.</div>
                ) : (
                  <DiffBlock before={c.before} after={c.after} />
                )}
                {(c.beforeTruncated || c.afterTruncated) && (
                  <div className="files-note">Large file — diff is clipped to the first 256 KB.</div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function DiffBlock({ before, after }: { before: string | null; after: string | null }): React.JSX.Element {
  const rows = React.useMemo(() => lineDiff(before ?? '', after ?? ''), [before, after])
  return (
    <div className="diff-block">
      {rows.map((r, i) => (
        <DiffLine key={i} row={r} />
      ))}
    </div>
  )
}

function DiffLine({ row }: { row: DiffRow }): React.JSX.Element {
  if (row.type === 'fold')
    return <div className="diff-line fold">⋯ {row.count} unchanged line{row.count === 1 ? '' : 's'}</div>
  const sign = row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' '
  return (
    <div className={`diff-line ${row.type}`}>
      <span className="diff-gutter">{sign}</span>
      <span className="diff-text">{row.text === '' ? ' ' : row.text}</span>
    </div>
  )
}

// ------------------------------------------------------------------------------------------ Browse

function BrowseView(): React.JSX.Element {
  const [roots, setRoots] = React.useState<FsEntry[]>([])
  const [selected, setSelected] = React.useState<string | null>(null)

  React.useEffect(() => {
    void window.lattice.fsTree().then(setRoots)
  }, [])

  if (selected) return <FileViewer path={selected} onBack={() => setSelected(null)} />

  return (
    <div className="files-tree">
      {roots.length === 0 && <div style={{ color: 'var(--text-faint)' }}>No approved roots.</div>}
      {roots.map((r) => (
        <TreeNode key={r.path} entry={r} depth={0} onOpenFile={setSelected} defaultOpen={roots.length === 1} />
      ))}
    </div>
  )
}

function TreeNode({
  entry,
  depth,
  onOpenFile,
  defaultOpen
}: {
  entry: FsEntry
  depth: number
  onOpenFile: (path: string) => void
  defaultOpen?: boolean
}): React.JSX.Element {
  const [open, setOpen] = React.useState(!!defaultOpen)
  const [children, setChildren] = React.useState<FsEntry[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (entry.kind === 'dir' && open && children === null) {
      window.lattice
        .fsTree(entry.path)
        .then(setChildren)
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
    }
  }, [open, entry.kind, entry.path, children])

  if (entry.kind === 'file') {
    return (
      <button className="tree-row" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onOpenFile(entry.path)} title={entry.path}>
        <I name="description" size={15} />
        <span className="tree-name">{entry.name}</span>
        {typeof entry.size === 'number' && <span className="tree-size">{fmtBytes(entry.size)}</span>}
      </button>
    )
  }
  return (
    <>
      <button className="tree-row" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setOpen((o) => !o)} title={entry.path}>
        <I name={open ? 'expand_more' : 'chevron_right'} size={15} />
        <I name={open ? 'folder_open' : 'folder'} size={15} />
        <span className="tree-name">{entry.name}</span>
      </button>
      {open && error && <div className="files-note" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>{error}</div>}
      {open &&
        children?.map((c) => (
          <TreeNode key={c.path} entry={c} depth={depth + 1} onOpenFile={onOpenFile} />
        ))}
    </>
  )
}

function FileViewer({ path, onBack }: { path: string; onBack: () => void }): React.JSX.Element {
  const [file, setFile] = React.useState<FsFile | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    setFile(null)
    setError(null)
    window.lattice
      .fsReadFile(path)
      .then(setFile)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [path])

  const isMd = MARKDOWN_EXT.has(extOf(path))

  return (
    <div className="file-viewer">
      <button className="file-viewer-back" onClick={onBack}>
        <I name="arrow_back" size={15} /> Back
      </button>
      <div className="file-viewer-path" title={path}>
        {baseName(path)}
        {file && <span className="file-viewer-size"> · {fmtBytes(file.size)}</span>}
      </div>
      {error && <div className="files-note">{error}</div>}
      {!file && !error && <div style={{ color: 'var(--text-faint)' }}>Loading…</div>}
      {file?.kind === 'image' && <img className="file-viewer-img" src={file.dataUrl} alt={baseName(path)} />}
      {file?.kind === 'binary' && <div className="files-note">Binary or oversized file — not shown.</div>}
      {file?.kind === 'text' &&
        (isMd ? (
          <div className="file-viewer-md">
            <Markdown text={file.text ?? ''} />
          </div>
        ) : (
          <pre className="file-viewer-code">{file.text}</pre>
        ))}
      {file?.truncated && <div className="files-note">Large file — showing the first 512 KB.</div>}
    </div>
  )
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
