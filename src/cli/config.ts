import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface CliProfile {
  remote?: string
  dataDir?: string
  model?: string
  preset?: 'manual' | 'workspace' | 'full'
  mode?: 'plan' | 'act' | 'review'
  color?: 'auto' | 'always' | 'never'
}

export interface CliConfig {
  profiles?: Record<string, CliProfile> | CliProfile[]
  defaultProfile?: string
  [key: string]: unknown
}

export function cliConfigDir(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config')
  return resolve(join(base, 'lattice'))
}

export function cliConfigPath(): string {
  return join(cliConfigDir(), 'config.json')
}

export async function readCliConfig(): Promise<CliConfig> {
  try {
    const raw = JSON.parse(await readFile(cliConfigPath(), 'utf8')) as unknown
    return raw && typeof raw === 'object' ? raw as CliConfig : {}
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`could not read ${cliConfigPath()}: ${(error as Error).message}`)
  }
}

export function profileFromConfig(config: CliConfig, name?: string): CliProfile | undefined {
  const selected = name || config.defaultProfile
  if (!selected) return undefined
  const profiles = config.profiles
  if (Array.isArray(profiles)) return profiles.find((profile) => (profile as CliProfile & { name?: string }).name === selected)
  return profiles?.[selected]
}

export async function readCliProfile(name?: string): Promise<CliProfile | undefined> {
  return profileFromConfig(await readCliConfig(), name)
}

export async function writeCliConfig(config: CliConfig): Promise<void> {
  const dir = cliConfigDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, 'config.json')
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await chmod(path, 0o600)
}

export async function readCachedToken(endpoint: string): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(cliConfigDir(), 'tokens.json'), 'utf8')) as Record<string, unknown>
    const token = raw[endpoint]
    return typeof token === 'string' && token ? token : undefined
  } catch {
    return undefined
  }
}

export async function cacheToken(endpoint: string, token: string): Promise<void> {
  const dir = cliConfigDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, 'tokens.json')
  let tokens: Record<string, string> = {}
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    tokens = Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch {
    /* first use */
  }
  tokens[endpoint] = token
  await writeFile(path, `${JSON.stringify(tokens, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await chmod(path, 0o600)
}
