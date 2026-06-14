const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  captureLoadedMcpProbe,
  parseArgs,
  parsePayloadText,
  wrapMcpToolResult,
} = require('../scripts/capture-loaded-mcp-probe.js')

test('parseArgs defaults to the Resplit FX loaded MCP probe contract', () => {
  const options = parseArgs([])

  assert.equal(options.output, path.join('reports', 'firstbite-loaded-mcp-lanes.json'))
  assert.equal(options.reuseExisting, false)
  assert.equal(options.expectedRepo, 'resplit_currency_api')
  assert.deepEqual(options.expectedLaneIds, [
    'resplit_currency_api_unit',
    'resplit_currency_api_integration',
    'resplit_currency_api_ui',
  ])
})

test('parsePayloadText accepts mixed tool output around a text result object', () => {
  const parsed = parsePayloadText('noise {"type":"text","text":"{\\"repos\\":{},\\"lanes\\":{}}"} tail')
  const wrapped = wrapMcpToolResult(parsed)

  assert.equal(wrapped.content[0].type, 'text')
})

test('captureLoadedMcpProbe writes a normalized durable artifact from MCP content', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-loaded-mcp-probe-'))
  const stdin = JSON.stringify([{
    type: 'text',
    text: JSON.stringify({
      repos: {
        resplit_web: { path: '/Users/leokwan/Development/resplit-web' },
      },
      lanes: {
        resplit_web_unit: { repo: 'resplit_web', kind: 'unit' },
      },
    }),
  }])

  const result = captureLoadedMcpProbe(['--repo', repoDir], {
    stdin,
    now: () => '2026-05-25T06:10:00.000Z',
  })
  const artifact = JSON.parse(fs.readFileSync(path.join(repoDir, 'reports', 'firstbite-loaded-mcp-lanes.json'), 'utf8'))

  assert.equal(artifact.checkedAt, '2026-05-25T06:10:00.000Z')
  assert.equal(artifact.payload.repos.resplit_web.path, '/Users/leokwan/Development/resplit-web')
  assert.equal(result.probe.status, 'red')
  assert.equal(result.probe.freshnessStatus, 'green')
  assert.match(result.probe.summary, /repo missing/)
})

test('captureLoadedMcpProbe can refresh a previous artifact without claiming host reload proof', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-loaded-mcp-probe-reuse-'))
  const outputDir = path.join(repoDir, 'reports')
  fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(path.join(outputDir, 'firstbite-loaded-mcp-lanes.json'), `${JSON.stringify({
    checkedAt: '2026-05-25T05:55:00.000Z',
    source: 'codex-mcp-tool:mcp__firstbite_local_ci.list_lanes',
    note: 'Older loaded-host probe.',
    payload: {
      repos: {
        resplit_web: { path: '/Users/leokwan/Development/resplit-web' },
      },
      groups: {
        critical_fast: ['resplit_web_unit'],
      },
      lanes: {
        resplit_web_unit: { repo: 'resplit_web', kind: 'unit' },
      },
    },
  }, null, 2)}\n`)

  const result = captureLoadedMcpProbe(['--repo', repoDir, '--reuse-existing'], {
    now: () => '2026-05-25T06:25:00.000Z',
  })
  const artifact = JSON.parse(fs.readFileSync(path.join(outputDir, 'firstbite-loaded-mcp-lanes.json'), 'utf8'))

  assert.equal(artifact.checkedAt, '2026-05-25T06:25:00.000Z')
  assert.equal(artifact.payload.repos.resplit_web.path, '/Users/leokwan/Development/resplit-web')
  assert.match(artifact.source, /^previous-loaded-mcp-artifact:/)
  assert.match(artifact.note, /does not prove.*host restart/i)
  assert.equal(result.probe.status, 'red')
  assert.equal(result.probe.freshnessStatus, 'green')
  assert.match(result.probe.summary, /repo missing/)
})
