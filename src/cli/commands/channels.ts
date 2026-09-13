/**
 * `lattice channels …` — set up and run the text gateway (Telegram, iMessage, phone calls).
 *
 * Setup commands only touch `<dataDir>/channels/`; they never need the Lattice runtime. `serve`
 * runs the gateway in the foreground; `install-agent` keeps it running under launchd.
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ParsedCliArgs } from '../args'
import { TelegramAdapter } from '../channels/adapters/telegram'
import { installPhotonSdk, photonSdkInstalled, PhotonAdapter } from '../channels/adapters/photon'
import {
  channelsPaths,
  issuePairingCode,
  loadConfig,
  StateStore,
  updateConfig,
  type ChannelsConfig
} from '../channels/config'
import { Gateway, queryGateway } from '../channels/gateway'
import { agentPlistPath, installAgent, uninstallAgent } from '../channels/launchd'
import { encodeQr, renderQrForTerminal } from '../channels/qr'
import { DEFAULT_LOCAL_WHISPER_MODEL, describeTranscription, findWhisperPython, transcribeLocally } from '../channels/transcribe'
import { findCloudflared } from '../channels/tunnel'
import { CHANNEL_LABELS, type ChannelId } from '../channels/types'

export interface ChannelsCommandContext {
  flags: ParsedCliArgs
  dataDir: string
  remote?: string
  password?: string
  token?: string
  stdout?: (text: string) => void
  /** Overrides for tests: whether stdin/stdout are an interactive terminal, and the platform. */
  interactive?: boolean
  platform?: NodeJS.Platform
}

const CHANNELS_HELP = `Text your Lattice assistant from your phone.

Usage:
  lattice channels status                     Configured channels, owners, and the live gateway
  lattice channels serve                      Run the gateway in the foreground
  lattice channels install-agent              Keep the gateway running (macOS launchd)
  lattice channels uninstall-agent

  lattice channels setup telegram             Prompts for the @BotFather token (hidden), starts the gateway, pairs your phone
      [--token T | --token-stdin | --from-clipboard] [--no-agent] [--no-wait] [--no-transcription]
  lattice channels setup imessage --from-hermes | --project-id <id> --secret <secret>
  lattice channels setup voice [--caller +1555…] [--vapi-key K --vapi-assistant ID] [--port 8974] [--no-tunnel]
  lattice channels setup transcription --local [--model small] [--python PATH] [--language en]
  lattice channels setup transcription --groq <KEY> | --base-url <url> --model <m> [--api-key K]
  lattice channels setup assistant [--name NAME] [--model ID] [--preset workspace] [--root DIR] [--persona TEXT|@FILE] [--timezone ZONE]

  lattice channels pair [--wait]              New 6-digit code (and QR) to link a phone/app
  lattice channels owners [rm <channel:id>]   Paired handles
  lattice channels notify <text…> [--file PATH]…   Text the owner, with attachments (scripts, the agent's shell)
  lattice channels disable|enable <telegram|imessage|voice>

Secrets can come from the environment instead of flags: TELEGRAM_BOT_TOKEN, PHOTON_PROJECT_ID,
PHOTON_PROJECT_SECRET, VAPI_API_KEY, GROQ_API_KEY.`

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function options(args: string[], name: string): string[] {
  const values: string[] = []
  args.forEach((arg, index) => {
    if (arg === name && args[index + 1]) values.push(args[index + 1]!)
  })
  return values
}

const BOOLEAN_FLAGS = new Set(['--no-tunnel', '--from-hermes', '--skip-install', '--no-verify', '--token-stdin', '--from-clipboard', '--no-agent', '--no-wait', '--wait', '--no-transcription', '--local', '--no-qr'])

function positional(args: string[]): string[] {
  const out: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg.startsWith('--')) {
      if (!BOOLEAN_FLAGS.has(arg)) index += 1
      continue
    }
    out.push(arg)
  }
  return out
}

/**
 * Issue a pairing code through the running gateway when there is one (it owns state.json while it
 * runs), else write it directly.
 */
