import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { handleOcr } from '../worker/src/ocr/router.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const openapi = YAML.parse(fs.readFileSync(path.join(repoRoot, 'openapi/openapi.yaml'), 'utf8'))
const routerSource = fs.readFileSync(path.join(repoRoot, 'worker/src/ocr/router.mjs'), 'utf8')

const multiEngineRoutes = [...routerSource.matchAll(
  /method === 'POST' && url\.pathname === '(\/ocr\/(?:dual-scan|analyze))'/g,
)].map((match) => match[1]).sort()

test('OpenAPI documents every live multi-engine OCR route with its real method identity', () => {
  assert.deepEqual(multiEngineRoutes, ['/ocr/analyze', '/ocr/dual-scan'])
  assert.deepEqual(
    multiEngineRoutes.map((route) => Object.keys(openapi.paths?.[route] || {})),
    [['post'], ['post']],
  )
  assert.deepEqual(
    multiEngineRoutes.map((route) => openapi.paths[route].post.operationId),
    ['postOcrAnalyze', 'postOcrDualScan'],
  )
})

test('the dual-scan contract pins the shipped v1 provider legs and partial-result vocabulary', () => {
  const operation = openapi.paths['/ocr/dual-scan'].post
  assert.equal(operation.requestBody.$ref, '#/components/requestBodies/OcrImage')
  assert.equal(openapi.components.requestBodies.OcrImage.content['image/jpeg'].schema.format, 'binary')
  assert.equal(operation.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/DualScanEnvelope')

  const schema = openapi.components.schemas.DualScanEnvelope
  assert.deepEqual(schema.required, [
    'v', 'mode', 'scanId', 'status', 'azure', 'llm', 'divergence', 'llmReasoning', 'aiModels',
  ])
  assert.equal(schema.properties.status.$ref, '#/components/schemas/MultiEngineScanStatus')
  assert.deepEqual(openapi.components.schemas.MultiEngineScanStatus.enum, [
    'succeeded', 'partial', 'rate_limited', 'provider_error',
  ])
  assert.equal(schema.properties.mode.const, 'dual')
  assert.equal(schema.properties.azure.$ref, '#/components/schemas/AzureScanLeg')
  assert.equal(schema.properties.llm.$ref, '#/components/schemas/LlmScanLeg')
})

test('the analyze contract pins the shipped v2 N-engine envelope instead of the legacy dual shape', () => {
  const operation = openapi.paths['/ocr/analyze'].post
  assert.equal(operation.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/AnalyzeEnvelope')

  const schema = openapi.components.schemas.AnalyzeEnvelope
  assert.deepEqual(schema.required, [
    'v', 'scanId', 'status', 'llmReasoning', 'aiModels', 'engines', 'consensus',
  ])
  assert.equal(schema.properties.v.const, 2)
  assert.equal(schema.properties.engines.type, 'array')
  assert.equal(schema.properties.engines.items.$ref, '#/components/schemas/AnalyzeEngine')
  assert.equal('mode' in schema.properties, false)
})

test('nested receipt, ingress, error, and legacy raw-envelope schemas match emitted Worker truth', () => {
  const receipt = openapi.components.schemas.ScannedReceipt
  const lineItem = receipt.properties.lineItems.items.properties
  assert.deepEqual(lineItem.amount.type, ['number', 'null'])
  assert.deepEqual(lineItem.quantity.type, ['number', 'null'])
  assert.deepEqual(receipt.properties.extras.items.properties.kind.enum, [
    'tax', 'tip', 'fee', 'serviceCharge', 'mandate', 'surcharge', 'discount', 'credit', 'rounding', 'payment', 'unknown',
  ])

  for (const [route, envelope] of [
    ['/ocr/dual-scan', 'DualScanEnvelope'],
    ['/ocr/analyze', 'AnalyzeEnvelope'],
  ]) {
    const responses = openapi.paths[route].post.responses
    assert.equal(responses['413'].$ref, '#/components/responses/OcrPayloadTooLarge')
    assert.deepEqual(responses['502'].content['application/json'].schema.oneOf, [
      { $ref: `#/components/schemas/${envelope}` },
      { $ref: '#/components/schemas/Error' },
    ])
  }

  assert.equal(openapi.components.schemas.ScanEnvelope.required.includes('kv_extras'), true)
  assert.deepEqual(openapi.components.schemas.ScanEnvelope.properties.kv_extras.enum, ['on', 'off'])
})

test('wrong route, method, version, or provider-leg identity mutations fail the contract', () => {
  const mutations = [
    () => ({ ...openapi, paths: { ...openapi.paths, '/ocr/dual-scan': undefined } }),
    () => ({ ...openapi, paths: { ...openapi.paths, '/ocr/analyze': { get: openapi.paths['/ocr/analyze'].post } } }),
    () => {
      const copy = structuredClone(openapi)
      copy.components.schemas.AnalyzeEnvelope.properties.v.const = 1
      return copy
    },
    () => {
      const copy = structuredClone(openapi)
      copy.components.schemas.DualScanEnvelope.properties.azure.$ref = '#/components/schemas/LlmScanLeg'
      return copy
    },
  ]

  const valid = (candidate) => {
    const dual = candidate.paths?.['/ocr/dual-scan']?.post
    const analyze = candidate.paths?.['/ocr/analyze']?.post
    return Boolean(
      dual && analyze &&
      candidate.components.schemas.AnalyzeEnvelope.properties.v.const === 2 &&
      candidate.components.schemas.DualScanEnvelope.properties.azure.$ref === '#/components/schemas/AzureScanLeg'
    )
  }

  assert.equal(valid(openapi), true)
  for (const mutate of mutations) assert.equal(valid(mutate()), false)
})

test('the real Worker handler emits both documented top-level envelope shapes', async () => {
  const store = new Map()
  const env = {
    ATTEST_KV: {
      async get(key) { return store.get(key) ?? null },
      async put(key, value) { store.set(key, value) },
      async delete(key) { store.delete(key) },
    },
    AZURE_OCR_ENDPOINT: 'https://test.cognitiveservices.azure.com',
    AZURE_OCR_KEY: 'test-key',
    ANTHROPIC_API_KEY: 'anthropic-key',
    LLM_SCAN_MODEL: 'claude-sonnet-5',
    LLM_SCAN_ALLOW_SOFT_FAIL: 'true',
    LLM_SCAN_DAILY_CAP: '50',
  }
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    if (target === 'https://api.anthropic.com/v1/messages') {
      return Response.json({
        id: 'msg_contract', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
        stop_reason: 'tool_use',
        content: [{
          type: 'tool_use', id: 'tool_contract', name: 'emit_receipt',
          input: {
            merchantName: 'Contract Cafe', merchantAddress: null, transactionDate: '2026-07-12',
            currencyCode: 'USD', currencySymbol: '$',
            lineItems: [{ name: 'Coffee', amount: 10, quantity: 1 }],
            subtotal: 10, total: 11, extras: [{ label: 'Tax', amount: 1, kind: 'tax' }],
          },
        }],
      })
    }
    if (init.method === 'POST' && target.includes(':analyze')) {
      return new Response('', {
        status: 202,
        headers: { 'operation-location': 'https://test.cognitiveservices.azure.com/analyzeResults/contract' },
      })
    }
    if (target.includes('/analyzeResults/')) {
      return Response.json({
        status: 'succeeded',
        analyzeResult: { documents: [{ fields: { Total: { valueCurrency: { amount: 11 } } } }] },
      })
    }
    throw new Error(`unexpected provider request: ${init.method} ${target}`)
  }

  const image = new Uint8Array([
    0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08,
    0x02, 0x58, 0x03, 0x20, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ])
  try {
    for (const [route, schemaName] of [
      ['/ocr/dual-scan', 'DualScanEnvelope'],
      ['/ocr/analyze', 'AnalyzeEnvelope'],
    ]) {
      const response = await handleOcr(new Request(`https://fx.resplit.app${route}`, {
        method: 'POST',
        headers: { 'content-type': 'image/jpeg', 'x-resplit-attest-soft-fail': 'true' },
        body: image,
      }), env)
      assert.equal(response.status, 200, route)
      const body = await response.json()
      assert.deepEqual(
        Object.keys(body).sort(),
        [...openapi.components.schemas[schemaName].required].sort(),
        `${route} top-level keys must match its documented required envelope`,
      )
      assert.equal(body.status, 'succeeded')
    }
  } finally {
    globalThis.fetch = realFetch
  }
})
