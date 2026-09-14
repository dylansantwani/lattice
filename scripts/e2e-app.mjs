// End-to-end test against the RUNNING Lattice dev app (no UI automation needed).
// Drives the app through its own renderer bridge (window.lattice) over the Electron
// DevTools protocol (port 9223, exposed by `npm run dev`), then reads back the telemetry
// and event log the app itself recorded. Verifies:
//   - prompt-cache hit rate >= 85% on warm turns (the transcript's "% cached" chip data)
//   - deferred tool discovery: the model calls find_mcp and loads one MCP's complete tool set
// Usage:  npm run dev   (in another terminal, wait for the window)
//         node scripts/e2e-app.mjs [model-id]
// Creates a visible "E2E cache test" thread in the sidebar; delete it afterwards if unwanted.
const list = await (await fetch('http://127.0.0.1:9223/json/list')).json()
const page = list.find((t) => t.type === 'page')
if (!page) throw new Error('no renderer page target')

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
}
await new Promise((r) => (ws.onopen = r))

function cdp(method, params) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => pending.set(id, resolve))
}

async function evalAsync(expression) {
  const res = await cdp('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 180000
  })
  if (res.error || res.result?.exceptionDetails)
    throw new Error(JSON.stringify(res.error ?? res.result.exceptionDetails).slice(0, 500))
  return res.result?.result?.value
}

const MODEL = process.argv[2] ?? 'cc/claude-fable-5'

// 1. fresh thread
const thread = await evalAsync(
  `window.lattice.createThread({ title: 'E2E cache test', model: ${JSON.stringify(MODEL)} })`
)
console.log('thread:', thread.id, 'model:', thread.model, 'preset:', thread.permissionPreset, 'mode:', thread.mode)

let turnNo = 0
async function turn(text) {
  turnNo++
  const expected = turnNo * 2 // user + assistant per turn
  await evalAsync(
    `window.lattice.send({ threadId: ${JSON.stringify(thread.id)}, text: ${JSON.stringify(text)} })`
  )
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const msgs = await evalAsync(
      `window.lattice.getThread(${JSON.stringify(thread.id)}).then(t => t.messages.filter(m => m.role === 'user' || m.role === 'assistant'))`
    )
    const last = msgs[msgs.length - 1]
    if (msgs.length >= expected && last.role === 'assistant' && last.status) {
      await new Promise((r) => setTimeout(r, 1500)) // let the run fully unwind before the next send
      const t = last.telemetry ?? {}
      const rate = t.tokensIn ? Math.round(((t.cacheReadTokens ?? 0) / t.tokensIn) * 100) : 0
      console.log(
        `turn done (${last.status}): in=${t.tokensIn} read=${t.cacheReadTokens ?? 0} ` +
          `write=${t.cacheWriteTokens ?? 0} hit=${rate}% out=${t.tokensOut} :: ${String(last.text).slice(0, 100).replace(/\n/g, ' ')}`
      )
      return { telemetry: t, rate, text: last.text }
    }
  }
  throw new Error('turn timed out')
}

console.log('--- turn 1 (cold: expect cache write, no read) ---')
const t1 = await turn('Reply with only the word OK.')
console.log('--- turn 2 (warm: expect high hit rate) ---')
const t2 = await turn('Reply with only the word OK again.')
console.log('--- turn 3 (warm) ---')
const t3 = await turn('Reply with only the number 3.')

console.log('--- discovery turn: model should call find_mcp, not claim inability ---')
const d = await turn('Using find_mcp, load the connected MCP for controlling a web browser, then list its tool names. Do not actually open anything.')

// pull the event log to verify find_mcp actually ran
const events = await evalAsync(`window.lattice.getThread(${JSON.stringify(thread.id)}).then(t => t.events)`)
const toolEvents = events
  .filter((e) => e.body.type === 'tool.result' || e.body.type === 'tool.started')
  .map((e) => `${e.body.type}:${e.body.tool}`)
console.log('tool events:', JSON.stringify(toolEvents))

const pass2 = t2.rate >= 85
const pass3 = t3.rate >= 85
const passDiscovery = toolEvents.some((e) => e.includes('find_mcp'))
console.log(`\nRESULTS: turn2 hit ${t2.rate}% ${pass2 ? 'PASS' : 'FAIL'} | turn3 hit ${t3.rate}% ${pass3 ? 'PASS' : 'FAIL'} | find_mcp used: ${passDiscovery ? 'PASS' : 'FAIL'}`)
console.log('discovery answer:', String(d.text).slice(0, 300).replace(/\n/g, ' '))
ws.close()
process.exit(pass2 && pass3 && passDiscovery ? 0 : 1)
