'use strict'

// Unit tests for the boat-centered default download area (src/geo.ts).

const { test } = require('node:test')
const assert = require('node:assert')
const { boatCenteredBbox, FALLBACK_BBOX, isFallbackBbox } = require('../dist/geo.js')

test('basic box is ±3° lat / ±4° lon around the boat', () => {
  assert.deepStrictEqual(boatCenteredBbox(60.2, 24.9), {
    latMin: 57.2, latMax: 63.2, lonMin: 20.9, lonMax: 28.9,
  })
  assert.deepStrictEqual(boatCenteredBbox(-17.65, -149.45), {
    latMin: -20.65, latMax: -14.65, lonMin: -153.45, lonMax: -145.45,
  })
})

test('center latitude clamps so the box stays clear of the poles', () => {
  // 89° clamps to 82 → edges 79..85, never past ±85
  assert.deepStrictEqual(boatCenteredBbox(89, 0), { latMin: 79, latMax: 85, lonMin: -4, lonMax: 4 })
  assert.deepStrictEqual(boatCenteredBbox(-89, 0), { latMin: -85, latMax: -79, lonMin: -4, lonMax: 4 })
  assert.strictEqual(boatCenteredBbox(90, 0).latMax, 85)
})

test('longitude wraps to [-180, 180]', () => {
  assert.deepStrictEqual(boatCenteredBbox(0, 190), { latMin: -3, latMax: 3, lonMin: -174, lonMax: -166 })
  assert.deepStrictEqual(boatCenteredBbox(0, -190), { latMin: -3, latMax: 3, lonMin: 166, lonMax: 174 })
})

test('no antimeridian-crossing boxes: edges clamp to [-180, 180]', () => {
  // 177 + 4 = 181 → clamped to 180 (narrower box, still contiguous)
  const east = boatCenteredBbox(0, 177)
  assert.deepStrictEqual(east, { latMin: -3, latMax: 3, lonMin: 173, lonMax: 180 })
  const west = boatCenteredBbox(0, -177)
  assert.deepStrictEqual(west, { latMin: -3, latMax: 3, lonMin: -180, lonMax: -173 })
})

test('isFallbackBbox recognizes exactly the historical default', () => {
  assert.strictEqual(isFallbackBbox(FALLBACK_BBOX), true)
  assert.strictEqual(isFallbackBbox({ latMin: 35, lonMin: -6, latMax: 45, lonMax: 17 }), true)
  assert.strictEqual(isFallbackBbox(undefined), false)
  assert.strictEqual(isFallbackBbox({ latMin: 35, lonMin: -6, latMax: 45, lonMax: 17.5 }), false)
  assert.strictEqual(isFallbackBbox({ latMin: 34, lonMin: -6, latMax: 45, lonMax: 17 }), false)
})
