#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseCliArgs, resolveCliOptions, CliUsageError } from './args'
import { readCliProfile } from './config'
import { parsePermissionSpecs } from './permissionSpec'
import { bindSession } from './session'
import { runPrint } from './print'
import { runInteractive } from './ui'
import { runCommand } from './commands'
import { runChannelsCommand } from './commands/channels'
import { defaultDataDir, resolveTransport, readRuntimeInfo, connectLocalTransport, TransportError, type LatticeTransport } from './transport'
import { isPidAlive } from '../main/runtimeLock'

const CLI_VERSION = '0.1.0'
/** Set by commands that may leave third-party SDK handles open after they return. */
let exitWhenDone = false
const PROTOCOL_VERSION = 1

function help(): string {
  return `Lattice terminal client

Usage:
  lattice [prompt...]
  lattice -p "prompt" [--output-format text|json|stream-json]
  lattice <subcommand> [args]
  lattice channels <action>   Text the assistant from Telegram, iMessage, or a phone call

Global options:
  --data-dir <path>          Runtime data directory
  --profile <name>           Named CLI profile
  --remote <url|profile>     Use the authenticated remote bridge
  --embedded                 Force an in-process runtime
  -m, --model <id>           Model for the turn
  --effort <tier>            Reasoning effort
  --mode <plan|act|review>   Thread mode
  --preset <manual|workspace|full> Permission preset
  --yolo                     Alias for --preset full (requires --yes when piped)
  --allow-tool <spec>        Pre-seed an allow rule (repeatable)
  --deny-tool <spec>         Pre-seed a deny rule (repeatable)
  --add-dir <path>           Add an approved workspace root (repeatable)
  --goal <text>              Set the thread goal
  --instructions <text|@file> Standing instructions
  -i, --image <path>         Attach an image (repeatable)
  -p, --print                Run once and print the result
  --output-format <fmt>      text, json, or stream-json
  --json                     Shorthand for --output-format json
  --color <auto|always|never> Color policy
  --no-color                 Disable ANSI styling
  -q, --quiet                Suppress tool/status chatter
  --plain                    Append-only output for screen readers/logs
  --show-thinking            Stream reasoning deltas in the terminal
  --alt-screen               Use an alternate screen for dashboard views
  --no-spinner               Disable animated terminal indicators
  --bell                     Ring the terminal bell when a run completes
  --verbose                  Explain transport selection and protocol details
  --password-stdin           Read a remote password from stdin without echoing
  --force                    Skip safe exit confirmations
  --follow                   Follow a command/session event stream
  --since <seq>              Start following after an event sequence
  --port <n> --bind <host>   Configure lattice serve
  --bridge                   Enable the authenticated remote bridge in serve mode
  --continue                Continue the newest thread
  --resume [id|title]        Resume a thread
  --timeout <duration>       Print-mode wall-clock cap (for example 90s)
  --max-turns <n>            Print-mode provider-round cap
  -y, --yes                  Confirm CLI-level prompts
  -h, --help                 Show this help
`
}

