/** The short status a tool result carries ("exit 2", "running in background", "wait expired"), if any.
 *  A small, dependency-free cousin of the renderer's toolDetailView so the main process can label a
 *  step for a remote client without pulling in the detail renderer. */
export function toolDetailStatus(tool: string, result: unknown): string | undefined {
  const r = result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : undefined
  if (!r) return undefined
  if (tool === 'shell' && !r.jobId && (typeof r.stdout === 'string' || typeof r.exitCode === 'number')) {
    let s = typeof r.exitCode === 'number' ? `exit ${r.exitCode}` : ''
    if (r.timedOut) s = `${s} · timed out`.trim()
    if (r.canceled) s = `${s} · canceled`.trim()
    return s || undefined
  }
  if ((tool === 'shell' || tool === 'start_job') && typeof r.jobId === 'string') return r.autoBackgrounded ? 'moved to background' : 'running in background'
  if ((tool === 'job_status' || tool === 'agent_result' || tool === 'peek_agents') && r.timedOut) return 'wait expired'
  return undefined
}
