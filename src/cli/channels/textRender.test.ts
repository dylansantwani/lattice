import { describe, expect, it } from 'vitest'
import { renderText, splitBubbles, tableToLines } from './textRender'

describe('renderText', () => {
  it('drops emphasis, heading marks, quotes and rules, keeping every word', () => {
    const { text, entities } = renderText('## Update\n\n**Done** and *soon*, ~~old~~ new\n\n---\n\n> quoted line')
    expect(text).toBe('Update\n\nDone and soon, old new\n\nquoted line')
    expect(entities).toEqual([])
  })

  it('never mangles snake_case, arithmetic, paths or URLs with underscores', () => {
    const input = 'run file_name_here with 2*3*4 at /tmp/a_b_c and https://x.dev/a_b?c=d_e'
    expect(renderText(input).text).toBe(input)
  })

  it('reproduces the reply that used to arrive raw: bold glued to the previous sentence, bullets, code', () => {
    const { text } = renderText('Trying to click through it now.**Update — eBay state:**\n\n- **ebay.com home** — loads fine\n- `pulsecore_electronics` needs a password')
    expect(text).toBe('Trying to click through it now.Update — eBay state:\n\n• ebay.com home — loads fine\n• pulsecore_electronics needs a password')
  })

  it('turns inline code into tap-to-copy code entities and fences into a pre block', () => {
    const { text, entities } = renderText('run `lattice channels pair` then:\n\n```bash\nlattice status\n```')
    expect(text).toBe('run lattice channels pair then:\n\nlattice status')
    expect(entities).toEqual([
      { type: 'code', offset: 4, length: 'lattice channels pair'.length },
      { type: 'pre', offset: text.indexOf('lattice status'), length: 'lattice status'.length, language: 'bash' }
    ])
  })

  it('makes labeled links link entities, or spells them out where entities do not exist', () => {
    const md = 'see [the docs](https://x.dev/docs) or https://y.dev'
    const telegram = renderText(md)
    expect(telegram.text).toBe('see the docs or https://y.dev')
    expect(telegram.entities).toEqual([{ type: 'text_link', offset: 4, length: 8, url: 'https://x.dev/docs' }])
    expect(renderText(md, 'inline').text).toBe('see the docs (https://x.dev/docs) or https://y.dev')
    expect(renderText('[https://a.b](https://a.b)', 'inline').text).toBe('https://a.b')
  })

  it('counts entity offsets in UTF-16 units, past emoji', () => {
    const { text, entities } = renderText('👀 ok `code`')
    expect(text.slice(entities[0]!.offset, entities[0]!.offset + entities[0]!.length)).toBe('code')
  })

  it('renders an unterminated fence as code and collapses blank runs', () => {
    expect(renderText('a\n\n\n\nb\n```\nhalf').text).toBe('a\n\nb\nhalf')
  })
})

describe('tables', () => {
  it('reads two columns as key: value and skips the header row of labels', () => {
    const { text } = renderText('| | |\n|---|---|\n| **Total balance** | **$1.32 USD** |\n| Granted (free) | $0.00 |')
    expect(text).toBe('Total balance: $1.32 USD\nGranted (free): $0.00')
  })

  it('labels wider tables with their headers and drops empty cells', () => {
    const md = '| Model | Reqs | Tokens in | Cost |\n|---|---|---|---|\n| **deepseek-v4-flash** | 4,468 | 707.2M | **$16.02** (28%) |\n| openrouter free-tier | 1,495 | — | $0.24 |'
    expect(renderText(md).text).toBe('deepseek-v4-flash: Reqs 4,468 · Tokens in 707.2M · Cost $16.02 (28%)\nopenrouter free-tier: Reqs 1,495 · Cost $0.24')
  })

  it('handles rows without a leading cell and escaped pipes', () => {
    expect(tableToLines([['', 'a', 'b'], ['', '1', '2']])).toEqual(['a 1 · b 2'])
    expect(renderText('| a | b |\n|---|---|\n| x \\| y | z |').text).toBe('x | y: z')
  })

  it('leaves a lone pipe in prose alone', () => {
    expect(renderText('a | b').text).toBe('a | b')
  })
})

describe('splitBubbles', () => {
  it('sends each paragraph as its own text', () => {
    expect(splitBubbles('$1.32 left.\n\nthat is dollars, not tokens.')).toEqual(['$1.32 left.', 'that is dollars, not tokens.'])
  })

  it('merges the shortest neighbours when there are too many paragraphs', () => {
    const bubbles = splitBubbles('one\n\ntwo\n\nthree\n\nfour is longer than the rest by a lot\n\nfive', 3)
    expect(bubbles).toHaveLength(3)
    expect(bubbles.join('\n\n')).toBe('one\n\ntwo\n\nthree\n\nfour is longer than the rest by a lot\n\nfive')
  })

  it('never splits inside a code fence and drops paragraphs with no visible words', () => {
    expect(splitBubbles('look:\n\n```\na\n\nb\n```\n\n---')).toEqual(['look:', '```\na\n\nb\n```'])
  })
})