async function readPipedInput(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

async function doctor(flags: ReturnType<typeof parseCliArgs>, dataDir: string): Promise<number> {
  const runtime = await readRuntimeInfo(dataDir)
  let attached = false
  if (runtime && isPidAlive(runtime.pid)) {
    try {
      const transport = await connectLocalTransport({ path: runtime.socket, timeoutMs: 300 })
      attached = true
      await transport.close()
    } catch {
      /* metadata can outlive a crashed socket; report it as stale below */
    }
  }
  const native: Record<string, string> = {}
  for (const name of ['better-sqlite3', 'node-pty', 'ws']) {
    try { await import(name); native[name] = 'ok' } catch (error) { native[name] = `unavailable: ${(error as Error).message}` }
  }
  const report = { cliVersion: CLI_VERSION, protocol: PROTOCOL_VERSION, node: process.version, platform: process.platform, dataDir, runtime, attached, native }
  if (flags.outputFormat === 'json') process.stdout.write(`${JSON.stringify(report)}\n`)
  else process.stdout.write(`lattice ${CLI_VERSION} · protocol ${PROTOCOL_VERSION}\nnode ${process.version}\ndata ${dataDir}\n${attached ? `runtime attached (pid ${runtime?.pid})` : runtime ? 'stale runtime metadata' : 'no runtime attached'}\n`)
  return 0
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  let flags: ReturnType<typeof parseCliArgs>
  try {
    flags = parseCliArgs(argv)
  } catch (error) {
    if (error instanceof CliUsageError) { console.error(error.message); return error.exitCode }
    throw error
  }
  const env = process.env
  const profileName = flags.profile ?? env.LATTICE_PROFILE
  const profile = await readCliProfile(profileName)
  const remoteProfile = flags.remote && !/^https?:\/\//i.test(flags.remote) && !flags.remote.includes(':')
    ? await readCliProfile(flags.remote)
    : undefined
  const selectedProfile = remoteProfile ? { ...profile, ...remoteProfile } : profile
  const resolved = resolveCliOptions(flags, env, { ...selectedProfile, profile: profileName })
  const remoteEndpoint = remoteProfile?.remote ?? resolved.remote
  const dataDir = resolve(resolved.dataDir || defaultDataDir())
  if (flags.help) { process.stdout.write(help()); return 0 }
  if (flags.version) {
    const runtime = await readRuntimeInfo(dataDir)
    process.stdout.write(`lattice ${CLI_VERSION} · runtime ${runtime?.version ?? CLI_VERSION} · protocol ${PROTOCOL_VERSION}\n`)
    return 0
  }
  const nonInteractive = flags.print || !process.stdin.isTTY || !process.stdout.isTTY
  if (flags.yolo && !flags.yes && nonInteractive) {
    console.error('--yolo requires --yes in non-interactive mode')
    return 2
  }
  try {
    parsePermissionSpecs(flags.allowTool, flags.denyTool)
  } catch (error) {
    console.error((error as Error).message)
    return 2
  }
  if (flags.command === 'doctor') return doctor(flags, dataDir)
  // The text gateway manages its own (reconnecting) runtime connection, and its setup commands
  // only touch <dataDir>/channels, so it never goes through the one-shot transport below.
  if (flags.command === 'channels') {
    exitWhenDone = true
    try {
      let password = env.LATTICE_PASSWORD
      if (flags.passwordStdin) password = (await readPipedInput()).trim() || password
      return await runChannelsCommand({ flags, dataDir, remote: remoteEndpoint, password, token: env.LATTICE_TOKEN })
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      return 1
    }
  }

  let transport: LatticeTransport | undefined
  try {
    if (flags.command === 'serve') {
      process.env.LATTICE_RUNTIME_MODE = 'serve'
      if (flags.port !== undefined) process.env.LATTICE_PORT = String(flags.port)
      if (flags.bind) process.env.LATTICE_BIND = flags.bind
      if (flags.noControlSocket) process.env.LATTICE_NO_CONTROL_SOCKET = '1'
      if (flags.bridge) process.env.LATTICE_SERVE_BRIDGE = '1'
    }
    let password = env.LATTICE_PASSWORD
    if (flags.passwordStdin) {
      if (process.stdin.isTTY) throw new CliUsageError('--password-stdin requires piped input.')
      password = (await readPipedInput()).trim()
      if (!password) throw new CliUsageError('--password-stdin received an empty password.')
    }
    transport = await resolveTransport({
      dataDir,
      remote: remoteEndpoint,
      embedded: flags.embedded,
      verbose: flags.verbose,
      log: (message) => console.error(message),
      token: env.LATTICE_TOKEN,
      password
    })
    const settings = await transport.api.getSettings().catch(() => null)
    const interactive = process.stdin.isTTY && process.stdout.isTTY && !flags.print
    const sessionOptions = resolveCliOptions(flags, env, {
      ...selectedProfile,
      profile: profileName,
      model: resolved.model ?? settings?.defaultModel,
      mode: resolved.mode ?? settings?.defaultMode,
      preset: resolved.preset ?? (settings?.defaultPermissionPreset === 'custom' ? undefined : settings?.defaultPermissionPreset),
      color: resolved.color
    })
    const mode = sessionOptions.mode ?? (interactive ? 'act' : 'plan')
    const preset = sessionOptions.preset ?? (interactive ? 'workspace' : 'manual')
    const sessionFlags = { ...flags, mode, preset } as ReturnType<typeof parseCliArgs>

    if (flags.command) {
      if (flags.command === 'serve') {
        process.stdout.write(`lattice runtime serving ${dataDir}${flags.bridge ? ' with bridge' : ''}\n`)
        await new Promise<void>((resolvePromise) => {
          const done = (): void => { process.off('SIGINT', done); process.off('SIGTERM', done); resolvePromise() }
          process.on('SIGINT', done); process.on('SIGTERM', done)
        })
        return 0
      }
      return await runCommand({ transport, flags: sessionFlags })
    }

    let prompt = flags.prompt.join(' ')
    if (!process.stdin.isTTY) {
      const piped = await readPipedInput()
      if (piped) prompt = prompt ? `${prompt}\n\n${piped}` : piped
    }
    const session = await bindSession(transport, sessionFlags, { ...resolved, mode, preset })
    if (flags.print || !process.stdin.isTTY) {
      if (!prompt.trim()) throw new CliUsageError('print mode requires a prompt or piped stdin')
      const result = await runPrint(transport, session, prompt, {
        format: flags.outputFormat ?? 'text',
        quiet: flags.quiet,
        timeoutMs: flags.timeoutMs,
        maxTurns: flags.maxTurns,
        askAnswer: flags.askAnswer,
        verbose: flags.verbose
      })
      return result.exitCode
    }
    return runInteractive(transport, session, prompt || undefined, {
      showThinking: flags.showThinking,
      plain: flags.plain,
      noSpinner: flags.noSpinner,
      bell: flags.bell,
      force: flags.force
    })
  } catch (error) {
    if (error instanceof CliUsageError) { console.error(error.message); return error.exitCode }
    if (error instanceof TransportError) { console.error(error.message); return error.exitCode }
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  } finally {
    await transport?.close().catch(() => undefined)
  }
}

// Keep imports side-effect free for parser/command tests. The published bin and the bundled file
// both have one of these paths in argv[1]; importing the module from Vitest does not start a runtime.
// Symlinks (`lattice install` links `lattice` and `lat` to bin/lattice) are followed first.
function realInvokedPath(path: string | undefined): string {
  if (!path) return ''
  try {
    return realpathSync(resolve(path))
  } catch {
    return resolve(path)
  }
}
const invokedPath = realInvokedPath(process.argv[1])
const invokedAsCli = invokedPath.endsWith('/bin/lattice') || invokedPath.endsWith('/lattice.cjs')
if (invokedAsCli) {
  void main().then((code) => {
    process.exitCode = code
    // One-shot `channels` commands can leave SDK sockets (Photon gRPC) open after they finish;
    // exit once stdout drains instead of hanging. `channels serve` returns only at shutdown.
    if (exitWhenDone) process.stdout.write('', () => process.exit(code))
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

export { main }
