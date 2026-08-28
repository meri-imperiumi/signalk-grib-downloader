'use strict'

// Smoketests for the boat-centered default download area: when no bbox is
// saved, the plugin derives one from navigation.position (seeded from the
// tree or from the first GPS fix), holds auto downloads briefly while no
// area is known, and falls back to the historical Med box when no position
// ever arrives. A saved bbox is the user's choice and is never moved.
// No network is touched: sources are kept up to date on disk whenever a
// live tick could otherwise fire (same trick as test/index.test.js).

// Shorten the wait-for-first-fix grace period (read at start time).
process.env.GRIB_BBOX_TRACK_TIMEOUT_MS = '50'

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const makePlugin = require('../dist/index.js')
const { expectedRunStamp, fetchFingerprint } = require('../dist/scheduler.js')
const { boatCenteredBbox, FALLBACK_BBOX } = require('../dist/geo.js')

// GFS: the one model whose fetch fingerprint includes the bbox
// (server-side subsetting) — an up-to-date marker proves *which* box the
// orchestrator carries. Matches are pre-written so ticks never fetch.
const AUTO = { model: 'gfs', resolution: '0p25', autoDownload: true }
const MANUAL = { model: 'gfs', resolution: '0p25', autoDownload: false }
const dirOf = (s) => s.resolution ? `${s.model}-${s.resolution}` : s.model
const POSITION_PATH = 'navigation.position'
const INTERNET_STATE_PATH = 'network.internet.state'

const HELSINKI = { latitude: 60.2, longitude: 24.9 }
const TAHITI = { latitude: -17.65, longitude: -149.45 }
const USER_BOX = { latMin: 54, lonMin: 10, latMax: 60, lonMax: 20 }

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'grib-bbox-'))

// Mock Signal K server with just the surface the plugin host touches,
// extended to serve navigation.position from tree and stream.
const makeServer = (dataDir, { seedPosition } = {}) => {
  const streams = {} // path → [handlers]
  const debugs = []
  return {
    debugs,
    getSelfPath: (p) => (p === POSITION_PATH ? seedPosition : undefined),
    streambundle: {
      getSelfStream: (p) => ({
        onValue: (fn) => {
          ;(streams[p] ??= []).push(fn)
          return () => { streams[p] = (streams[p] ?? []).filter(f => f !== fn) }
        },
      }),
    },
    setPluginStatus: () => {},
    debug: (msg) => debugs.push(String(msg)),
    getDataDirPath: () => dataDir,
    publishPosition: (v) => (streams[POSITION_PATH] ?? []).forEach(fn => fn(v)),
  }
}

const makeRouter = () => {
  const routes = {}
  const router = {
    get: (p, h) => { routes[`GET ${p}`] = h },
    put: (p, h) => { routes[`PUT ${p}`] = h },
    post: (p, h) => { routes[`POST ${p}`] = h },
    delete: (p, h) => { routes[`DELETE ${p}`] = h },
  }
  return { router, call: (method, p, body) => {
    let payload
    const res = {
      status: () => res,
      json: (v) => { payload = v },
    }
    routes[`${method} ${p}`]({ body, params: {} }, res)
    return payload
  } }
}

// An up-to-date marker fingerprinted for `box`, so a tick that fires finds
// nothing to download and never touches the network.
const writeUpToDateMarker = (root, box, source = AUTO) => {
  const dir = path.join(root, dirOf(source))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `.run-${expectedRunStamp(source.model)}.complete`),
    JSON.stringify({ params: fetchFingerprint(source, box) })
  )
}

const readSavedBbox = (dataDir) => {
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf-8'))
  return raw.bbox
}

const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms))

const startPlugin = ({ settings, seedPosition, prepare, source = AUTO } = {}) => {
  const dataDir = tmpDir()
  const gribsRoot = tmpDir()
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings ?? { sources: [source] }))
  if (prepare) prepare(gribsRoot)
  const server = makeServer(dataDir, { seedPosition })
  const plugin = makePlugin(server)
  const { router, call } = makeRouter()
  plugin.registerWithRouter(router)
  plugin.start({ gribsRoot })
  return { plugin, server, call, gribsRoot, dataDir, stop: () => plugin.stop() }
}

test('seeded position derives a boat-centered box; nothing is persisted', async () => {
  const box = boatCenteredBbox(HELSINKI.latitude, HELSINKI.longitude)
  const t = startPlugin({ seedPosition: HELSINKI, prepare: r => writeUpToDateMarker(r, box) })
  try {
    await settle()
    const status = t.call('GET', '/status')
    // The orchestrator's fetch fingerprint matches the derived box —
    // proven by the marker being considered up to date.
    assert.strictEqual(status.sources[0].upToDate, true)
    assert.strictEqual(status.sources[0].configStale, false)
    // Derived defaults are never persisted or exposed as user settings.
    assert.strictEqual(t.call('GET', '/settings').bbox, undefined)
    assert.strictEqual(readSavedBbox(t.dataDir), undefined)
  } finally {
    t.stop()
  }
})