async function newPairingCode(dataDir: string): Promise<{ code: string; expiresAt: number }> {
  const reply = await queryGateway(channelsPaths(dataDir).socket, { op: 'pair' }, 2_000).catch(() => undefined)
  const pairing = reply?.ok ? (reply.pairing as { code: string; expiresAt: number } | undefined) : undefined
  return pairing ?? issuePairingCode(StateStore.forDataDir(dataDir))
}

function mask(secret: string | undefined): string {
  if (!secret) return '(not set)'
  return secret.length <= 8 ? '********' : `${secret.slice(0, 4)}…${secret.slice(-4)}`
}

/** KEY=value lines from a dotenv file (Hermes keeps Photon credentials in ~/.hermes/.env). */
export function readDotenv(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (!match) continue
    out[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

function parseDuration(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const match = /^(\d+)(ms|s|m)?$/.exec(value.trim())
  if (!match) throw new Error(`invalid duration: ${value} (use 45s, 2m, or milliseconds)`)
  const amount = Number(match[1])
  return match[2] === 'm' ? amount * 60_000 : match[2] === 's' ? amount * 1_000 : amount
}

export async function runChannelsCommand(ctx: ChannelsCommandContext): Promise<number> {
  const out = ctx.stdout ?? ((text: string) => process.stdout.write(`${text}\n`))
  const args = ctx.flags.commandArgs
  const action = args[0] ?? 'status'
  const rest = args.slice(1)
  const { dataDir } = ctx
  const paths = channelsPaths(dataDir)
  const store = StateStore.forDataDir(dataDir)

  if (action === 'help' || ctx.flags.help) {
    out(CHANNELS_HELP)
    return 0
  }

  if (action === 'serve') {
    const log = (message: string): void => {
      process.stdout.write(`[channels] ${new Date().toISOString()} ${message}\n`)
    }
    const supervised = process.env.LATTICE_CHANNELS_SUPERVISED === '1'
    // A stray rejection in one adapter must not take every channel down with it.
    process.on('unhandledRejection', (reason) => log(`unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`))
    let stopNow: () => void = () => undefined
    const gateway = new Gateway({
      dataDir,
      remote: ctx.remote,
      password: ctx.password,
      token: ctx.token,
      embedded: ctx.flags.embedded,
      supervised,
      log,
      onConfigChange: supervised
        ? () => {
            log('restarting to apply the new configuration')
            stopNow()
          }
        : () => log('restart `lattice channels serve` to apply the new configuration')
    })
    await gateway.start()
    log(`gateway running (pid ${process.pid})${supervised ? ' under launchd' : ''}; data ${paths.dir}`)
    await new Promise<void>((resolveStop) => {
      const done = (): void => {
        process.off('SIGINT', done)
        process.off('SIGTERM', done)
        resolveStop()
      }
      stopNow = done
      process.on('SIGINT', done)
      process.on('SIGTERM', done)
    })
    log('stopping…')
    await gateway.stop()
    return 0
  }

  if (action === 'status') {
    const config = loadConfig(dataDir)
    const state = store.read()
    const live = await queryGateway(paths.socket, { op: 'status' }, 2_000).catch(() => undefined)
    const report = {
      dataDir: paths.dir,
      gateway: live?.ok ? live.status : 'not running',
      agent: existsSync(agentPlistPath()) ? agentPlistPath() : 'not installed',
      assistant: { name: config.assistant.ownerName, model: config.assistant.model ?? '(runtime default)', preset: config.assistant.preset, root: config.assistant.workspaceRoot, threadId: state.threadId },
      telegram: config.telegram ? { enabled: config.telegram.enabled, token: mask(config.telegram.botToken) } : 'not set up',
      imessage: config.imessage ? { enabled: config.imessage.enabled, provider: config.imessage.provider, projectId: config.imessage.projectId, sdk: photonSdkInstalled(paths.photonSdk) ? 'installed' : 'missing' } : 'not set up',
      voice: config.voice ? { enabled: config.voice.enabled, port: config.voice.port, callers: config.voice.allowedCallers, quickTunnel: config.voice.quickTunnel, vapi: config.voice.vapiAssistantId ?? 'not linked' } : 'not set up',
      transcription: describeTranscription(config.transcription),
      owners: state.owners.map((owner) => `${owner.channel}:${owner.senderId}${owner.name ? ` (${owner.name})` : ''}`)
    }
    if (ctx.flags.outputFormat === 'json') out(JSON.stringify(report))
    else out(JSON.stringify(report, null, 2))
    return 0
  }

  if (action === 'setup') {
    const target = rest[0]
    const setupArgs = rest.slice(1)
    if (target === 'telegram') return setupTelegram(ctx, setupArgs, out)
    if (target === 'imessage') return setupIMessage(ctx, setupArgs, out)
    if (target === 'voice') return setupVoice(ctx, setupArgs, out)
    if (target === 'transcription') return setupTranscription(ctx, setupArgs, out)
    if (target === 'assistant') return setupAssistant(ctx, setupArgs, out)
    out(CHANNELS_HELP)
    return 2
  }

  if (action === 'pair') {
    const config = loadConfig(dataDir)
    const before = store.read().owners.length
    const { code, expiresAt } = await newPairingCode(dataDir)
    out(`Pairing code: ${code} (valid 15 minutes; the gateway must be running).`)
    if (config.telegram?.enabled) {
      const me = await new TelegramAdapter({ botToken: config.telegram.botToken, apiBase: config.telegram.apiBase, mediaDir: paths.media, log: () => undefined, loadOffset: () => undefined, saveOffset: () => undefined })
        .getMe()
        .catch(() => undefined)
      if (me?.username) printTelegramPairing(ctx, out, me.username, code, rest)
    }
    if (config.imessage?.enabled) out(`iMessage: text "/pair ${code}" to your Photon iMessage line.`)
    if (rest.includes('--wait')) return waitForPairing(ctx, out, before, expiresAt)
    return 0
  }

  if (action === 'owners') {
    if (rest[0] === 'rm') {
      const target = rest[1]
      if (!target || !target.includes(':')) throw new Error('usage: lattice channels owners rm <channel:senderId>')
      const [channel, ...idParts] = target.split(':')
      const senderId = idParts.join(':')
      const live = await queryGateway(paths.socket, { op: 'owners-rm', channel, senderId }, 2_000).catch(() => undefined)
      let removed: boolean
      if (live?.ok) removed = live.removed === true
      else {
        const before = store.read().owners.length
        removed = store.update((state) => {
          state.owners = state.owners.filter((owner) => !(owner.channel === channel && owner.senderId === senderId))
        }).owners.length !== before
      }
      out(removed ? `removed ${target}` : `no owner ${target}`)
      return 0
    }
    const owners = store.read().owners
    out(owners.length ? owners.map((owner) => `${owner.channel}:${owner.senderId}${owner.name ? `  ${owner.name}` : ''}  paired ${new Date(owner.pairedAt).toLocaleString()}`).join('\n') : 'No paired owners yet. Run `lattice channels pair`.')
    return 0
  }

  if (action === 'notify') {
    const text = positional(rest).join(' ').trim()
    const files = options(rest, '--file').map((file) => resolve(file))
    if (!text && files.length === 0) throw new Error('usage: lattice channels notify <text…> [--file PATH]…')
    const missing = files.find((file) => !existsSync(file))
    if (missing) throw new Error(`no such file: ${missing}`)
    const reply = await queryGateway(paths.socket, { op: 'notify', text, files }, 120_000).catch((error: Error) => ({ ok: false, error: `gateway not running (${error.message})` }))
    if (!reply.ok) {
      out(`notify failed: ${String(reply.error)}`)
      return 1
    }
    out('sent')
    return 0
  }

  if (action === 'enable' || action === 'disable') {
    const channel = rest[0] as ChannelId | undefined
    if (!channel || !(channel in CHANNEL_LABELS)) throw new Error(`usage: lattice channels ${action} <telegram|imessage|voice>`)
    const enabled = action === 'enable'
    const config = updateConfig(dataDir, (current) => {
      const section = current[channel]
      if (!section) throw new Error(`${channel} is not set up yet: run lattice channels setup ${channel}`)
      section.enabled = enabled
    })
    out(`${CHANNEL_LABELS[channel]} ${enabled ? 'enabled' : 'disabled'} (${config[channel] ? 'saved' : 'unchanged'}). The gateway agent applies this within about 30 seconds; a foreground \`serve\` needs a restart.`)
    return 0
  }

  if (action === 'install-agent') {
    const cli = realpathSync(resolve(process.argv[1] ?? ''))
    const plist = installAgent({ node: process.execPath, cli, dataDir, logPath: paths.log })
    out(`Installed and started ${plist}\nLogs: ${paths.log}\nStop with: lattice channels uninstall-agent`)
    return 0
  }

  if (action === 'uninstall-agent') {
    out(uninstallAgent() ? 'Removed the gateway LaunchAgent.' : 'No gateway LaunchAgent was installed.')
    return 0
  }

  out(CHANNELS_HELP)
  return 2
}

/**
 * A bot token as the owner is likely to paste it: bare, with BotFather's "bot" prefix, or inside a
 * Bot API URL. Returns undefined when nothing token-shaped is there.
 */
export function parseBotToken(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const match = /(?:^|[^\w])(?:bot)?(\d{5,}:[A-Za-z0-9_-]{30,})(?![A-Za-z0-9_-])/.exec(raw.trim())
  return match?.[1]
}

function execText(file: string, args: string[]): Promise<string> {
  return new Promise((resolveText, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout: 5_000 }, (error, stdout) => (error ? reject(error) : resolveText(String(stdout))))
  })
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** Read a line without echoing it, so a token never lands in scrollback or shell history. */
function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin
  process.stdout.write(question)
  stdin.setRawMode?.(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  return new Promise((resolveLine, reject) => {
    let value = ''
    const finish = (error?: Error): void => {
      stdin.off('data', onData)
      stdin.setRawMode?.(false)
      stdin.pause()
      process.stdout.write('\n')
      if (error) reject(error)
      else resolveLine(value)
    }
    const onData = (chunk: string): void => {
      // Terminals that bracket pastes wrap them in ESC[200~ … ESC[201~.
      for (const char of chunk.replace(/\u001b\[20[01]~/g, '')) {
        if (char === '\r' || char === '\n') return finish()
        if (char === '\u0003') return finish(new Error('cancelled'))
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
        else if (char >= ' ') value += char
      }
    }
    stdin.on('data', onData)
  })
}

async function resolveTelegramToken(ctx: ChannelsCommandContext, args: string[], out: (text: string) => void): Promise<string | undefined> {
  const flag = option(args, '--token')
  if (flag) return flag
  if (args.includes('--token-stdin')) return (await readAllStdin()).trim()
  if (args.includes('--from-clipboard')) {
    const clipboard = await execText('pbpaste', []).catch(() => '')
    const token = parseBotToken(clipboard)
    if (!token) throw new Error('the clipboard does not hold a bot token (copy it from @BotFather first)')
    out(`Using the bot token from the clipboard (${mask(token)}).`)
    return token
  }
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN
  if (!(ctx.interactive ?? (process.stdin.isTTY && process.stdout.isTTY))) return undefined
  out(BOTFATHER_STEPS)
  const typed = await promptHidden('Paste the bot token (hidden): ')
  return typed.trim()
}

const BOTFATHER_STEPS = [
  'Create the bot (about a minute, in the Telegram app):',
  '  1. Open https://t.me/BotFather and send /newbot',
  '  2. Give it a name (anything) and a username ending in "bot"',
  '  3. BotFather replies with a token like 123456789:AA… — tap it to copy',
  ''
].join('\n')

interface LiveGateway {
  pid?: number
  supervised?: boolean
}

async function liveGateway(socket: string, timeoutMs = 1_500): Promise<LiveGateway | undefined> {
  const reply = await queryGateway(socket, { op: 'status' }, timeoutMs).catch(() => undefined)
  return reply?.ok ? (reply.status as LiveGateway) : undefined
}

/** Snapshot of the gateway before a config write, so the restart that follows can be recognized. */
function gatewayBefore(ctx: ChannelsCommandContext): Promise<LiveGateway | undefined> {
  return liveGateway(channelsPaths(ctx.dataDir).socket, 2_000)
}

/**
 * Start or refresh the gateway so it runs with the config just saved, and wait until the process
 * that will serve it answers. Pairing codes are issued only after that: a gateway that is still
 * booting would otherwise rewrite state.json from its own earlier read and drop the new code.
 */
async function ensureGatewayRunning(ctx: ChannelsCommandContext, args: string[], before: LiveGateway | undefined, configChanged: boolean, out: (text: string) => void, waitMs = 45_000): Promise<void> {
  const paths = channelsPaths(ctx.dataDir)
  if (before && !before.supervised) {
    out(`A foreground gateway is running (pid ${before.pid}); restart \`lattice channels serve\` to pick this up.`)
    return
  }
  const platform = ctx.platform ?? process.platform
  if (args.includes('--no-agent') || platform !== 'darwin') {
    out(before ? 'The gateway picks this up when it restarts.' : 'Start the gateway: lattice channels serve   (it must be running to pair)')
    return
  }
  if (before && existsSync(agentPlistPath())) {
    if (!configChanged) {
      out('The gateway agent is already running with these settings.')
      return
    }
    // It notices config.json within a few seconds, exits, and launchd starts it again.
    out('Restarting the gateway agent with the new settings…')
  } else {
    const cli = realpathSync(resolve(process.argv[1] ?? ''))
    installAgent({ node: process.execPath, cli, dataDir: ctx.dataDir, logPath: paths.log })
    out(`Started the gateway as a login agent (${agentPlistPath()}); logs: ${paths.log}`)
  }
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    const now = await liveGateway(paths.socket)
    if (now && (!before || now.pid !== before.pid)) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  }
  out(`The gateway has not answered yet; check ${paths.log}. Pairing still works once it is up.`)
}

function printTelegramPairing(ctx: ChannelsCommandContext, out: (text: string) => void, username: string, code: string, args: string[]): void {
  const link = `https://t.me/${username}?start=${code}`
  out('')
  if (!args.includes('--no-qr') && (ctx.interactive ?? process.stdout.isTTY)) {
    out('Scan with your phone camera, then tap Start in Telegram:')
    out(renderQrForTerminal(encodeQr(link)))
  }
  out(`Pair your Telegram (code valid 15 minutes): open ${link}`)
  out(`  or send /pair ${code} to @${username}`)
}

/** Block until a new owner pairs (or the code expires), watching the state the gateway writes. */
async function waitForPairing(ctx: ChannelsCommandContext, out: (text: string) => void, ownersBefore: number, expiresAt: number, pollMs = 1_000): Promise<number> {
  const store = StateStore.forDataDir(ctx.dataDir)
  const paths = channelsPaths(ctx.dataDir)
  out('\nWaiting for you to tap Start… (Ctrl-C to stop waiting; pairing still works while the code is valid)')
  let announcedGateway = false
  while (Date.now() < expiresAt) {
    const owners = store.read().owners
    if (owners.length > ownersBefore) {
      const owner = owners[owners.length - 1]!
      out(`\nPaired ${CHANNEL_LABELS[owner.channel]}${owner.name ? ` (${owner.name})` : ''}. Text your assistant now; it answers from Lattice.`)
      return 0
    }
    if (!announcedGateway) {
      const live = await queryGateway(paths.socket, { op: 'status' }, 1_500).catch(() => undefined)
      const telegram = live?.ok ? (live.status as { channels?: { telegram?: { connected?: boolean; identity?: string } }; runtime?: string }) : undefined
      if (telegram?.channels?.telegram?.connected) {
        out(`Gateway is up: Telegram ${telegram.channels.telegram.identity ?? ''} connected, Lattice ${telegram.runtime ?? 'unknown'}.`)
        announcedGateway = true
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, pollMs))
  }
  out('The pairing code expired. Get a new one with: lattice channels pair --wait')
  return 1
}

async function setupTelegram(ctx: ChannelsCommandContext, args: string[], out: (text: string) => void): Promise<number> {
  const paths = channelsPaths(ctx.dataDir)
  const raw = await resolveTelegramToken(ctx, args, out)
  if (!raw) {
    out(`${BOTFATHER_STEPS}\nThen run this in a terminal and paste the token when asked:\n  lattice channels setup telegram\nor, with the token on the clipboard: lattice channels setup telegram --from-clipboard`)
    return 2
  }
  const token = parseBotToken(raw)
  if (!token) throw new Error('that does not look like a bot token (expected digits, a colon, then about 35 letters, as @BotFather prints it)')
  const apiBase = option(args, '--api-base')
  const adapter = new TelegramAdapter({ botToken: token, apiBase, mediaDir: paths.media, log: () => undefined, loadOffset: () => undefined, saveOffset: () => undefined })
  const me = await adapter.getMe().catch((error: Error) => {
    throw new Error(`Telegram rejected that token: ${error.message}`)
  })
  if (!me.username) throw new Error('Telegram returned a bot without a username')
  const before = StateStore.forDataDir(ctx.dataDir).read().owners.length
  const gateway = await gatewayBefore(ctx)
  const configBefore = JSON.stringify(loadConfig(ctx.dataDir))

  let transcriptionNote = ''
  const existing = loadConfig(ctx.dataDir)
  let localWhisper: string | undefined
  if (!existing.transcription && !args.includes('--no-transcription')) {
    localWhisper = await findWhisperPython()
    transcriptionNote = localWhisper
      ? `Voice notes: transcribed on this machine with faster-whisper ${DEFAULT_LOCAL_WHISPER_MODEL} (${localWhisper}).`
      : 'Voice notes: off (no local faster-whisper found). See `lattice channels setup transcription`.'
  }
  updateConfig(ctx.dataDir, (config) => {
    config.telegram = { enabled: true, botToken: token, ...(apiBase ? { apiBase } : {}) }
    if (localWhisper && !config.transcription) config.transcription = { provider: 'local', python: localWhisper, model: DEFAULT_LOCAL_WHISPER_MODEL }
  })
  out(`Telegram bot @${me.username} is set up (token ${mask(token)} saved to ${paths.config}, mode 0600).`)
  if (transcriptionNote) out(transcriptionNote)

  const changed = await adapter.configureProfile().catch((error: Error) => {
    out(`(could not set the bot's command menu: ${error.message}; the gateway retries on start)`)
    return undefined
  })
  if (changed?.length) out(`Set the bot's ${changed.join(', ')}.`)

  await ensureGatewayRunning(ctx, args, gateway, JSON.stringify(loadConfig(ctx.dataDir)) !== configBefore, out)
  const { code, expiresAt } = await newPairingCode(ctx.dataDir)
  printTelegramPairing(ctx, out, me.username, code, args)
  const wait = args.includes('--wait') || (!args.includes('--no-wait') && (ctx.interactive ?? (process.stdin.isTTY && process.stdout.isTTY)))
  if (wait) return waitForPairing(ctx, out, before, expiresAt)
  out('\nCheck it with: lattice channels status')
  return 0
}

async function setupIMessage(ctx: ChannelsCommandContext, args: string[], out: (text: string) => void): Promise<number> {
  const paths = channelsPaths(ctx.dataDir)
  let projectId = option(args, '--project-id') ?? process.env.PHOTON_PROJECT_ID
  let projectSecret = option(args, '--secret') ?? process.env.PHOTON_PROJECT_SECRET
  if (args.includes('--from-hermes')) {
    const env = readDotenv(join(process.env.HERMES_HOME ?? join(homedir(), '.hermes'), '.env'))
    projectId = env.PHOTON_PROJECT_ID ?? projectId
    projectSecret = env.PHOTON_PROJECT_SECRET ?? projectSecret
    if (!projectId || !projectSecret) throw new Error('~/.hermes/.env has no PHOTON_PROJECT_ID / PHOTON_PROJECT_SECRET. Run `hermes photon setup --phone +1…` first.')
  }
  if (!projectId || !projectSecret) {
    out([
      'iMessage runs through Photon (free tier: shared iMessage line, up to 10 users).',
      '',
      'Get credentials one of two ways:',
      '  1. Fastest: `hermes photon setup --phone +1XXXXXXXXXX --project-name "Lattice Assistant" --skip-sidecar-install`',
      '     (device login in the browser, registers your number, prints the iMessage line to text), then',
      '     `lattice channels setup imessage --from-hermes`.',
      '  2. Dashboard: sign up at https://app.photon.codes, create a project, add your phone number as a user,',
      '     copy the project id and secret, then:',
      '     lattice channels setup imessage --project-id <id> --secret <secret>'
    ].join('\n'))
    return 2
  }
  if (!args.includes('--skip-install') && !photonSdkInstalled(paths.photonSdk)) {
    await installPhotonSdk(paths.photonSdk, out)
  }
  if (!args.includes('--no-verify')) {
    out('verifying Photon credentials…')
    const probe = new PhotonAdapter({ projectId, projectSecret, sdkDir: paths.photonSdk, mediaDir: paths.media, log: () => undefined })
    const verified = await Promise.race([
      probe.start(() => undefined).then(() => true),
      new Promise<boolean>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 20_000))
    ]).catch((error: Error) => {
      throw new Error(`Photon rejected the credentials: ${error.message}`)
    })
    await probe.stop()
    out(verified ? 'Photon connection OK.' : 'Photon did not answer within 20s; saving anyway (check `lattice channels status` once the gateway runs).')
  }
  updateConfig(ctx.dataDir, (config) => {
    config.imessage = { enabled: true, provider: 'photon', projectId: projectId!, projectSecret: projectSecret! }
  })
  const { code } = await newPairingCode(ctx.dataDir)
  out([
    'iMessage is set up.',
    '',
    `Pair (valid 15 minutes, with the gateway running): from your iPhone, text "/pair ${code}" to the iMessage line Photon assigned you.`,
    'Run the gateway: lattice channels serve   (or: lattice channels install-agent)'
  ].join('\n'))
  return 0
}

