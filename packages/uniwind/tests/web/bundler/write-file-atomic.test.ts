// @vitest-environment node
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { transformWithOxc } from 'vite'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { buildCSS } from '../../../src/bundler/artifacts/css'
import { EXTRA_UTILITIES_CSS } from '../../../src/bundler/artifacts/css/extraUtilities'
import { INSETS_CSS } from '../../../src/bundler/artifacts/css/insets'
import { OVERWRITE_CSS } from '../../../src/bundler/artifacts/css/overwrite'
import { generateCSSForThemes } from '../../../src/bundler/artifacts/css/themes'
import { VARIANTS_CSS } from '../../../src/bundler/artifacts/css/variants'
import { buildDtsFile } from '../../../src/bundler/artifacts/dts'
import { writeFileAtomicSync } from '../../../src/bundler/artifacts/writeFileAtomic'

const execFileAsync = promisify(execFile)

const HELPER_PATH = path.resolve('./src/bundler/artifacts/writeFileAtomic.ts')
const CSS_ENTRY_FILE = './tests/test.css'
const THEMES = ['light', 'dark']
const WORKERS = 4
const WRITES_PER_WORKER = 60
const READS_PER_WRITE = 10

// Shaped like the real artifact: big enough that a truncated write is observable, and
// ending with the `@theme` block that a partial read used to cut in half.
const buildContent = (id: number) =>
    [
        `/* uniwind artifact ${id} */`,
        ...Array.from({ length: 2000 }, (_, index) => `.uniwind-${id}-${index} { color: red; }`),
        '@theme {',
        `    --uniwind-marker: ${id};`,
        '}',
        '',
    ].join('\n')

const CONTENTS = [0, 1, 2].map(buildContent)

// Each worker rewrites the same path and keeps reading it, so every read races the other
// workers' writes. A read that is not byte-identical to one of the known contents is a
// torn read.
const WORKER_SCRIPT = `
import fs from 'node:fs'
import { writeFileAtomicSync } from './writeFileAtomic.mjs'

const [target, contentsPath, seed, writes, reads] = process.argv.slice(2)
const contents = JSON.parse(fs.readFileSync(contentsPath, 'utf-8'))
const expected = new Set(contents)
const fail = message => {
    process.stdout.write(JSON.stringify({ error: message }))
    process.exit(1)
}

let observed = 0

for (let write = 0; write < Number(writes); write++) {
    writeFileAtomicSync(target, contents[(Number(seed) + write) % contents.length])

    for (let read = 0; read < Number(reads); read++) {
        let content

        try {
            content = fs.readFileSync(target, 'utf-8')
        } catch (error) {
            fail(\`read failed with \${error.code ?? error.message}\`)
        }

        observed++

        if (!expected.has(content)) {
            fail(\`read \${content.length} bytes that match none of the written contents\`)
        }
    }
}

process.stdout.write(JSON.stringify({ observed }))
`

