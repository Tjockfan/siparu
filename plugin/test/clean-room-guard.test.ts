/**
 * The clean-room guard, held to what it is advertised to catch.
 *
 * This repository is public and is meant to read as one product written by one team in
 * one language. That was enforced for months by two gates on a single maintainer's disk,
 * so a push from anywhere else met nothing. The CI step exists to close that, and it is a
 * grep, which is the kind of check that dies silently: widen one character and it still
 * exits zero on a clean tree and still says nothing when what it was written for walks
 * past. Same reasoning as readonly-guard.test.ts, same shape of test.
 *
 * The patterns are lifted out of the workflow rather than restated here, so what CI runs
 * is what is tested.
 *
 * Every forbidden thing in this file is written as an escape or a concatenation. A test
 * that spelled them out would be caught by the very step it is testing, which is a way of
 * discovering the guard works that nobody enjoys twice.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CI_YML = join(__dirname, '..', '..', '.github', 'workflows', 'ci.yml')
const STEP_NAME = 'Clean-room - the checkout reads as one professional English product'

/** The step's body, or a loud failure: a deleted guard must not read as a quiet one. */
function step(): string {
  const yml = readFileSync(CI_YML, 'utf8')
  const found = yml.split(/^      - name: /m).find((s) => s.startsWith(STEP_NAME))
  if (!found) throw new Error(`no CI step named "${STEP_NAME}" - was it renamed or removed?`)
  return found
}

/**
 * The alternation the step hands grep, as a JavaScript RegExp.
 *
 * The shell builds it from four variables, three of them printf escapes so the workflow
 * file does not contain the characters it forbids. Those escapes are resolved here the
 * same way the shell resolves them, which is the point: a pattern that no longer matches
 * what it claims to should fail here rather than on a release.
 */
function pattern(): RegExp {
  const body = step()
  const parts = ['TR', 'EM', 'BOT'].map((name) => {
    const m = new RegExp(`${name}=\\$\\(printf '([^']+)'\\)`).exec(body)
    if (!m) throw new Error(`the step no longer builds ${name}`)
    // Both spellings printf takes: \uXXXX and, for anything above the basic plane,
    // \UXXXXXXXX. Reading only the lower-case one leaves the emoji escape unresolved
    // and the pattern then hunts for the literal text of its own definition.
    return m[1]!.replace(/\\[uU]([0-9a-fA-F]{4,8})/g, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
  })

  const ai = /AI="([^"]+)"/.exec(body)
  if (!ai) throw new Error('the step no longer looks for a machine signature')

  const joined = /grep -lIE "([^"]+)"/.exec(body)
  if (!joined) throw new Error('the step no longer greps the checkout')
  // The variables the shell would expand, in the order the step composes them.
  const expanded = joined[1]!
    .replace('$TR', parts[0]!)
    .replace('$EM', parts[1]!)
    .replace('$BOT', parts[2]!)
    .replace('$AI', ai[1]!)
  return new RegExp(expanded)
}

/** A letter no English word carries, so its presence means the text is not English. */
const FOREIGN_LETTER = '\u0131'
const EM_DASH = '\u2014'
const ROBOT = '\u{1F916}'
const NAME = 'C' + 'laude'

describe('the clean-room guard', () => {
  it.each([
    [`a note left in another language: b${FOREIGN_LETTER}r`, 'prose that is not English'],
    [`the gauge ${EM_DASH} and the reading beside it`, 'an em dash, the tell of generated prose'],
    [`Co-Authored-By: ${NAME} Opus`, 'a machine co-author on a commit'],
    [`${NAME}-Session: https://example.invalid/session`, 'a session link in a commit trailer'],
    [`Generated with [${NAME} Code]`, 'the generator naming itself'],
    [`fixed the thing ${ROBOT}`, 'the robot emoji that rides along with it']
  ])('catches %j (%s)', (line) => {
    expect(pattern().test(line)).toBe(true)
  })

  it.each([
    'The plugin is read-only by design and never writes to the vessel.',
    "router.post('/pair/start', sameOrigin(handler))",
    'A relay that answered and said no. Distinct from one that never answered at all.',
    '  - name: Runtime purity - no value imports from devDependencies'
  ])('leaves %j alone', (line) => {
    expect(pattern().test(line)).toBe(false)
  })

  it('reads the whole checkout, not one directory somebody remembered', () => {
    expect(step()).toContain('git ls-files')
  })

  /**
   * The step must not be able to pass by finding nothing. A pattern that matches nothing,
   * or a file listing that comes back empty, exits zero and reads exactly like a clean
   * tree; the probe and the file count are what make its silence mean something. Pinned
   * here because deleting them changes no behaviour on a clean tree, which is the kind of
   * edit that survives review.
   */
  it('earns its silence: it proves the pattern bites and the listing is not empty', () => {
    const body = step()
    expect(body).toContain('probe=')
    expect(body).toMatch(/grep -qE "\$TR\|\$EM\|\$BOT"/)
    expect(body).toMatch(/grep -qE "\$AI"/)
    expect(body).toMatch(/scanned=\$\(git ls-files \| wc -l\)/)
  })

  /**
   * The step forbids characters and words that it must therefore not contain. It is
   * itself part of `git ls-files`, so getting this wrong makes every build fail on the
   * guard's own file, and the temptation would then be to exclude the file rather than
   * fix the escaping.
   */
  it('cannot report itself', () => {
    expect(pattern().test(readFileSync(CI_YML, 'utf8'))).toBe(false)
  })
})
