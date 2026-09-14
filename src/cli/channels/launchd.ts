/**
 * Keep the gateway running on macOS: a per-user LaunchAgent that starts `lattice channels serve` at
 * login and restarts it if it dies. The gateway itself waits for Lattice rather than exiting, so
 * KeepAlive never turns into a relaunch spin; ThrottleInterval caps restarts anyway.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'

export const AGENT_LABEL = 'com.lattice.channels'

export function agentPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`)
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function renderAgentPlist(options: { node: string; cli: string; dataDir: string; logPath: string; path?: string }): string {
  const args = [options.node, options.cli, '--data-dir', options.dataDir, 'channels', 'serve']
  const envPath = options.path ?? `${dirname(options.node)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${join(homedir(), '.local/bin')}`
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${AGENT_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map((arg) => `    <string>${xml(arg)}</string>`),
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    `    <key>PATH</key><string>${xml(envPath)}</string>`,
    // Tells `channels serve` it may exit on a config change: launchd brings it back with the change.
    '    <key>LATTICE_CHANNELS_SUPERVISED</key><string>1</string>',
    '  </dict>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    '  <key>ThrottleInterval</key><integer>30</integer>',
    '  <key>ProcessType</key><string>Background</string>',
    `  <key>StandardOutPath</key><string>${xml(options.logPath)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(options.logPath)}</string>`,
    '</dict>',
    '</plist>',
    ''
  ].join('\n')
}

function domain(): string {
  return `gui/${userInfo().uid}`
}

export function installAgent(options: { node: string; cli: string; dataDir: string; logPath: string }): string {
  if (process.platform !== 'darwin') throw new Error('install-agent is macOS only; on Linux run `lattice channels serve` under systemd')
  const plist = agentPlistPath()
  mkdirSync(dirname(plist), { recursive: true })
  writeFileSync(plist, renderAgentPlist(options))
  try {
    execFileSync('launchctl', ['bootout', `${domain()}/${AGENT_LABEL}`], { stdio: 'ignore' })
  } catch {
    /* not loaded yet */
  }
  execFileSync('launchctl', ['bootstrap', domain(), plist], { stdio: 'pipe' })
  return plist
}

export function uninstallAgent(): boolean {
  const plist = agentPlistPath()
  try {
    execFileSync('launchctl', ['bootout', `${domain()}/${AGENT_LABEL}`], { stdio: 'ignore' })
  } catch {
    /* not loaded */
  }
  if (!existsSync(plist)) return false
  unlinkSync(plist)
  return true
}