describe('writeFileAtomicSync', () => {
    let workingDir = ''

    beforeAll(async () => {
        workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uniwind-atomic-'))

        // The workers run in their own processes, so they need the implementation as
        // plain JS. Transpiling the real source keeps them on the shipped code.
        const { code } = await transformWithOxc(fs.readFileSync(HELPER_PATH, 'utf-8'), HELPER_PATH)

        fs.writeFileSync(path.join(workingDir, 'writeFileAtomic.mjs'), code)
        fs.writeFileSync(path.join(workingDir, 'worker.mjs'), WORKER_SCRIPT)
        fs.writeFileSync(path.join(workingDir, 'contents.json'), JSON.stringify(CONTENTS))
    })

    afterAll(() => {
        fs.rmSync(workingDir, { recursive: true, force: true })
    })

    test('concurrent writers and readers never observe a partial file', async () => {
        const target = path.join(workingDir, 'uniwind.css')
        const results = await Promise.all(
            Array.from({ length: WORKERS }, (_, seed) =>
                execFileAsync(process.execPath, [
                    path.join(workingDir, 'worker.mjs'),
                    target,
                    path.join(workingDir, 'contents.json'),
                    String(seed),
                    String(WRITES_PER_WORKER),
                    String(READS_PER_WRITE),
                ])
                    // A worker that saw a torn read exits with a non-zero code, which
                    // rejects here - its report is still on stdout.
                    .catch(error => error as { stdout?: string; stderr?: string })
                    .then(({ stdout, stderr }) =>
                        JSON.parse(stdout || JSON.stringify({ error: `worker crashed: ${stderr}` })) as {
                            observed?: number
                            error?: string
                        }
                    )),
        )

        expect(results.map(result => result.error).filter(Boolean)).toEqual([])
        expect(results.reduce((total, result) => total + (result.observed ?? 0), 0)).toBe(
            WORKERS * WRITES_PER_WORKER * READS_PER_WRITE,
        )
        expect(CONTENTS).toContain(fs.readFileSync(target, 'utf-8'))
        // Every temporary file was renamed away, none were left behind.
        expect(fs.readdirSync(workingDir).filter(entry => entry.endsWith('.tmp'))).toEqual([])
    }, 60_000)

    test('replaces the file instead of writing through a package manager hardlink', () => {
        const storePath = path.join(workingDir, 'store.css')
        const installedPath = path.join(workingDir, 'installed.css')

        fs.writeFileSync(storePath, 'store content')
        fs.linkSync(storePath, installedPath)

        expect(fs.statSync(installedPath).nlink).toBe(2)

        writeFileAtomicSync(installedPath, 'rebuilt content')

        expect(fs.readFileSync(installedPath, 'utf-8')).toBe('rebuilt content')
        expect(fs.readFileSync(storePath, 'utf-8')).toBe('store content')
        expect(fs.statSync(installedPath).nlink).toBe(1)
    })

    describe('when a lock refuses the rename', () => {
        afterEach(() => {
            vi.restoreAllMocks()
        })

        const lockError = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })

        test('retries until the lock clears', () => {
            const target = path.join(workingDir, 'locked-then-free.css')
            const renameSync = fs.renameSync
            const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
                throw lockError()
            }).mockImplementationOnce(() => {
                throw lockError()
            }).mockImplementation(renameSync)

            writeFileAtomicSync(target, 'written under a lock')

            expect(rename).toHaveBeenCalledTimes(3)
            expect(fs.readFileSync(target, 'utf-8')).toBe('written under a lock')
            expect(fs.readdirSync(workingDir).filter(entry => entry.endsWith('.tmp'))).toEqual([])
        })

        test('gives up and cleans up when the lock never clears', () => {
            const target = path.join(workingDir, 'locked-forever.css')
            const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
                throw lockError()
            })

            expect(() => writeFileAtomicSync(target, 'never written')).toThrow('EPERM')
            expect(rename).toHaveBeenCalledTimes(6)
            expect(fs.existsSync(target)).toBe(false)
            expect(fs.readdirSync(workingDir).filter(entry => entry.endsWith('.tmp'))).toEqual([])
        })

        test('does not retry an error that is not a lock', () => {
            const target = path.join(workingDir, 'broken.css')
            const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
                throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
            })

            expect(() => writeFileAtomicSync(target, 'never written')).toThrow('ENOSPC')
            expect(rename).toHaveBeenCalledTimes(1)
            expect(fs.readdirSync(workingDir).filter(entry => entry.endsWith('.tmp'))).toEqual([])
        })
    })
})

describe('buildCSS', () => {
    let workingDir = ''

    beforeAll(() => {
        workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uniwind-build-css-'))
    })

    afterAll(() => {
        fs.rmSync(workingDir, { recursive: true, force: true })
    })

    test('writes the artifact once and leaves it alone while it is up to date', async () => {
        const cssFilePath = path.join(workingDir, 'uniwind.css')

        await buildCSS(THEMES, CSS_ENTRY_FILE, cssFilePath)

        const expected = [
            VARIANTS_CSS,
            INSETS_CSS,
            OVERWRITE_CSS,
            EXTRA_UTILITIES_CSS,
            await generateCSSForThemes(THEMES, CSS_ENTRY_FILE),
        ].join('\n')

        expect(fs.readFileSync(cssFilePath, 'utf-8')).toBe(expected)

        // A rename swaps the inode, so an unchanged inode proves the warm build wrote
        // nothing at all.
        const inode = fs.statSync(cssFilePath).ino

        await buildCSS(THEMES, CSS_ENTRY_FILE, cssFilePath)

        expect(fs.statSync(cssFilePath).ino).toBe(inode)
        expect(fs.readFileSync(cssFilePath, 'utf-8')).toBe(expected)
    }, 60_000)
})

describe('buildDtsFile', () => {
    let workingDir = ''

    beforeAll(() => {
        workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uniwind-dts-'))
    })

    afterAll(() => {
        fs.rmSync(workingDir, { recursive: true, force: true })
    })

    test('writes the declaration file once and leaves it alone while it is up to date', () => {
        const dtsPath = path.join(workingDir, 'uniwind-types.d.ts')

        buildDtsFile(dtsPath, '[\'light\', \'dark\']')

        const content = fs.readFileSync(dtsPath, 'utf-8')

        expect(content).toContain('themes: readonly [\'light\', \'dark\']')

        const inode = fs.statSync(dtsPath).ino

        buildDtsFile(dtsPath, '[\'light\', \'dark\']')

        expect(fs.statSync(dtsPath).ino).toBe(inode)

        buildDtsFile(dtsPath, '[\'light\', \'dark\', \'sepia\']')

        expect(fs.statSync(dtsPath).ino).not.toBe(inode)
        expect(fs.readFileSync(dtsPath, 'utf-8')).toContain('themes: readonly [\'light\', \'dark\', \'sepia\']')
    })
})
