import { afterEach, describe, expect, it, vi } from 'vitest'

// The platform-shell module branches on process.platform at import time, so the Windows arm is
// exercised by stubbing the platform and re-importing a fresh module instance.

const realPlatform = process.platform

async function loadOn(platform: NodeJS.Platform): Promise<typeof import('./shell')> {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  vi.resetModules()
  return await import('./shell')
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  vi.resetModules()
})

describe('platform shell — POSIX', () => {
  it('spawns the login shell interactively and one-shot with -lc', async () => {
    const shell = await loadOn('darwin')
    const interactive = shell.interactiveShell()
    expect(interactive.file).toBe(process.env.SHELL || '/bin/zsh')
    expect(interactive.args).toEqual(['-il'])
    const once = shell.oneShotShell('echo hi')
    expect(once.args).toEqual(['-lc', 'echo hi'])
  })

  it('produces the framed sentinel with exit code and cwd, single-quote safe', async () => {
    const shell = await loadOn('darwin')
    const cmd = shell.sentinelCommand('_LAT_x_')
    expect(cmd).toContain(`printf '%s%d\\t%s\\n' '_LAT_x_' "$?" "$PWD"`)
  })

  it('builds a cd prefix that survives quotes in the path', async () => {
    const shell = await loadOn('darwin')
    const cmd = shell.cdPrefix("/tmp/it's here", 'ls')
    expect(cmd).toContain("cd -- '/tmp/it'\\''s here'")
    expect(cmd).toContain('ls')
  })

  it('init lines suppress the prompt and echo', async () => {
    const shell = await loadOn('darwin')
    const lines = shell.shellInitLines()
    expect(lines.some((l) => l.includes("PS1=''"))).toBe(true)
    expect(lines.some((l) => l.includes('stty -echo'))).toBe(true)
  })
})

describe('platform shell — Windows', () => {
  it('uses PowerShell for interactive and one-shot invocations', async () => {
    const shell = await loadOn('win32')
    expect(shell.interactiveShell()).toEqual({ file: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] })
    const once = shell.oneShotShell('Get-ChildItem')
    expect(once.file).toBe('powershell.exe')
    expect(once.args).toContain('-Command')
    expect(once.args).toContain('Get-ChildItem')
  })

  it('prefers pwsh when COMSPEC points at PowerShell Core', async () => {
    const prev = process.env.COMSPEC
    process.env.COMSPEC = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
    try {
      const shell = await loadOn('win32')
      expect(shell.interactiveShell().file).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    } finally {
      if (prev === undefined) delete process.env.COMSPEC
      else process.env.COMSPEC = prev
    }
  })

  it('emits a sentinel carrying the marker, an exit code expression, and the cwd', async () => {
    const shell = await loadOn('win32')
    const cmd = shell.sentinelCommand('_LAT_x_')
    expect(cmd).toContain('_LAT_x_')
    expect(cmd).toContain('$LASTEXITCODE')
    expect(cmd).toContain('$PWD.Path')
  })

  it('cd prefix uses Set-Location with escaped quotes', async () => {
    const shell = await loadOn('win32')
    const cmd = shell.cdPrefix('C:\\Users\\dylan\\my "dir"', 'dir')
    expect(cmd).toContain('Set-Location -LiteralPath')
    expect(cmd).toContain('`"')
  })
})
