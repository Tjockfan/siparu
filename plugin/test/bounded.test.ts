/**
 * The ceiling on a relay answer. The request timeout bounds how long a hostile relay
 * can keep the boat reading; this bounds how much of it ends up in memory.
 */
import { describe, expect, it } from 'vitest'
import { AnswerTooLarge, readBounded, RELAY_ANSWER_MAX_BYTES } from '../src/bounded'

/** A chunked body: `chunks` pieces of `size` bytes each, with no Content-Length. */
function chunked(chunks: number, size: number, onCancel?: () => void) {
  let sent = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent++ < chunks) controller.enqueue(new Uint8Array(size).fill(0x61))
      else controller.close()
    },
    cancel() {
      onCancel?.()
    }
  })
  return new Response(stream, { status: 200 })
}

describe('readBounded', () => {
  it('returns an honest answer whole', async () => {
    const res = new Response('{"keys":"ok","devices":[]}', { status: 200 })
    expect(await readBounded(res)).toBe('{"keys":"ok","devices":[]}')
  })

  it('an empty body is an empty string, not a throw', async () => {
    expect(await readBounded(new Response(null, { status: 204 }))).toBe('')
  })

  it('refuses a declared Content-Length over the ceiling before reading a byte', async () => {
    let pulled = false
    // highWaterMark 0: the stream does not pull ahead on its own, so a pull here is one the
    // reader asked for. It answers with a tiny honest-looking body, so a guard removed fails
    // this case at once rather than waiting out the runner's clock.
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true
          controller.enqueue(new Uint8Array([0x7b, 0x7d]))
          controller.close()
        }
      },
      { highWaterMark: 0 }
    )
    const res = new Response(stream, {
      status: 200,
      headers: { 'content-length': String(RELAY_ANSWER_MAX_BYTES + 1) }
    })
    await expect(readBounded(res)).rejects.toBeInstanceOf(AnswerTooLarge)
    expect(pulled).toBe(false)
  })

  it('a chunked body with no length is abandoned the moment it passes the ceiling', async () => {
    // 1024 chunks of 16 KiB: 16 MiB, finite so that a ceiling removed fails this test rather
    // than hanging the runner. The fifth chunk is the one that crosses the line, and that is
    // where it stops.
    let cancelled = false
    const res = chunked(1024, 16 * 1024, () => (cancelled = true))
    const err = await readBounded(res, 64 * 1024).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AnswerTooLarge)
    expect((err as AnswerTooLarge).bytes).toBe(5 * 16 * 1024)
    expect(cancelled).toBe(true)
  })

  it('a chunked body that stays under the ceiling is read whole', async () => {
    const res = chunked(3, 16 * 1024)
    const text = await readBounded(res, 64 * 1024)
    expect(text.length).toBe(3 * 16 * 1024)
  })

  it('exactly the ceiling is allowed; one byte more is not', async () => {
    expect((await readBounded(new Response('a'.repeat(10)), 10)).length).toBe(10)
    await expect(readBounded(new Response('a'.repeat(11)), 10)).rejects.toBeInstanceOf(AnswerTooLarge)
  })
})
