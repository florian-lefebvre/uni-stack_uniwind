import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

/**
 * Writes `content` to `filePath` by filling a unique temporary file next to it and
 * renaming that file into place.
 *
 * Generated artifacts sit inside the installed package and are regenerated on every
 * build. Metro runs transforms in a worker pool, so another worker can read an artifact
 * (through `@import "uniwind"`, for instance) while this one rewrites it. Writing in
 * place truncates the file first, which makes that reader see a partial stylesheet and
 * report a syntax error against its own entry file. A rename within a filesystem is
 * atomic, so readers see either the whole old file or the whole new one.
 *
 * Renaming also replaces the directory entry instead of writing through it, which breaks
 * the hardlink package managers such as pnpm create from their content-addressable store
 * instead of mutating the copy shared by every project on the machine.
 */
export const writeFileAtomicSync = (filePath: string, content: string) => {
    // The racing writers are separate Metro workers, so a shared temporary name would
    // only move the race. Workers can be processes or threads, hence the random suffix
    // on top of the pid.
    const tmpPath = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
    )

    try {
        fs.writeFileSync(tmpPath, content)
        fs.renameSync(tmpPath, filePath)
    } catch (error) {
        fs.rmSync(tmpPath, { force: true })

        throw error
    }
}
