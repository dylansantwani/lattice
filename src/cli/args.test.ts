import { describe, expect, it } from 'vitest'
import { CliUsageError, parseCliArgs, resolveCliOptions } from './args'

describe('parseCliArgs', () => {
  it('parses every global flag and repeated values', () => {
    expect(parseCliArgs([
      '--data-dir', '/tmp/lattice', '--profile', 'work', '--remote', 'https://remote.example', '--embedded',
      '-m', 'model/a', '--effort', 'high', '--mode', 'act', '--preset', 'workspace',
      '--allow-tool', 'shell:git *', '--deny-tool', 'fs_delete:dist/**', '--add-dir', 'docs', '--add-dir', 'tmp',
      '--goal', 'Ship it', '--instructions', '@instructions.md', '-i', 'one.png', '--image', 'two.png', '-p',
      '--output-format', 'stream-json', '--color', 'always', '-q', '--verbose', '-y', '--timeout', '90s',
      '--max-turns', '6', '--help', '--version', 'review this'
    ])).toEqual({
      command: undefined, commandArgs: [], prompt: ['review this'], dataDir: '/tmp/lattice', profile: 'work',
      remote: 'https://remote.example', embedded: true, model: 'model/a', effort: 'high', mode: 'act',
      preset: 'workspace', yolo: false, allowTool: ['shell:git *'], denyTool: ['fs_delete:dist/**'],
      addDir: ['docs', 'tmp'], goal: 'Ship it', instructions: '@instructions.md', image: ['one.png', 'two.png'],
      print: true, outputFormat: 'stream-json', color: 'always', quiet: true, verbose: true, yes: true,
      timeoutMs: 90_000, maxTurns: 6, help: true, version: true
    })
  })

  it('keeps subcommands and their positional/command-specific arguments separate', () => {
    expect(parseCliArgs(['threads', 'show', 'thread_1', '--events', '--json', '--mode', 'review'])).toMatchObject({
      command: 'threads', commandArgs: ['show', 'thread_1', '--events'], prompt: [], outputFormat: 'json', mode: 'review'
    })
    expect(parseCliArgs(['send', '--', '--not-a-global-flag', 'text'])).toMatchObject({
      command: 'send', commandArgs: ['--not-a-global-flag', 'text']
    })
  })

  it('uses yolo as a full-preset alias while leaving confirmation to the caller', () => {
    expect(parseCliArgs(['--yolo'])).toMatchObject({ yolo: true, preset: 'full', yes: false })
  })

  it('rejects malformed global input as a usage error', () => {
    for (const argv of [
      ['--wat'], ['--model'], ['--mode', 'unsafe'], ['--preset', 'custom'], ['--color', 'blue'],
      ['--output-format', 'yaml'], ['--timeout', 'later'], ['--max-turns', '0']
    ]) expect(() => parseCliArgs(argv)).toThrow(CliUsageError)
  })
})

describe('resolveCliOptions', () => {
  it('uses flag > environment > profile/settings precedence', () => {
    const parsed = parseCliArgs(['--model', 'flag-model', '--mode', 'review', '--color', 'auto'])
    expect(resolveCliOptions(parsed, {
      LATTICE_DATA_DIR: '/env/data', LATTICE_PROFILE: 'env', LATTICE_REMOTE: 'https://env.example',
      LATTICE_MODEL: 'env-model', LATTICE_MODE: 'plan', LATTICE_PRESET: 'manual', NO_COLOR: '1'
    }, {
      dataDir: '/settings/data', profile: 'settings', remote: 'https://settings.example', model: 'settings-model',
      mode: 'act', preset: 'workspace', color: 'always'
    })).toEqual({
      dataDir: '/env/data', profile: 'env', remote: 'https://env.example', model: 'flag-model',
      mode: 'review', preset: 'manual', color: 'auto'
    })
  })

  it('derives color from the environment when no explicit color flag exists', () => {
    expect(resolveCliOptions(parseCliArgs([]), { FORCE_COLOR: '1' }, { color: 'never' }).color).toBe('always')
    expect(resolveCliOptions(parseCliArgs([]), { NO_COLOR: '' }, { color: 'always' }).color).toBe('never')
  })
})
