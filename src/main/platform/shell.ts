/**
 * Platform shell selection, centralized so every place Lattice runs a command — the persistent PTY
 * tool session, the Terminal panel, detached background jobs, and the one-shot fallback — agrees
 * on what "the user's shell" means per platform.
 *
 * POSIX (macOS/Linux): the user's login shell (`$SHELL`, default zsh). `-il` gives an interactive
 * login shell so the user's profile PATH is sourced (a packaged Electron app launches with a
 * minimal launchd PATH); `-lc <cmd>` is the one-shot equivalent.
 *
 * Windows: PowerShell (`powershell.exe`, always on PATH on supported Windows; `pwsh` is preferred
 * when the user points COMSPEC-like env at it). Chosen over cmd.exe for predictable quoting, real
 * exit codes (`$LASTEXITCODE`), and a scriptable prompt. node-pty drives it through ConPTY.
 *
 * NOTE: the Windows arm is implemented to spec but has not yet been QA'd on a real Windows
 * machine — see the Windows-support entry in docs/ROADMAP.md for what remains.
 */

export const IS_WINDOWS = process.platform === 'win32'

export interface ShellSpec {
  file: string
  args: string[]
}

/** The interactive shell to spawn inside a PTY (tool sessions and the Terminal panel). */
export function interactiveShell(): ShellSpec {
  if (IS_WINDOWS) {
    return { file: windowsShell(), args: ['-NoLogo', '-NoProfile'] }
  }
  return { file: process.env.SHELL || '/bin/zsh', args: ['-il'] }
}

/** A one-shot "run this command and exit" invocation (background jobs, the no-PTY fallback). */
export function oneShotShell(command: string): ShellSpec {
  if (IS_WINDOWS) {
    return { file: windowsShell(), args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] }
  }
  return { file: process.env.SHELL || '/bin/zsh', args: ['-lc', command] }
}

function windowsShell(): string {
  // Respect an explicit PowerShell Core if the user runs one; otherwise Windows PowerShell, which
  // ships with every supported Windows.
  const comspec = process.env.COMSPEC ?? ''
  if (/pwsh(\.exe)?$/i.test(comspec)) return comspec
  return 'powershell.exe'
}

/**
 * The lines written into a fresh interactive PTY session to make it machine-readable: no prompt,
 * no echo/prompt decorations that would pollute captured output. POSIX lines are zsh/bash
 * compatible; the PowerShell line blanks the prompt (echo suppression has no `stty` equivalent
 * under ConPTY, so Windows output may include the echoed command line — the sentinel match is
 * unaffected because the echo never carries the digits+tab tail).
 */
export function shellInitLines(): string[] {
  if (IS_WINDOWS) {
    return [`function prompt { '' }`]
  }
  // Order matters. `unsetopt zle` resets the tty to cooked+echo, so `stty -echo`
  // must come AFTER it or echo comes back on. `promptsp`/`promptcr` off removes the
  // bold reverse-"%" partial-line marker zsh prints before an (empty) prompt.
  return [
    `PS1='' PS2='' PROMPT='' RPROMPT='' 2>/dev/null`,
    'precmd_functions=() 2>/dev/null; preexec_functions=() 2>/dev/null',
    'unsetopt zle promptcr promptsp 2>/dev/null',
    `printf '\\033[?2004l'`,
    'stty -echo 2>/dev/null'
  ]
}

/** POSIX single-quote escaping for embedding a literal inside `'…'`. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * The framed sentinel command a PTY session runs after each user command, printing
 * `<marker><exitCode>\t<cwd>` on its own line so the session driver can capture exactly one
 * command's output, its exit code, and the directory it left the shell in.
 */
export function sentinelCommand(marker: string): string {
  if (IS_WINDOWS) {
    // $LASTEXITCODE is only set after a native command; $? covers pure-PowerShell statements.
    return (
      `Write-Output ("${marker}" + $(if ($null -eq $LASTEXITCODE) { if ($?) { 0 } else { 1 } } ` +
      `else { $LASTEXITCODE }) + "\`t" + $PWD.Path)`
    )
  }
  return `printf '%s%d\\t%s\\n' ${sq(marker)} "$?" "$PWD"`
}

/** Change-directory prefix for running one command from a given directory in an existing session. */
export function cdPrefix(cwd: string, command: string): string {
  if (IS_WINDOWS) {
    return `Set-Location -LiteralPath "${cwd.replace(/"/g, '`"')}"; ${command}`
  }
  return `cd -- ${sq(cwd)} && { ${command}\n}`
}
