import React, { memo, useEffect, useMemo, useState } from 'react'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Root, RootContent, PhrasingContent } from 'mdast'
import { highlightCode } from './highlighter'

const processor = unified().use(remarkParse).use(remarkGfm)

/**
 * Streaming-safe Markdown renderer: parses to mdast and renders block-by-block.
 * Completed blocks are memoized by their source slice so re-parses during
 * streaming do not re-render earlier content.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const tree = useMemo(() => processor.parse(text) as Root, [text])
  return (
    <div className="md">
      {tree.children.map((node, i) => (
        <Block key={blockKey(node, i, text)} node={node} src={text} />
      ))}
    </div>
  )
})

function blockKey(node: RootContent, i: number, src: string): string {
  const pos = node.position
  if (!pos) return String(i)
  // key by content slice so unchanged blocks keep identity while streaming
  return `${i}:${src.slice(pos.start.offset ?? 0, pos.end.offset ?? 0).length}`
}

const Block = memo(
  function Block({ node }: { node: RootContent; src: string }) {
    return <>{renderNode(node, 0)}</>
  },
  (prev, next) => {
    const p = prev.node.position
    const n = next.node.position
    if (!p || !n) return false
    return (
      prev.src.slice(p.start.offset ?? 0, p.end.offset ?? 0) ===
      next.src.slice(n.start.offset ?? 0, n.end.offset ?? 0)
    )
  }
)

function renderChildren(children: (RootContent | PhrasingContent)[], depth: number): React.ReactNode {
  return children.map((c, i) => <React.Fragment key={i}>{renderNode(c as RootContent, depth + 1)}</React.Fragment>)
}

function renderNode(node: RootContent | PhrasingContent, depth: number): React.ReactNode {
  switch (node.type) {
    case 'paragraph':
      return <p>{renderChildren(node.children, depth)}</p>
    case 'text':
      return node.value
    case 'strong':
      return <strong>{renderChildren(node.children, depth)}</strong>
    case 'emphasis':
      return <em>{renderChildren(node.children, depth)}</em>
    case 'delete':
      return <del>{renderChildren(node.children, depth)}</del>
    case 'inlineCode':
      return <code>{node.value}</code>
    case 'break':
      return <br />
    case 'link':
      return (
        <a href={sanitizeUrl(node.url)} target="_blank" rel="noreferrer noopener">
          {renderChildren(node.children, depth)}
        </a>
      )
    case 'image':
      return <span className="md-img-placeholder">[image: {node.alt ?? node.url}]</span>
    case 'heading': {
      const Tag = (`h${Math.min(node.depth, 6)}`) as 'h1'
      return <Tag>{renderChildren(node.children, depth)}</Tag>
    }
    case 'list':
      return node.ordered ? (
        <ol start={node.start ?? undefined}>{renderChildren(node.children, depth)}</ol>
      ) : (
        <ul>{renderChildren(node.children, depth)}</ul>
      )
    case 'listItem': {
      const checkbox =
        node.checked === null || node.checked === undefined ? null : (
          <input type="checkbox" checked={node.checked} readOnly aria-label="task item" />
        )
      return (
        <li style={node.checked !== null && node.checked !== undefined ? { listStyle: 'none', marginLeft: -20 } : undefined}>
          {checkbox}
          {node.children.map((c, i) => {
            // unwrap single paragraphs inside list items for tighter rhythm
            if (c.type === 'paragraph')
              return <React.Fragment key={i}>{renderChildren(c.children, depth)}</React.Fragment>
            return <React.Fragment key={i}>{renderNode(c, depth)}</React.Fragment>
          })}
        </li>
      )
    }
    case 'code':
      return <CodeBlock lang={node.lang ?? undefined} value={node.value} />
    case 'blockquote':
      return <blockquote>{renderChildren(node.children, depth)}</blockquote>
    case 'thematicBreak':
      return <hr />
    case 'table': {
      const [head, ...rows] = node.children
      return (
        <table>
          {head && (
            <thead>
              <tr>
                {head.children.map((cell, i) => (
                  <th key={i} style={alignStyle(node.align?.[i])}>
                    {renderChildren(cell.children, depth)}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {row.children.map((cell, ci) => (
                  <td key={ci} style={alignStyle(node.align?.[ci])}>
                    {renderChildren(cell.children, depth)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )
    }
    case 'html':
      // raw HTML disabled: render as escaped text
      return <code>{node.value}</code>
    case 'footnoteReference':
      return <sup>[{node.identifier}]</sup>
    case 'footnoteDefinition':
      return (
        <div className="footnote">
          <sup>[{node.identifier}]</sup> {renderChildren(node.children, depth)}
        </div>
      )
    default:
      if ('children' in node) return renderChildren((node as { children: PhrasingContent[] }).children, depth)
      if ('value' in node) return (node as { value: string }).value
      return null
  }
}

function alignStyle(align: string | null | undefined): React.CSSProperties | undefined {
  return align ? { textAlign: align as 'left' | 'center' | 'right' } : undefined
}

function sanitizeUrl(url: string): string {
  if (/^(https?:|mailto:)/i.test(url)) return url
  return '#'
}

function CodeBlock({ lang, value }: { lang?: string; value: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  // Highlighted token markup from Shiki, or null while it's loading / for a plain-text block. We
  // render the raw text until the async tokenize resolves, so streaming code never blocks on it.
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void highlightCode(value, lang).then((out) => {
      if (alive) setHtml(out)
    })
    return () => {
      alive = false
    }
  }, [value, lang])
  return (
    <pre>
      <div className="code-head">
        <span>{lang ?? 'text'}</span>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(value)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      {html ? (
        <code className="shiki-code" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <code>{value}</code>
      )}
    </pre>
  )
}
