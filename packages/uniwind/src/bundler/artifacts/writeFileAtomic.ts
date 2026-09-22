import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

// A rename over an open file is refused while another process holds a lock on it, which
// on Windows covers an antivirus scanner or the search indexer touching the artifact we
// just wrote. Those locks clear in milliseconds.
const TRANSIENT_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RETRIES = 5
const RETRY_DELAY = 20

const sleepSync = (ms: number) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const renameSyncWithRetries = (tmpPath: string, filePath: string) => {
    for (let attempt = 0;; attempt++) {
        try {
            return fs.renameSync(tmpPath, filePath)
        } catch (error) {
            const isTransient = TRANSIENT_ERRORS.has((error as NodeJS.ErrnoException).code ?? '')

            if (!isTransient || attempt === RETRIES) {
                throw error
            }

            sleepSync(RETRY_DELAY * 2 ** attempt)
        }
    }
}

/**
 * Writes `content` to a unique temporary file next to `filePath`, then renames it into
 * place. Metro regenerates artifacts from a worker pool, so writing in place would let
 * another worker read a half-written file. The rename also replaces the directory entry
 * instead of writing through the hardlink package managers create from their store.
 */
export const writeFileAtomicSync = (filePath: string, content: string) => {
    // A shared temporary name would only move the race between workers, which can be
    // processes or threads, hence the random suffix on top of the pid.
    const tmpPath = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
    )

    try {
        fs.writeFileSync(tmpPath, content)
        renameSyncWithRetries(tmpPath, filePath)
    } catch (error) {
        fs.rmSync(tmpPath, { force: true })

        throw error
    }
}
