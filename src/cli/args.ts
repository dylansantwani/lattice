import type { Mode, PermissionPreset } from '@shared/types'

export type CliColor = 'auto' | 'always' | 'never'
export type CliOutputFormat = 'text' | 'json' | 'stream-json'

export interface ParsedCliArgs {
  command?: string
  /** Tokens after the root subcommand, untouched for the command-specific parser. */
  commandArgs: string[]
  /** Positional tokens for the default interactive/print session. */
  prompt: string[]
  dataDir?: string
  profile?: string
  remote?: string
  embedded: boolean
  model?: string
  effort?: string
  mode?: Mode
  preset?: Exclude<PermissionPreset, 'custom'>
  yolo: boolean
  allowTool: string[]
  denyTool: string[]
  addDir: string[]
  goal?: string
  instructions?: string
  resume?: string | true
  continue?: boolean
  image: string[]
  print: boolean
  outputFormat?: CliOutputFormat
  color?: CliColor
  quiet: boolean
  verbose: boolean
  yes: boolean
  timeoutMs?: number
  maxTurns?: number
  askAnswer?: string
  plain?: boolean
  passwordStdin?: boolean
  showThinking?: boolean
  altScreen?: boolean
  noSpinner?: boolean
  bell?: boolean
  force?: boolean
  follow?: boolean
  since?: number
  port?: number
  bind?: string
  bridge?: boolean
  noControlSocket?: boolean
  help: boolean
  version: boolean
}

export interface CliEnvironment {
  LATTICE_DATA_DIR?: string
  LATTICE_REMOTE?: string
  LATTICE_PROFILE?: string
  LATTICE_MODEL?: string
  LATTICE_MODE?: string
  LATTICE_PRESET?: string
  LATTICE_COLOR?: string
  NO_COLOR?: string
  FORCE_COLOR?: string
}

export interface CliDefaults {
  dataDir?: string
  profile?: string
  remote?: string
  model?: string
  mode?: Mode
  preset?: Exclude<PermissionPreset, 'custom'>
  color?: CliColor
}

export interface ResolvedCliOptions extends CliDefaults {}

export class CliUsageError extends Error {
  readonly exitCode = 2

  constructor(message: string) {
    super(message)
    this.name = 'CliUsageError'
  }
}

export const CLI_COMMANDS = [
  'threads', 'send', 'attach', 'stop', 'retry', 'models', 'providers', 'mcp', 'memory', 'todos', 'jobs',
  'usage', 'sessions', 'message', 'inbox', 'config', 'serve', 'doctor', 'install', 'completion', 'channels'
]
const ROOT_COMMANDS = new Set(CLI_COMMANDS)

const MODES = new Set<Mode>(['plan', 'act', 'review'])
const PRESETS = new Set<Exclude<PermissionPreset, 'custom'>>(['manual', 'workspace', 'full'])
const COLORS = new Set<CliColor>(['auto', 'always', 'never'])
const OUTPUT_FORMATS = new Set<CliOutputFormat>(['text', 'json', 'stream-json'])

function value(args: readonly string[], index: number, flag: string): string {
  const next = args[index + 1]
  if (!next || next === '--') throw new CliUsageError(`${flag} requires a value.`)
  return next
}

function duration(value: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value)
  if (!match || Number(match[1]) < 1) throw new CliUsageError(`Invalid duration: ${value}. Use values like 90s or 10m.`)
  const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as 'ms' | 's' | 'm' | 'h']
  return Number(match[1]) * multiplier
}

function positiveInteger(value: string, flag: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new CliUsageError(`${flag} must be a positive integer.`)
  return Number(value)
}

function nonNegativeInteger(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) throw new CliUsageError(`${flag} must be a non-negative integer.`)
  return Number(value)
}

function enumValue<T extends string>(value: string, allowed: Set<T>, flag: string): T {
  if (!allowed.has(value as T)) throw new CliUsageError(`Invalid ${flag} value: ${value}.`)
  return value as T
}

