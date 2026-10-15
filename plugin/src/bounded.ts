/**
 * Reading a relay answer with a ceiling on its size.
 *
 * Every HTTP answer the boat takes from the shore is small: a pairing receipt, a key
 * verdict with the screens it may seal to. `res.json()` and `res.text()` have no ceiling at
 * all, so a relay that has been taken over, or a proxy in front of it, could answer with a
 * chunked body that never ends and have the Signal K process on a Cerbo GX or a Pi grow until
 * the kernel kills it. The request timeout bounds how LONG that takes, not how much memory it
 * takes. This bounds the memory.
 *
 * The socket has its own ceiling (`maxPayload` in live.ts); this is the HTTP half of the same
 * defence, and one without the other leaves a door open.
 */

/** The most the boat will read of any relay answer, in bytes. Generous: the largest honest
 *  answer is the key sync's device list, a few kilobytes. */
export const RELAY_ANSWER_MAX_BYTES = 64 * 1024

/** The relay's answer was larger than this boat will read. Not a connectivity problem. */
export class AnswerTooLarge extends Error {
  constructor(readonly bytes: number, readonly limit: number) {
    super(`relay answer exceeds ${limit} bytes (${bytes} seen)`)
    this.name = 'AnswerTooLarge'
  }
}

/**
 * The body of `res` as text, or a throw once it has grown past `max` bytes.
 *
 * A declared Content-Length over the ceiling is refused before a byte is read. A body without
 * one (chunked, which is what an attacker would send) is read a chunk at a time and abandoned
 * the moment the running total passes the ceiling: the stream is cancelled so the connection
 * is not left draining into the void.
 */
export async function readBounded(res: Response, max = RELAY_ANSWER_MAX_BYTES): Promise<string> {
  const declared = res.headers.get('content-length')
  if (declared !== null) {
    const n = Number(declared)
    if (Number.isFinite(n) && n > max) throw new AnswerTooLarge(n, max)
  }
  if (!res.body) return ''

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw new AnswerTooLarge(total, max)
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}
