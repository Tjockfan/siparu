import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chartContentType, resolveMapConfig, safeChartPath } from '../src/charts'
import { resolveOptions } from '../src/config'

const REMOTE = 'https://tiles.example.com'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'siparu-charts-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('resolveMapConfig', () => {
  it('falls back to the remote server when the charts folder is empty', () => {
    const cfg = resolveMapConfig(dir, REMOTE)
    expect(cfg.basemap).toBe(`${REMOTE}/basemap.pmtiles`)
    expect(cfg.seamark).toBe(`${REMOTE}/seamark.pmtiles`)
    expect(cfg.glyphs).toBe(`${REMOTE}/fonts/{fontstack}/{range}.pbf`)
    expect(cfg.sprite).toBe(`${REMOTE}/sprites`)
    expect(cfg.local).toEqual({ basemap: false, seamark: false, fonts: false, sprites: false })
  })

  it('prefers local files, per asset kind independently', async () => {
    await fs.mkdir(path.join(dir, 'charts', 'fonts'), { recursive: true })
    await fs.writeFile(path.join(dir, 'charts', 'basemap.pmtiles'), 'x')
    const cfg = resolveMapConfig(dir, REMOTE)
    expect(cfg.basemap).toBe('/plugins/siparu/charts/basemap.pmtiles')
    expect(cfg.seamark).toBe(`${REMOTE}/seamark.pmtiles`)
    expect(cfg.glyphs).toBe('/plugins/siparu/charts/fonts/{fontstack}/{range}.pbf')
    expect(cfg.sprite).toBe(`${REMOTE}/sprites`)
    expect(cfg.local).toEqual({ basemap: true, seamark: false, fonts: true, sprites: false })
  })

  it('a directory named basemap.pmtiles does not count as a local chart', async () => {
    await fs.mkdir(path.join(dir, 'charts', 'basemap.pmtiles'), { recursive: true })
    const cfg = resolveMapConfig(dir, REMOTE)
    expect(cfg.basemap).toBe(`${REMOTE}/basemap.pmtiles`)
  })
})

describe('safeChartPath', () => {
  const charts = () => path.join(dir, 'charts')

  it('resolves plain and nested paths inside the charts dir', () => {
    expect(safeChartPath(dir, 'basemap.pmtiles')).toBe(path.join(charts(), 'basemap.pmtiles'))
    expect(safeChartPath(dir, 'fonts/Noto Sans Regular/0-255.pbf')).toBe(
      path.join(charts(), 'fonts', 'Noto Sans Regular', '0-255.pbf')
    )
    expect(safeChartPath(dir, 'fonts/Noto%20Sans%20Regular/0-255.pbf')).toBe(
      path.join(charts(), 'fonts', 'Noto Sans Regular', '0-255.pbf')
    )
  })

  it('rejects traversal, absolute paths, null bytes and bad encodings', () => {
    expect(safeChartPath(dir, '../secrets.json')).toBeNull()
    expect(safeChartPath(dir, '..%2F..%2Fetc%2Fpasswd.json')).toBeNull()
    expect(safeChartPath(dir, 'fonts/../../store.json')).toBeNull()
    expect(safeChartPath(dir, '/etc/passwd.json')).toBeNull()
    expect(safeChartPath(dir, 'a\0b.pmtiles')).toBeNull()
    expect(safeChartPath(dir, 'x%ZZ.pmtiles')).toBeNull()
  })

  it('rejects extensions outside the chart asset allowlist', () => {
    expect(safeChartPath(dir, 'notes.txt')).toBeNull()
    expect(safeChartPath(dir, 'run.sh')).toBeNull()
    expect(safeChartPath(dir, 'basemap')).toBeNull()
  })
})

describe('chartContentType', () => {
  it('pins types express would not guess', () => {
    expect(chartContentType('/x/basemap.pmtiles')).toBe('application/octet-stream')
    expect(chartContentType('/x/0-255.pbf')).toBe('application/x-protobuf')
    expect(chartContentType('/x/sprite.json')).toBeUndefined()
    expect(chartContentType('/x/sprite.png')).toBeUndefined()
  })
})

describe('config: chartsRemoteUrl', () => {
  it('defaults, trims trailing slashes, rejects junk', () => {
    expect(resolveOptions({}).chartsRemoteUrl).toBe('https://tiles.siparu.app')
    expect(resolveOptions({ chartsRemoteUrl: 'https://x.example//' }).chartsRemoteUrl).toBe('https://x.example')
    expect(resolveOptions({ chartsRemoteUrl: 'ftp://nope' }).chartsRemoteUrl).toBe('https://tiles.siparu.app')
    expect(resolveOptions({ chartsRemoteUrl: 'not a url' }).chartsRemoteUrl).toBe('https://tiles.siparu.app')
  })
})
