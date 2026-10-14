// Runs against the compiled renderer in dist/ (`pnpm test` compiles first).
// The test lives outside src/, so `tsc -p ./` never copies it into dist/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  escapeHtml,
  buildWebview,
  renderSops,
  renderIncidents,
  renderWasmRules,
  renderTraces,
} = require('../dist/webview.js')

const XSS = '<img src=x onerror=alert(1)>'
const CSP_SOURCE = 'https://*.vscode-cdn.net'

/** No element or attribute an attacker supplied made it into the markup. */
function assertInert(html) {
  assert.ok(!/<img/i.test(html), 'output contains an <img element')
  assert.ok(!/<script/i.test(html), 'output contains a <script element')
  // Quoted attribute values are inert text (a `"` inside one is escaped), so
  // blank them before looking for an injected attribute inside a tag.
  const tags = html.replace(/"[^"]*"/g, '""')
  assert.ok(!/<[a-z][^>]*\sonerror=/i.test(tags), 'output contains an onerror attribute')
}

test('escapeHtml escapes & first, then < > " \'', () => {
  assert.equal(escapeHtml(`&lt; <a href="x" title='y'>`), '&amp;lt; &lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;')
  assert.equal(escapeHtml(null), '')
  assert.equal(escapeHtml(42), '42')
})

test('SOP title renders as text, not markup', () => {
  const html = renderSops({ items: [{ sopId: 's1', title: XSS, lifecycleState: 'VALIDATED', riskTier: 'HIGH' }] })
  assertInert(html)
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
  assert.ok(html.includes('badge badge-active'))
})

test('hostile SOP lifecycle state cannot break out of the class attribute', () => {
  const state = `x"><img src=x onerror=alert(1)>`
  const html = renderSops({ items: [{ sopId: 's1', title: 'ok', lifecycleState: state }] })
  assertInert(html)
  // The class comes from a fixed allow-list, never from the API value.
  assert.match(html, /<span class="badge">x&quot;&gt;&lt;img/)
})

test('SOP risk tier is escaped', () => {
  const html = renderSops({ items: [{ sopId: 's1', title: 'ok', riskTier: XSS }] })
  assertInert(html)
})

test('incident type, status and severity are escaped', () => {
  const html = renderIncidents({
    data: [{ incident_id: 'inc_1', anomaly_type: XSS, resolution_status: `open"><img src=x onerror=alert(1)>`, severity: XSS }],
  })
  assertInert(html)
  for (const [, cls] of html.matchAll(/class="([^"]*)"/g)) {
    assert.match(cls, /^[a-z -]+$/, `class attribute carries API data: ${cls}`)
  }
})

test('WASM rule name, sha (title attribute) and version are escaped', () => {
  const html = renderWasmRules([
    { name: XSS, bundleSha256: `"><img src=x onerror=alert(1)>`, version: XSS, isActive: true },
  ])
  assertInert(html)
  assert.ok(html.includes('title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"'))
})

test('traces stdout and stderr are escaped', () => {
  assertInert(renderTraces({ ok: true, stdout: XSS }))
  assertInert(renderTraces({ ok: false, error: XSS }))
})

test('panels read the rows where the routes send them', () => {
  assert.ok(renderSops({ items: [{ sopId: 's1', title: 'Deploy checklist', lifecycleState: 'VALIDATED' }] }).includes('Deploy checklist'))
  const incidents = renderIncidents({ data: [{ incident_id: 'inc_1', anomaly_type: 'DATA_EXFILTRATION', severity: 'HIGH', resolution_status: 'OPEN' }] })
  assert.ok(incidents.includes('DATA_EXFILTRATION'))
  assert.ok(incidents.includes('badge badge-open'))
  // A TOON-encoded page is a string, not rows: shown as empty, never as markup.
  assert.ok(renderIncidents({ data: 'data[1]{incident_id}:\n  inc_1' }).includes('No governance incidents'))
  assert.ok(renderWasmRules([{ name: 'No secrets', bundleSha256: 'a'.repeat(64), isActive: true, version: 2 }]).includes('v2'))
})

test('offline panels still render the banner', () => {
  for (const render of [renderSops, renderIncidents, renderWasmRules]) {
    assert.ok(render(null).includes('offline-banner'))
  }
})

test('shell escapes the <title> and sets a strict CSP with a per-render nonce', () => {
  const html = buildWebview(`</title>${XSS}`, '<p>body</p>', CSP_SOURCE)
  assertInert(html)

  const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/)
  assert.ok(meta, 'CSP meta tag missing')
  const csp = meta[1]
  assert.match(csp, /default-src 'none'/)
  assert.ok(csp.includes(`style-src ${CSP_SOURCE} 'nonce-`))
  assert.ok(csp.includes(`img-src ${CSP_SOURCE}`))

  const nonce = csp.match(/'nonce-([^']+)'/)[1]
  assert.ok(nonce.length >= 16)
  assert.ok(html.includes(`<style nonce="${nonce}">`), 'style tag does not carry the CSP nonce')
  assert.ok(csp.includes(`script-src 'nonce-${nonce}'`))
  assert.ok(!/\sstyle="/.test(html), 'inline style attributes are blocked by the CSP')

  const again = buildWebview('t', '', CSP_SOURCE).match(/'nonce-([^']+)'/)[1]
  assert.notEqual(again, nonce, 'nonce must be fresh per render')
})

test('panel bodies use no inline style attributes', () => {
  const bodies = [
    renderSops({ items: [{ sopId: 's', title: 't' }] }),
    renderTraces({ ok: true, stdout: 'x' }),
    renderTraces({ ok: false, error: 'x' }),
  ]
  for (const b of bodies) assert.ok(!/\sstyle="/.test(b))
})
