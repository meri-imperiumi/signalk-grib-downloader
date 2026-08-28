import { Bbox } from './types'

// Last-resort download area when no bbox is saved and no boat position is
// known — the historical default (western Mediterranean).
export const FALLBACK_BBOX: Bbox = { latMin: 35, lonMin: -6, latMax: 45, lonMax: 17 }

// Default box around the boat: a "near-coastal" ±3° lat / ±4° lon span —
// small enough to keep the first (bbox-controlled, GFS) download cheap,
// large enough for a day or two of sailing. The webapp mirrors this
// computation (public/index.html boatCenteredBbox) — keep them in sync
// (test/webapp.test.js asserts both agree).
const HALF_SPAN_LAT = 3
const HALF_SPAN_LON = 4

// Keep the box clear of the poles (GRIB subsetting degenerates there):
// clamping the center to ±82 keeps the edges within ±85.
const MAX_CENTER_LAT = 82

export function boatCenteredBbox(lat: number, lon: number): Bbox {
  const cLat = Math.min(MAX_CENTER_LAT, Math.max(-MAX_CENTER_LAT, lat))
  const cLon = ((lon + 540) % 360) - 180 // wrap to [-180, 180)
  const round = (n: number): number => Math.round(n * 1e6) / 1e6 // GPS floats, not modulo noise
  return {
    latMin: round(cLat - HALF_SPAN_LAT),
    latMax: round(cLat + HALF_SPAN_LAT),
    // No antimeridian-crossing boxes: clamp the edges so the box stays a
    // contiguous in-range rectangle (the GFS subregion query needs
    // lonMin < lonMax in the negative-west convention).
    lonMin: round(Math.max(-180, cLon - HALF_SPAN_LON)),
    lonMax: round(Math.min(180, cLon + HALF_SPAN_LON)),
  }
}

// True when b is exactly the historical default — the box older versions
// persisted into settings.json on every load (their DEFAULT_APP_SETTINGS
// carried it), before "no bbox saved" was representable. Used as a
// one-time migration so existing installs start deriving from the boat.
export function isFallbackBbox(b: Bbox | undefined): boolean {
  return b !== undefined &&
    b.latMin === FALLBACK_BBOX.latMin && b.lonMin === FALLBACK_BBOX.lonMin &&
    b.latMax === FALLBACK_BBOX.latMax && b.lonMax === FALLBACK_BBOX.lonMax
}
