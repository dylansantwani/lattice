import React, { useState } from 'react'
import type { ApprovalRequest, ApprovalScope } from '@shared/types'
import { useStore } from '@/state/store'
import { I } from './Icon'

const SCOPES: { key: ApprovalScope; label: string; hint: string }[] = [
  { key: 'once', label: 'Once', hint: 'Just this call' },
  { key: 'run', label: 'This run', hint: 'Auto-allow this tool for the rest of this run' },
  { key: 'thread', label: 'This chat', hint: 'Auto-allow this tool for the whole thread' }
]

/** Prompt(s) for tool calls the model wants to run that need the user's OK (Auto preset). */
export function ApprovalBar(): React.JSX.Element | null {
  const activeThreadId = useStore((s) => s.activeThreadId)
  const approvals = useStore((s) => s.approvals)
  const pending = approvals.filter((a) => a.threadId === activeThreadId)
  if (pending.length === 0) return null
  return (
    <div className="approval-stack">
      {pending.map((req) => (
        <ApprovalCard key={req.id} req={req} extra={pending.length - 1} />
      ))}
    </div>
  )
}

function argPreview(req: ApprovalRequest): string | null {
  const a = req.args
  if (!a || typeof a !== 'object') return null
  const args = a as Record<string, unknown>
  if (typeof args.command === 'string') return args.command
  if (typeof args.path === 'string') return args.path
  if (typeof args.from === 'string' && typeof args.to === 'string') return `${args.from} → ${args.to}`
  return null
}

function ApprovalCard({ req, extra }: { req: ApprovalRequest; extra: number }): React.JSX.Element {
  const respond = useStore((s) => s.respondApproval)
  const [scope, setScope] = useState<ApprovalScope>('run')
  const preview = argPreview(req)

  const decide = (effect: 'allow' | 'deny'): void => {
    void respond({ requestId: req.id, effect, scope: effect === 'allow' ? scope : 'once' })
  }

  return (
    <div className="approval-card">
      <div className="approval-head">
        <span className="approval-risk" title={`Risk tier ${req.riskTier}`}>
          <I name="shield_lock" size={15} />
          {req.riskTier}
        </span>
        <span className="approval-tool">{req.tool}</span>
        {req.principal?.kind === 'subagent' && (
          <span className="approval-agent" title={`Requested by subagent ${req.principal.name ?? req.principal.id}`}>
            <I name="account_tree" size={13} /> {req.principal.name ?? 'Subagent'}
          </span>
        )}
        <span className="approval-summary">{req.summary}</span>
        {extra > 0 && <span className="approval-more">+{extra} more</span>}
      </div>
      {preview && <pre className="approval-args">{preview}</pre>}
      <div className="approval-actions">
        <div className="approval-scopes" role="radiogroup" aria-label="Approval scope">
          {SCOPES.map((s) => (
            <button
              key={s.key}
              className={`approval-scope ${scope === s.key ? 'on' : ''}`}
              onClick={() => setScope(s.key)}
              title={s.hint}
              role="radio"
              aria-checked={scope === s.key}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="approval-buttons">
          <button className="btn" onClick={() => decide('deny')}>
            Deny
          </button>
          <button className="btn primary approve" onClick={() => decide('allow')}>
            <I name="check" size={16} />
            Approve
          </button>
        </div>
      </div>
    </div>
  )
}
