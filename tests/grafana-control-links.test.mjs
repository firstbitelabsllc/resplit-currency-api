import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const dashboard = JSON.parse(
  readFileSync(new URL('../grafana/dashboards/resplit-fx-observability.json', import.meta.url), 'utf8'),
)

test('Resplit operator dashboard keeps provider scopes explicit', () => {
  assert.equal(dashboard.uid, 'resplit-fx-observability')
  assert.match(dashboard.description, /FX Worker telemetry only/)
  assert.match(dashboard.description, /PostHog/)
  assert.match(dashboard.description, /Sentry/)
})

test('Resplit operator dashboard links every canonical control surface', () => {
  const links = new Map(dashboard.links.map(link => [link.title, link.url]))

  assert.equal(links.get('iOS behavior — Live Split'), 'https://us.posthog.com/project/43661/dashboard/1814794')
  assert.equal(links.get('iOS activation'), 'https://us.posthog.com/project/43661/dashboard/1814792')
  assert.equal(links.get('Launch pulse'), 'https://us.posthog.com/project/43661/dashboard/1814769')
  assert.equal(
    links.get('iOS issues — Sentry'),
    'https://firstbite-labs.sentry.io/issues/?project=4506001574461440',
  )
  assert.equal(
    links.get('iOS releases — Sentry'),
    'https://firstbite-labs.sentry.io/releases/?project=4506001574461440',
  )
  assert.equal(
    links.get('iOS logs — Sentry'),
    'https://firstbite-labs.sentry.io/explore/logs/?project=4506001574461440',
  )
  assert.equal(
    links.get('Fleet Workers'),
    'https://firstbitelabs.grafana.net/d/fleet-workers-otel-overview/fleet-workers-otel-overview',
  )
  assert.equal(links.get('All Grafana dashboards'), 'https://firstbitelabs.grafana.net/dashboards')
  assert.equal(links.has('Open mission plan'), false)
})

test('every control link opens separately and has an operator tooltip', () => {
  for (const link of dashboard.links) {
    assert.equal(link.type, 'link')
    assert.equal(link.targetBlank, true)
    assert.ok(link.tooltip.length > 0, `${link.title} is missing its scope tooltip`)
  }
})
