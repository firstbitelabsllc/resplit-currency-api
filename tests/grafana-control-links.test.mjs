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

test('every Grafana panel is scoped to Resplit FX telemetry', () => {
  for (const panel of dashboard.panels) {
    for (const target of panel.targets) {
      const query = target.expr ?? target.query ?? ''
      assert.match(
        query,
        /(?:service_name|resource\.service\.name)\s*=\s*"resplit-fx"/,
        `${panel.title} is not scoped to Resplit FX telemetry`,
      )
    }
  }
})

test('Resplit operator dashboard links every canonical control surface', () => {
  const links = new Map(dashboard.links.map(link => [link.title, link.url]))

  assert.equal(links.get('iOS behavior — Live Split'), 'https://us.posthog.com/project/43661/dashboard/1814794')
  assert.equal(links.get('iOS activation'), 'https://us.posthog.com/project/43661/dashboard/1814792')
  assert.equal(links.get('Launch pulse'), 'https://us.posthog.com/project/43661/dashboard/1814769')
  assert.equal(
    links.get('iOS project — Sentry'),
    'https://firstbite-labs.sentry.io/projects/resplit-ios/',
  )
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
    links.get('iOS distribution — App Store Connect'),
    'https://appstoreconnect.apple.com/apps/6466376742/testflight/ios',
  )
  assert.equal(
    links.get('Local iOS Support cockpit'),
    'resplit://support-diagnostics',
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

test('local cockpit route is exact and payload-free', () => {
  const link = dashboard.links.find(candidate => candidate.title === 'Local iOS Support cockpit')

  assert.ok(link, 'local cockpit link is missing')
  const url = new URL(link.url)
  assert.equal(url.protocol, 'resplit:')
  assert.equal(url.hostname, 'support-diagnostics')
  assert.equal(url.pathname, '')
  assert.equal(url.search, '')
  assert.equal(url.hash, '')
  assert.equal(url.username, '')
  assert.equal(url.password, '')
})
