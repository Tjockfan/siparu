import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { VoyageRow } from '../src/voyage'

export const FIXTURES = path.join(__dirname, 'fixtures')

export function loadFixtureRows(): VoyageRow[] {
  const text = gunzipSync(readFileSync(path.join(FIXTURES, 'season-sample.ndjson.gz'))).toString('utf8')
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as VoyageRow)
}