async function setupVoice(ctx: ChannelsCommandContext, args: string[], out: (text: string) => void): Promise<number> {
  const existing = loadConfig(ctx.dataDir).voice
  const secret = existing?.secret || randomBytes(24).toString('base64url')
  const callers = options(args, '--caller')
  const voice: NonNullable<ChannelsConfig['voice']> = {
    enabled: true,
    port: ctx.flags.port ?? existing?.port ?? 8974,
    bind: ctx.flags.bind ?? existing?.bind ?? '127.0.0.1',
    secret,
    allowedCallers: callers.length ? callers : existing?.allowedCallers ?? [],
    maxWaitMs: parseDuration(option(args, '--max-wait'), existing?.maxWaitMs ?? 25_000),
    quickTunnel: args.includes('--no-tunnel') ? false : existing?.quickTunnel ?? true,
    vapiApiKey: option(args, '--vapi-key') ?? process.env.VAPI_API_KEY ?? existing?.vapiApiKey,
    vapiAssistantId: option(args, '--vapi-assistant') ?? existing?.vapiAssistantId
  }
  updateConfig(ctx.dataDir, (config) => {
    config.voice = voice
  })
  const tunnel = voice.quickTunnel ? (findCloudflared() ? 'a free Cloudflare quick tunnel (URL printed in the gateway log)' : 'a quick tunnel, but cloudflared is missing: brew install cloudflared') : `your own tunnel to http://127.0.0.1:${voice.port}`
  out([
    `Phone endpoint: http://${voice.bind}:${voice.port}/chat/completions, published through ${tunnel}.`,
    voice.allowedCallers.length ? `Only these callers get through: ${voice.allowedCallers.join(', ')}` : 'Warning: no --caller set, so anyone who reaches the endpoint with the secret gets through. Add --caller +1XXXXXXXXXX.',
    '',
    'Vapi (free US number, $10 starting credit):',
    '  1. Sign up at https://dashboard.vapi.ai, then Phone Numbers → Create → Free Vapi Number (pick an area code).',
    '  2. Provider Credentials → Custom LLM → paste this key:',
    `       ${secret}`,
    '  3. Assistants → Create (blank) → Model: provider "Custom LLM", model "lattice-assistant",',
    '     URL = the tunnel URL from the gateway log. Assign the assistant to the phone number.',
    '  4. Let the gateway keep the URL current when the tunnel restarts:',
    '       lattice channels setup voice --vapi-key <Vapi private key> --vapi-assistant <assistant id>',
    '',
    'The gateway agent applies this within about 30 seconds; a foreground `serve` needs a restart.'
  ].join('\n'))
  return 0
}

