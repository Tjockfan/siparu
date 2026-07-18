/**
 * Where the boat keeps her relay credential.
 *
 * NOT in the plugin's options. Signal K serves plugin options wholesale over
 * GET /plugins/<id>/config and embeds them again in GET /skServer/plugins, and
 * with security off - the default install - both answer anyone on the boat's
 * network. Keeping the token there meant one GET read it in clear text. The
 * plugin's data directory is served by no route at all, so the token lives
 * here instead, in a file only the server process reads.
 *
 * The same file carries a revocation the relay has not heard yet. An unlink
 * clicked while the boat is offline cuts the local link at once, but the
 * relay's copy of the token stays alive until the boat can reach it - and the
 * only credential that can kill it is the token itself. Forgetting it at that
 * moment would make the revocation impossible forever, so the disowned token
 * waits here, tried again until the relay answers.
 */
import * as fs from 'fs'
import * as path from 'path'

export interface RemoteLink {
  boatId: string
  boatToken: string
  /** Masked (o***@gmail.com): enough to recognise, not enough to harvest. */
  pairedEmail: string | null
  pairedAt: string
}

/** A token the owner has already disowned, still alive at the relay. */
export interface PendingUnlink {
  boatToken: string
  since: string
}

interface FileShape {
  remote?: RemoteLink
  pendingUnlink?: PendingUnlink
}

export class RemoteLinkStore {
  private readonly file: string
  private cache: FileShape = {}
  /** Writes are chained so a fast save cannot overtake a slow one. */
  private writeChain: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'remote.json')
  }

  /** Read once at start; afterwards the in-memory copy is the truth. */
  load(): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      this.cache = {}
      return
    }
    const raw = (parsed ?? {}) as Partial<FileShape>
    // A half-formed link is worse than none: a boatToken without a boatId
    // cannot stream anywhere, it can only confuse the screen into "paired".
    const r = raw.remote
    const p = raw.pendingUnlink
    this.cache = {
      remote:
        r && typeof r.boatId === 'string' && typeof r.boatToken === 'string'
          ? {
              boatId: r.boatId,
              boatToken: r.boatToken,
              pairedEmail: typeof r.pairedEmail === 'string' ? r.pairedEmail : null,
              pairedAt: typeof r.pairedAt === 'string' ? r.pairedAt : new Date(0).toISOString()
            }
          : undefined,
      pendingUnlink:
        p && typeof p.boatToken === 'string'
          ? { boatToken: p.boatToken, since: typeof p.since === 'string' ? p.since : new Date(0).toISOString() }
          : undefined
    }
  }

  getRemote(): RemoteLink | undefined {
    return this.cache.remote
  }

  getPendingUnlink(): PendingUnlink | undefined {
    return this.cache.pendingUnlink
  }

  async saveRemote(remote: RemoteLink | undefined): Promise<void> {
    this.cache = { ...this.cache, remote }
    return this.persist()
  }

  async setPendingUnlink(pendingUnlink: PendingUnlink | undefined): Promise<void> {
    this.cache = { ...this.cache, pendingUnlink }
    return this.persist()
  }

  private persist(): Promise<void> {
    const snapshot: FileShape = { ...this.cache }
    const run = async (): Promise<void> => {
      // Write-then-rename, like every other config write aboard: a power cut
      // mid-write must not leave a torn file holding half a credential.
      const tmp = `${this.file}.tmp`
      const body = JSON.stringify(snapshot, null, 2)
      if (snapshot.remote === undefined && snapshot.pendingUnlink === undefined) {
        // Nothing left to protect - remove the file rather than leaving an
        // empty husk that reads as "something was here".
        await fs.promises.rm(this.file, { force: true })
        return
      }
      await fs.promises.writeFile(tmp, body, { mode: 0o600 })
      await fs.promises.rename(tmp, this.file)
    }
    this.writeChain = this.writeChain.then(run, run)
    return this.writeChain
  }
}