test('no position at all: auto holds briefly, then falls back to the Med box', async () => {
  const t = startPlugin({ prepare: r => writeUpToDateMarker(r, FALLBACK_BBOX) })
  try {
    // Within the grace period nothing is scheduled (no area known).
    await settle(10)
    let status = t.call('GET', '/status')
    assert.strictEqual(status.nextAutoTickAt, null)
    assert.strictEqual(status.sources[0].lastOutcome, null)

    // After the timeout the fallback area applies and the scheduler runs.
    await settle(120)
    status = t.call('GET', '/status')
    assert.notStrictEqual(status.nextAutoTickAt, null)
    assert.strictEqual(status.sources[0].upToDate, true)
    assert.strictEqual(status.sources[0].lastOutcome, null) // no download needed
    assert.ok(t.server.debugs.some(m => m.includes('Mediterranean fallback')))
    assert.strictEqual(readSavedBbox(t.dataDir), undefined)
  } finally {
    t.stop()
  }
})

test('first GPS fix after start derives the box; the fallback never fires', async () => {
  const box = boatCenteredBbox(TAHITI.latitude, TAHITI.longitude)
  const t = startPlugin({
    source: MANUAL, // keep the auto scheduler out of the picture
    prepare: r => writeUpToDateMarker(r, FALLBACK_BBOX),
  })
  try {
    t.server.publishPosition(TAHITI)
    await settle(120) // beyond the 50 ms fallback timeout
    const status = t.call('GET', '/status')
    // Med-fingerprinted marker is stale under the Tahiti box → the
    // orchestrator was rebuilt with the derived box.
    assert.strictEqual(status.sources[0].configStale, true)
    assert.strictEqual(status.sources[0].upToDate, false)
    assert.ok(t.server.debugs.some(m => m.includes('centered on the boat')))
    assert.ok(!t.server.debugs.some(m => m.includes('Mediterranean fallback')))
    assert.strictEqual(readSavedBbox(t.dataDir), undefined)
  } finally {
    t.stop()
  }
})

test('only the first fix counts — later fixes do not move the default', async () => {
  const first = boatCenteredBbox(TAHITI.latitude, TAHITI.longitude)
  const t = startPlugin({
    source: MANUAL,
    prepare: r => writeUpToDateMarker(r, first),
  })
  try {
    t.server.publishPosition(TAHITI)
    await settle()
    let status = t.call('GET', '/status')
    assert.strictEqual(status.sources[0].upToDate, true) // box == first fix

    t.server.publishPosition(HELSINKI) // a later, far-away fix
    await settle()
    status = t.call('GET', '/status')
    assert.strictEqual(status.sources[0].upToDate, true) // box unchanged
  } finally {
    t.stop()
  }
})

test('a saved user bbox is never moved by position fixes', async () => {
  const t = startPlugin({
    settings: { bbox: USER_BOX, sources: [MANUAL] },
    seedPosition: HELSINKI,
    prepare: r => writeUpToDateMarker(r, USER_BOX),
  })
  try {
    await settle()
    let status = t.call('GET', '/status')
    assert.strictEqual(status.sources[0].upToDate, true)

    t.server.publishPosition(TAHITI)
    await settle()
    status = t.call('GET', '/status')
    assert.strictEqual(status.sources[0].upToDate, true) // still the user box
    assert.deepStrictEqual(t.call('GET', '/settings').bbox, USER_BOX)
    assert.deepStrictEqual(readSavedBbox(t.dataDir), USER_BOX)
  } finally {
    t.stop()
  }
})

test('saving a bbox via PUT stops deriving; a later fix changes nothing', async () => {
  const t = startPlugin({ source: MANUAL })
  try {
    await settle()
    assert.strictEqual(t.call('GET', '/settings').bbox, undefined) // still tracking

    t.call('PUT', '/settings', { bbox: USER_BOX, sources: [MANUAL] })
    assert.deepStrictEqual(readSavedBbox(t.dataDir), USER_BOX)

    writeUpToDateMarker(t.gribsRoot, USER_BOX, MANUAL)
    t.server.publishPosition(TAHITI)
    await settle()
    const status = t.call('GET', '/status')
    assert.strictEqual(status.sources[0].upToDate, true) // user box rules
    assert.deepStrictEqual(readSavedBbox(t.dataDir), USER_BOX)
  } finally {
    t.stop()
  }
})

test('legacy default Med box in settings.json is dropped and replaced by the boat default', async () => {
  // Older versions persisted the default Med box into settings.json on
  // every load — that box was never a user choice.
  const box = boatCenteredBbox(HELSINKI.latitude, HELSINKI.longitude)
  const t = startPlugin({
    settings: { bbox: { ...FALLBACK_BBOX }, sources: [MANUAL] },
    seedPosition: HELSINKI,
    prepare: r => writeUpToDateMarker(r, box),
  })
  try {
    await settle()
    assert.strictEqual(t.call('GET', '/status').sources[0].upToDate, true) // derived box used
    assert.strictEqual(readSavedBbox(t.dataDir), undefined) // and cleaned from disk
  } finally {
    t.stop()
  }
})

test('stop() unsubscribes the position stream', async () => {
  const t = startPlugin({ source: MANUAL })
  t.stop()
  // No throw, and a fix after stop changes nothing on disk.
  t.server.publishPosition(TAHITI)
  await settle()
  assert.strictEqual(readSavedBbox(t.dataDir), undefined)
})
