import { describe, expect, it } from 'vitest'
import { sendAction } from './composerKeys'

const mods = (m: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }> = {}) => ({
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  ...m
})

describe('sendAction — Enter (default) mode', () => {
  it('a bare Enter sends', () => {
    expect(sendAction('enter', mods())).toBe('send')
  })
  it('Shift+Enter is a newline', () => {
    expect(sendAction('enter', mods({ shiftKey: true }))).toBe('newline')
  })
  it('⌘+Enter queues', () => {
    expect(sendAction('enter', mods({ metaKey: true }))).toBe('queue')
  })
  it('Ctrl+Enter queues (Windows/Linux)', () => {
    expect(sendAction('enter', mods({ ctrlKey: true }))).toBe('queue')
  })
  it('Shift+⌘+Enter is a newline, not a queue', () => {
    expect(sendAction('enter', mods({ shiftKey: true, metaKey: true }))).toBe('newline')
  })
})

describe('sendAction — ⌘/Ctrl+Enter mode', () => {
  it('a bare Enter is a newline', () => {
    expect(sendAction('mod-enter', mods())).toBe('newline')
  })
  it('⌘+Enter sends', () => {
    expect(sendAction('mod-enter', mods({ metaKey: true }))).toBe('send')
  })
  it('Ctrl+Enter sends', () => {
    expect(sendAction('mod-enter', mods({ ctrlKey: true }))).toBe('send')
  })
  it('Shift+Enter is a newline', () => {
    expect(sendAction('mod-enter', mods({ shiftKey: true }))).toBe('newline')
  })
})