/** Parse only global flags; command-specific tokens remain available to the command dispatcher. */
export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const parsed: ParsedCliArgs = {
    commandArgs: [], prompt: [], embedded: false, yolo: false, allowTool: [], denyTool: [], addDir: [], image: [],
    print: false, quiet: false, verbose: false, yes: false, help: false, version: false
  }
  let commandSeen = false
  let positionalOnly = false

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    if (positionalOnly) {
      ;(commandSeen ? parsed.commandArgs : parsed.prompt).push(token)
      continue
    }
    if (token === '--') {
      positionalOnly = true
      continue
    }
    const assign = (key: keyof ParsedCliArgs, flag: string): void => {
      ;(parsed as unknown as Record<string, unknown>)[key] = value(argv, index, flag)
      index += 1
    }
    switch (token) {
      case '--data-dir': assign('dataDir', token); continue
      case '--profile': assign('profile', token); continue
      case '--remote': assign('remote', token); continue
      case '--model': case '-m': assign('model', token); continue
      case '--effort': assign('effort', token); continue
      case '--goal': assign('goal', token); continue
      case '--instructions': assign('instructions', token); continue
      case '--resume':
        if (argv[index + 1] && !argv[index + 1]!.startsWith('-')) { parsed.resume = argv[index + 1]; index += 1 }
        else parsed.resume = true
        continue
      case '--continue': parsed.continue = true; continue
      case '--add-dir': parsed.addDir.push(value(argv, index, token)); index += 1; continue
      case '--allow-tool': parsed.allowTool.push(value(argv, index, token)); index += 1; continue
      case '--deny-tool': parsed.denyTool.push(value(argv, index, token)); index += 1; continue
      case '--image': case '-i': parsed.image.push(value(argv, index, token)); index += 1; continue
      case '--mode': parsed.mode = enumValue(value(argv, index, token), MODES, token); index += 1; continue
      case '--preset': parsed.preset = enumValue(value(argv, index, token), PRESETS, token); index += 1; continue
      case '--output-format': parsed.outputFormat = enumValue(value(argv, index, token), OUTPUT_FORMATS, token); index += 1; continue
      case '--color': parsed.color = enumValue(value(argv, index, token), COLORS, token); index += 1; continue
      case '--timeout': parsed.timeoutMs = duration(value(argv, index, token)); index += 1; continue
      case '--max-turns': parsed.maxTurns = positiveInteger(value(argv, index, token), token); index += 1; continue
      case '--ask-answer': assign('askAnswer', token); continue
      case '--password-stdin': parsed.passwordStdin = true; continue
      case '--embedded': parsed.embedded = true; continue
      case '--yolo': parsed.yolo = true; parsed.preset = 'full'; continue
      case '--print': case '-p': parsed.print = true; continue
      case '--json': parsed.outputFormat = 'json'; continue
      case '--no-color': parsed.color = 'never'; continue
      case '--quiet': case '-q': parsed.quiet = true; continue
      case '--plain': parsed.plain = true; continue
      case '--show-thinking': parsed.showThinking = true; continue
      case '--alt-screen': parsed.altScreen = true; continue
      case '--no-spinner': parsed.noSpinner = true; continue
      case '--bell': parsed.bell = true; continue
      case '--force': parsed.force = true; continue
      case '--follow': parsed.follow = true; continue
      case '--since': parsed.since = nonNegativeInteger(value(argv, index, token), token); index += 1; continue
      case '--port': parsed.port = positiveInteger(value(argv, index, token), token); index += 1; continue
      case '--bind': assign('bind', token); continue
      case '--bridge': parsed.bridge = true; continue
      case '--no-control-socket': parsed.noControlSocket = true; continue
      case '--verbose': parsed.verbose = true; continue
      case '--yes': case '-y': parsed.yes = true; continue
      case '--help': case '-h': parsed.help = true; continue
      case '--version': parsed.version = true; continue
      default:
        if (token.startsWith('-') && !commandSeen) throw new CliUsageError(`Unknown flag: ${token}.`)
        if (!commandSeen && ROOT_COMMANDS.has(token)) {
          parsed.command = token
          commandSeen = true
        } else {
          ;(commandSeen ? parsed.commandArgs : parsed.prompt).push(token)
        }
    }
  }
  return parsed
}

/** Resolve values that have documented flag > environment > profile/settings precedence. */
export function resolveCliOptions(
  flags: ParsedCliArgs,
  environment: CliEnvironment = {},
  defaults: CliDefaults = {}
): ResolvedCliOptions {
  const envMode = environment.LATTICE_MODE ? enumValue(environment.LATTICE_MODE, MODES, 'LATTICE_MODE') : undefined
  const envPreset = environment.LATTICE_PRESET ? enumValue(environment.LATTICE_PRESET, PRESETS, 'LATTICE_PRESET') : undefined
  const envColor: CliColor | undefined = environment.LATTICE_COLOR
    ? enumValue(environment.LATTICE_COLOR, COLORS, 'LATTICE_COLOR')
    : environment.NO_COLOR != null
      ? 'never'
      : environment.FORCE_COLOR != null ? 'always' : undefined
  return {
    dataDir: flags.dataDir ?? environment.LATTICE_DATA_DIR ?? defaults.dataDir,
    profile: flags.profile ?? environment.LATTICE_PROFILE ?? defaults.profile,
    remote: flags.remote ?? environment.LATTICE_REMOTE ?? defaults.remote,
    model: flags.model ?? environment.LATTICE_MODEL ?? defaults.model,
    mode: flags.mode ?? envMode ?? defaults.mode,
    preset: flags.preset ?? envPreset ?? defaults.preset,
    color: flags.color ?? envColor ?? defaults.color
  }
}
