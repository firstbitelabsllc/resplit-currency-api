const fs = require('fs-extra')
const path = require('path')

const indent = '\t'
const apiVersion = 1
const rootDir = path.join(__dirname, 'package', `v${apiVersion}`)

main()

async function main() {
  const dateToday = new Date().toISOString().substring(0, 10)
  const rates = await fetchRates()
  if (!rates || Object.keys(rates).length === 0) {
    throw new Error('Failed to fetch currency rates from any source')
  }

  console.log(`Fetched ${Object.keys(rates).length} currencies for ${dateToday}`)

  const currenciesDir = path.join(rootDir, 'currencies')
  fs.mkdirSync(currenciesDir, { recursive: true })

  const currList = {}
  for (const key of Object.keys(rates).sort()) {
    currList[key] = ''
  }
  fs.writeFileSync(path.join(rootDir, 'currencies.json'), JSON.stringify(currList, null, indent))
  fs.writeFileSync(path.join(rootDir, 'currencies.min.json'), JSON.stringify(currList))

  for (const [fromCode, fromRate] of Object.entries(rates)) {
    const output = { date: dateToday }
    output[fromCode] = {}

    for (const [toCode, toRate] of Object.entries(rates)) {
      output[fromCode][toCode] = significantNum(toRate / fromRate)
    }

    fs.writeFileSync(path.join(currenciesDir, `${fromCode}.json`), JSON.stringify(output, null, indent))
    fs.writeFileSync(path.join(currenciesDir, `${fromCode}.min.json`), JSON.stringify(output))
  }

  const semverDate = dateToday.replaceAll('-', '.')
  const pkg = fs.readJsonSync(path.join(__dirname, 'skeleton-package.json'))
  pkg.version = semverDate
  fs.writeJsonSync(path.join(rootDir, '..', 'package.json'), pkg)
  fs.writeFileSync(path.join(rootDir, '..', 'index.js'), '')

  fs.copyFileSync(path.join(__dirname, 'country.json'), path.join(rootDir, 'country.json'))

  console.log(`Generated files in ${rootDir}`)
}

async function fetchRates() {
  // Primary: open.er-api.com — free, ~160 fiat currencies, no API key
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/EUR', { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    }
    const data = await res.json()
    if (data.result === 'success' && data.rates) {
      return toLowerSorted(data.rates)
    }
  } catch (e) {
    console.error('Primary source (open.er-api.com) failed:', e.message)
  }

  return null
}

function toLowerSorted(obj) {
  const entries = Object.entries(obj)
    .map(([k, v]) => [k.toLowerCase(), parseFloat(v)])
    .filter(([, v]) => Number.isFinite(v) && v > 0)
    .sort(([a], [b]) => a.localeCompare(b))
  return Object.fromEntries(entries)
}

function significantNum(num) {
  if (!Number.isFinite(num) || num <= 0) return 0
  const minDigits = 8
  if (num >= 0.1) return parseFloat(num.toFixed(minDigits))
  const str = num.toFixed(100)
  const zeros = str.match(/^0\.0+/i)[0].length - 2
  return parseFloat(num.toFixed(minDigits + zeros))
}