async function setupTranscription(ctx: ChannelsCommandContext, args: string[], out: (text: string) => void): Promise<number> {
  if (args.includes('--local')) {
    const python = option(args, '--python') ?? (await findWhisperPython())
    if (!python) {
      out('No Python with faster-whisper found. Install it with `python3 -m pip install faster-whisper`, or pass --python /path/to/python.')
      return 2
    }
    const local = { provider: 'local' as const, python, model: ctx.flags.model ?? DEFAULT_LOCAL_WHISPER_MODEL, ...(option(args, '--language') ? { language: option(args, '--language') } : {}) }
    if (!args.includes('--no-verify') && (ctx.platform ?? process.platform) === 'darwin') {
      // Speak a sentence with macOS `say` and transcribe it: proves the model loads (downloading it on
      // first use) before the owner's first real voice note does.
      const dir = mkdtempSync(join(tmpdir(), 'lattice-whisper-'))
      try {
        const sample = join(dir, 'sample.aiff')
        await execText('say', ['-o', sample, 'Lattice voice notes are ready.'])
        out(`checking faster-whisper ${local.model} with ${python}…`)
        const started = Date.now()
        const result = await transcribeLocally(local, sample)
        out(`heard: "${result.text}" (${((Date.now() - started) / 1000).toFixed(1)}s)`)
      } catch (error) {
        out(`faster-whisper failed: ${(error as Error).message}`)
        return 1
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
    updateConfig(ctx.dataDir, (config) => {
      config.transcription = local
    })
    out(`Voice notes will be transcribed on this machine with faster-whisper ${local.model}. The gateway agent applies this within about 30 seconds; a foreground \`serve\` needs a restart.`)
    return 0
  }
  const groq = option(args, '--groq') ?? (args.includes('--groq') ? process.env.GROQ_API_KEY : undefined)
  const transcription = groq
    ? { provider: 'openai' as const, baseUrl: 'https://api.groq.com/openai/v1', apiKey: groq, model: 'whisper-large-v3-turbo' }
    : { provider: 'openai' as const, baseUrl: option(args, '--base-url') ?? '', apiKey: option(args, '--api-key'), model: ctx.flags.model ?? 'whisper-1' }
  if (!transcription.baseUrl) {
    out('usage: lattice channels setup transcription --local [--model small]   (free, on this machine)\n   or: lattice channels setup transcription --groq <GROQ_API_KEY>   (free tier)\n   or: lattice channels setup transcription --base-url <openai-compatible url> --model <model> [--api-key K]')
    return 2
  }
  updateConfig(ctx.dataDir, (config) => {
    config.transcription = transcription
  })
  out(`Voice notes will be transcribed with ${transcription.model} at ${transcription.baseUrl}. The gateway agent applies this within about 30 seconds; a foreground \`serve\` needs a restart.`)
  return 0
}

async function setupAssistant(ctx: ChannelsCommandContext, args: string[], out: (text: string) => void): Promise<number> {
  const personaArg = option(args, '--persona')
  const persona = personaArg?.startsWith('@') ? readFileSync(resolve(personaArg.slice(1)), 'utf8') : personaArg
  const config = updateConfig(ctx.dataDir, (current) => {
    const assistant = current.assistant
    const name = option(args, '--name')
    if (name) assistant.ownerName = name
    if (ctx.flags.model) assistant.model = ctx.flags.model
    if (ctx.flags.effort) assistant.effort = ctx.flags.effort
    if (ctx.flags.preset) assistant.preset = ctx.flags.preset
    const root = option(args, '--root')
    if (root) assistant.workspaceRoot = resolve(root)
    if (persona !== undefined) assistant.persona = persona
    const zone = option(args, '--timezone')
    if (zone) assistant.timeZone = zone
    const progress = option(args, '--progress')
    if (progress) assistant.progressNoticeMs = parseDuration(progress, assistant.progressNoticeMs)
    const busy = option(args, '--busy')
    if (busy === 'steer' || busy === 'queue') assistant.busyDisposition = busy
  })
  out(JSON.stringify({ ...config.assistant, persona: config.assistant.persona ? `${config.assistant.persona.slice(0, 80)}…` : undefined }, null, 2))
  out('Saved. The running gateway picks up instruction changes on its next restart.')
  return 0
}
