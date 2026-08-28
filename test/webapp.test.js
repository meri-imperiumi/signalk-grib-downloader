'use strict'

// Webapp smoketest: the inline script in public/index.html stays syntact
// ically valid and keeps the boat-centered-default machinery intact. The
// client-side boatCenteredBbox must agree with the server's
// (src/geo.ts) — the two are maintained in parallel on purpose (vanilla
// JS, no build step), so we assert they produce identical boxes.

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const { boatCenteredBbox: serverBox } = require('../dist/geo.js')

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8')
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])
const script = scripts[scripts.length - 1] // the inline app script (others carry src=)

test('inline script is syntactically valid JavaScript', () => {
  assert.ok(script.length > 1000, 'inline script extracted')
  const tmp = path.join(os.tmpdir(), `grib-webapp-${process.pid}.js`)
  fs.writeFileSync(tmp, script)
  try {
    const check = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf-8' })
    assert.strictEqual(check.status, 0, `node --check failed:\n${check.stderr}`)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
})

test('boat-centered default machinery is present', () => {
  for (const name of [
    'boatCenteredBbox', 'FALLBACK_BBOX', 'boatPosition', 'updateBoatMarker',
    'btn-center-boat', 'centerOnBoat', 'noPosition', 'navigation.position',
  ]) {
    assert.ok(script.includes(name) || html.includes(name), `missing: ${name}`)
  }
  assert.ok(html.includes('id="btn-center-boat"'), 'center-on-boat button in markup')
})

test('client boatCenteredBbox agrees with the server implementation', () => {
  const fnMatch = script.match(/function boatCenteredBbox[\s\S]*?\n}/)
  assert.ok(fnMatch, 'client boatCenteredBbox found')
  // eslint-disable-next-line no-eval
  const clientBox = eval(`(${fnMatch[0].replace('function boatCenteredBbox', 'function')})`)
  const points = [
    [60.2, 24.9], [-17.65, -149.45],
    [89, 0], [-89, 0], [82, 3], [0, 179.5], [0, -179.5],
    [5, 190], [5, -190], [0.1, 0.1],
  ]
  for (const [lat, lon] of points) {
    assert.deepStrictEqual(
      clientBox(lat, lon),
      serverBox(lat, lon),
      `client/server box mismatch at ${lat}, ${lon}`
    )
  }
})
