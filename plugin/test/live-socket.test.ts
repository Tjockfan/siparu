/**
 * The real socket, against a real `ws` server on the loopback. The fake socket next
 * door proves what the uplink does with a message; this proves what the wire refuses to
 * hand it in the first place: a frame past the ceiling closes the socket with 1009 before it
 * is ever assembled, and compression is never negotiated.
 */
import { once } from 'node:events'
import { AddressInfo } from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { LiveUplink, SHORE_MESSAGE_MAX_BYTES } from '../src/live'

const REMOTE = { boatToken: 'tok-1', boatId: 'boat-1', pairedAt: '2026-07-10T00:00:00Z' }

let server: WebSocketServer | undefined
let live: LiveUplink | undefined
/** What the uplink said to its log while the case ran. */
let said: string[] = []

afterEach(async () => {
  live?.stop()
  live = undefined
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
})

/** A relay on the loopback, and the boat's socket to it once the upgrade has happened. */
async function connected() {
  said = []
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  const arrived = new Promise<{ sock: WebSocket; extensions: string | undefined }>((resolve) =>
    server!.on('connection', (sock, req) =>
      resolve({ sock, extensions: req.headers['sec-websocket-extensions'] })
    )
  )
  live = new LiveUplink({
    relayUrl: `http://127.0.0.1:${port}`,
    getRemote: () => REMOTE,
    frame: () => ({ ts: 1 }),
    seal: (frame) => ({ mode: 'sealed' as const, frame }),
    sealAnswer: (payload, id) => ({ mode: 'sealed' as const, frame: { id, payload } }),
    debug: (line) => said.push(line)
    // No `connect`: the real one, with the real options.
  })
  live.start()
  return arrived
}

const closedWith = (sock: WebSocket) => new Promise<number>((resolve) => sock.on('close', resolve))

describe('the shore socket', () => {
  it('never negotiates compression', async () => {
    const { extensions } = await connected()
    expect(extensions ?? '').not.toMatch(/permessage-deflate/)
  })

  it('takes a message under the ceiling and stays up', async () => {
    const { sock } = await connected()
    let closed = false
    sock.on('close', () => (closed = true))
    sock.send('x'.repeat(SHORE_MESSAGE_MAX_BYTES - 1024))
    // Long enough for a refusal to have come back; the close in the next case takes under
    // 50 ms on the loopback.
    await new Promise((r) => setTimeout(r, 200))
    expect(closed).toBe(false)
    expect(sock.readyState).toBe(WebSocket.OPEN)
  })

  it('refuses a message past the ceiling and drops the line, without assembling it', async () => {
    const { sock } = await connected()
    const code = closedWith(sock)
    sock.send('x'.repeat(SHORE_MESSAGE_MAX_BYTES + 1024))
    // Raced against a clock so that a ceiling removed fails this at once, with a reason,
    // rather than on the runner's timeout.
    const outcome = await Promise.race([
      code,
      new Promise<string>((r) => setTimeout(() => r('still open after 2 s'), 2000))
    ])
    // The ceiling is ws's, and ws names it when it trips. This is the proof that the frame
    // was refused by size rather than by anything else that drops a socket.
    expect(said.join('\n')).toMatch(/Max payload size exceeded/)
    // ws writes a 1009 close frame and the uplink then terminates the socket on the error,
    // so the frame races the reset. Linux and macOS hand the relay the frame before the
    // reset; Windows discards it and reports 1006. Either way the line is down and the
    // message was never assembled, which is the behaviour this case pins.
    expect([1009, 1006]).toContain(outcome)
  })
})
