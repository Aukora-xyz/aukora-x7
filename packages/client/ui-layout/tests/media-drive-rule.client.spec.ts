/**
 * Media and Documents, her drive: the drive rule (what is never shown, which paths are refused) and the pure model
 * (kinds, places, order, size and time words). Every path here is made up.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as chatCopy from '../../ui-chat/src/client/drive-link.ts'
import {
  DRIVE_HOME, driveCanonical, driveInPlaces, driveKeptOut, drivePrivate, driveTarget, parseDriveTarget, PRIVATE_DIR, SECRET_NAMES,
  SECRET_PREFIXES,
} from '../src/client/spatial/apps/media/drive-rule.ts'
import {
  driveKind, driveSection, formatSize, formatTime, inertImages, newestFirst,
} from '../src/client/spatial/apps/media/drive-model.ts'

const DOCS = '/dsh/home/auma/docs'

describe('the drive rule', () => {
  it('R1 keeps out every secret name, its one-dot stem, its suffix siblings and every secret prefix', () => {
    for (const name of SECRET_NAMES) {
      expect(driveKeptOut(`${DOCS}/${name}`), name).toBe(true)
      expect(driveKeptOut(`${DOCS}/.${name}`), `.${name}`).toBe(true)
      for (const suffix of ['.bak', '.3fa9c1d2e4b5.tmp', '~', '.lock.takeover-0123456789abcdef', '_old~']) {
        expect(driveKeptOut(`${DOCS}/${name}${suffix}`), `${name}${suffix}`).toBe(true)
      }
      // As a folder too.
      expect(driveKeptOut(`${DOCS}/${name}/inside.md`), `${name}/inside.md`).toBe(true)
    }
    for (const prefix of SECRET_PREFIXES) expect(driveKeptOut(`${DOCS}/${prefix}local`), prefix).toBe(true)
    expect(driveKeptOut(`${DOCS}/.env`)).toBe(true)
  })

  it('R2 keeps out key-like and credential-like names, on files and on folders', () => {
    for (const path of [`${DOCS}/device-keypair.json`, `${DOCS}/id.pem`, `${DOCS}/my-password.txt`, `${DOCS}/a.key`, `${DOCS}/b.p12`,
      `${DOCS}/private_key.txt`, `${DOCS}/x.session.cap`]) expect(driveKeptOut(path), path).toBe(true)
    for (const path of [`${DOCS}/credentials/notes.md`, `${DOCS}/secrets/a.txt`, `${DOCS}/.ssh/config`]) {
      expect(driveKeptOut(path), path).toBe(true)
    }
  })

  it('R2b keeps out common key files, dot-files that hold logins, and her secret stems with any extension', () => {
    for (const name of ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ed25519.pub', 'id_rsa.bak', 'ID_RSA',
      '.npmrc', 'npmrc', '.netrc', '_netrc', '.pgpass', '.pypirc', '.git-credentials',
      'api_token.txt', 'github-token', 'TOKEN.md', 'apikey.txt', 'openai-api-key.md', 'API.KEY.json',
      'nsec1qqqq.txt', 'my.nsec', 'nostr-nsec.json', 'AuthKey_ABC.p8', 'cert.pfx', 'vault.kdbx', 'release.jks', 'app.keystore',
      'session.cap.json', 'session.cap.md', '.session.cap.bak.json', '.afferent-probe.json', 'afferent-probe', 'afferent-probe.v2',
      'pepper.v2', 'pepper.v1.json', '.pepper.v3', 'pepper.v12~']) {
      expect(driveKeptOut(`${DOCS}/${name}`), name).toBe(true)
      expect(driveKeptOut(`${DOCS}/${name}/inside.md`), `${name}/inside.md`).toBe(true)
    }
  })

  it('R3 shows look-alikes', () => {
    for (const path of [`${DOCS}/.ssh-config-docs`, `${DOCS}/notes.md`, `${DOCS}/.session.capx`,
      `${DOCS}/.transport-notes`, `${DOCS}/PENTORA.v0.md`, '/dsh/home/auma/captures/latest.png',
      `${DOCS}/insecure-notes.md`, `${DOCS}/pepper-recipe.md`, `${DOCS}/afferent.md`, `${DOCS}/identity.md`, `${DOCS}/id_card.png`,
      `${DOCS}/session.capital.md`]) {
      expect(driveKeptOut(path), path).toBe(false)
    }
  })

  it('R10 opens only her drive\'s places: Captures, Documents and Private, never her organs or her home folder\'s root', () => {
    for (const path of ['/dsh/home/auma/captures/latest.png', `${DOCS}/PENTORA.v0.md`, `${DOCS}/pentora/notes.txt`, `${PRIVATE_DIR}/diary.md`]) {
      expect(driveInPlaces(path), path).toBe(true)
    }
    for (const path of ['/dsh/home/auma/id_rsa', '/dsh/home/auma/.npmrc', '/dsh/home/auma/notes.md', '/dsh/home/auma/seed/ball.json',
      '/dsh/home/auma/memory/a.md', '/dsh/home/auma/docsextra/a.md', '/dsh/home/auma/captures', DOCS, PRIVATE_DIR,
      '/dsh/home/auma/private-notes.md', '/dsh/home/owner/docs/a.md']) {
      expect(driveInPlaces(path), path).toBe(false)
    }
  })

  it('R4 never parts and roots are kept out, Private is not, and only plain absolute paths are canonical', () => {
    for (const path of [`${DOCS}/.DS_Store`, `${DOCS}/session.lock`, `${DOCS}/a.md.conflict-backup`, '/dsh/home/balls/b1.json',
      '/dsh/home/balls', '/dsh/home/sessions/--dsh-home-auma--/s.jsonl']) expect(driveKeptOut(path), path).toBe(true)
    expect(driveKeptOut(`${PRIVATE_DIR}/diary.md`)).toBe(false)
    expect(drivePrivate(`${PRIVATE_DIR}/diary.md`)).toBe(true)
    expect(drivePrivate(PRIVATE_DIR)).toBe(true)
    expect(drivePrivate('/dsh/home/auma/private-notes.md')).toBe(false)
    for (const path of ['docs/../private/x.md', `${DOCS}/../private/x.md`, `${DOCS}/./a.md`, `${DOCS}//a.md`, '/dsh/home/auma/../../etc/passwd',
      'docs\\a.md', `${DOCS}\\a.md`, `${DOCS}/a\u0000.md`, `${DOCS}/a\n.md`, '/dsh/../etc/x', `${DOCS}/`, '', 'relative.md']) {
      expect(driveCanonical(path), JSON.stringify(path)).toBe(false)
    }
    expect(driveCanonical('/dsh/home/auma/docs/PENTORA.v0.md')).toBe(true)
    expect(driveCanonical('/dsh/home/owner/a.md')).toBe(true)
    expect('/dsh/home/owner/a.md'.startsWith(DRIVE_HOME)).toBe(false)
    expect('/dsh/home/auma-one/a.md'.startsWith(DRIVE_HOME)).toBe(false)
  })
})

describe('the drive model', () => {
  it('R5 names kinds by extension, in any case; .svg and .html are text, never an image', () => {
    expect(driveKind('a.md')).toMatchObject({ label: 'Markdown', preview: 'markdown', family: 'text' })
    expect(driveKind('A.MARKDOWN')).toMatchObject({ label: 'Markdown', preview: 'markdown' })
    expect(driveKind('log.TXT')).toMatchObject({ label: 'Text', preview: 'text' })
    for (const name of ['x.csv', 'x.tsv', 'x.yaml', 'x.yml', 'x.toml', 'x.html', 'x.htm', 'x.xml', 'x.css', 'x.js', 'x.mjs', 'x.ts', 'x.log']) {
      expect(driveKind(name).preview, name).toBe('text')
    }
    expect(driveKind('x.json')).toMatchObject({ label: 'JSON', preview: 'text' })
    expect(driveKind('x.jsonl')).toMatchObject({ label: 'JSON', preview: 'text' })
    expect(driveKind('x.svg')).toMatchObject({ label: 'SVG image', preview: 'text', family: 'text' })
    expect(driveKind('x.svg').mime).toBeUndefined()
    expect(driveKind('x.html').mime).toBeUndefined()
    expect(driveKind('a.PNG')).toMatchObject({ label: 'PNG image', preview: 'image', family: 'image', mime: 'image/png' })
    expect(driveKind('a.jpg')).toMatchObject({ label: 'JPEG image', mime: 'image/jpeg' })
    expect(driveKind('a.jpeg')).toMatchObject({ label: 'JPEG image', mime: 'image/jpeg' })
    expect(driveKind('a.webp')).toMatchObject({ label: 'WebP image', mime: 'image/webp' })
    expect(driveKind('a.gif')).toMatchObject({ label: 'GIF image', mime: 'image/gif' })
    expect(driveKind('clip.mp4')).toMatchObject({ label: 'Video', preview: 'none', family: 'video' })
    expect(driveKind('clip.WEBM')).toMatchObject({ label: 'Video', family: 'video' })
    expect(driveKind('paper.pdf')).toMatchObject({ label: 'PDF', preview: 'none', family: 'other' })
    expect(driveKind('blob.bin')).toMatchObject({ label: 'File', preview: 'none' })
    expect(driveKind('Makefile')).toMatchObject({ label: 'File', preview: 'none' })
    expect(driveKind('.hidden')).toMatchObject({ label: 'File', preview: 'none' })
  })

  it('R6 puts each file in one place, or none', () => {
    expect(driveSection('/dsh/home/auma/captures/latest.png')).toBe('captures')
    expect(driveSection('/dsh/home/auma/captures/ring/20261112T140501Z-0123456789ab.png')).toBe('captures')
    expect(driveSection('/dsh/home/auma/captures/latest-projection.json')).toBeNull()
    expect(driveSection('/dsh/home/auma/captures/take.mp4')).toBe('video')
    expect(driveSection(`${DOCS}/PENTORA.v0.md`)).toBe('documents')
    expect(driveSection(`${DOCS}/pentora/notes.txt`)).toBe('documents')
    expect(driveSection(`${DOCS}/paper.pdf`)).toBe('documents')
    expect(driveSection(`${DOCS}/drawing.svg`)).toBe('documents')
    expect(driveSection(`${DOCS}/photo.jpg`)).toBe('images')
    expect(driveSection(`${DOCS}/clip.mp4`)).toBe('video')
    expect(driveSection('/dsh/home/auma/seed/ball.json')).toBeNull()
    expect(driveSection('/dsh/home/auma/docs')).toBeNull()
    expect(driveSection('/dsh/home/auma/docsextra/a.md')).toBeNull()
  })

  it('R7 sorts newest first, ties by name, unknown times last, and words sizes and times', () => {
    const rows = [
      { name: 'b.md', modifiedMs: 100 }, { name: 'a.md', modifiedMs: 100 }, { name: 'z.md', modifiedMs: null },
      { name: 'c.md', modifiedMs: 300 }, { name: 'y.md', modifiedMs: null },
    ]
    expect([...rows].sort(newestFirst).map(row => row.name)).toEqual(['c.md', 'a.md', 'b.md', 'y.md', 'z.md'])
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(1023)).toBe('1023 B')
    expect(formatSize(1024)).toBe('1.0 KB')
    expect(formatSize(4300)).toBe('4.2 KB')
    expect(formatSize(48 * 1024 + 100)).toBe('48 KB')
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatSize(64 * 1024 * 1024)).toBe('64 MB')
    const now = new Date(2026, 10, 12, 18, 0).getTime()
    expect(formatTime(new Date(2026, 10, 12, 14, 5).getTime(), now)).toBe('14:05')
    expect(formatTime(new Date(2026, 10, 12, 9, 7).getTime(), now)).toBe('09:07')
    expect(formatTime(new Date(2026, 1, 3, 14, 5).getTime(), now)).toBe('3 Feb 14:05')
    expect(formatTime(new Date(2025, 10, 12, 14, 5).getTime(), now)).toBe('12 Nov 2025')
  })

  it('R11 makes every image in a Markdown source inert, adding only an invisible joiner and removing nothing', () => {
    const source = '![a](https://x/y.png) !![b][r] `![code]` \\![c](z) ![](</dsh/home/auma/captures/latest.png>)\n[r]: https://x/r.png'
    const inert = inertImages(source)
    expect(inert).not.toContain('![')
    expect(inert.replaceAll('⁠', '')).toBe(source)
    expect(inertImages('no images here')).toBe('no images here')
  })

  it('R8 reads drive targets: spaces and colons stay in the path, anything malformed is null', () => {
    const first = driveTarget('/dsh/home/auma/docs/My notes: v2.md')
    const second = driveTarget('/dsh/home/auma/docs/My notes: v2.md')
    expect(first).not.toBe(second)
    expect(first).toMatch(/^drive:[0-9]+:\/dsh\/home\/auma\/docs\/My notes: v2\.md$/u)
    expect(parseDriveTarget(first)).toBe('/dsh/home/auma/docs/My notes: v2.md')
    expect(parseDriveTarget('drive:7:/a:b:c')).toBe('/a:b:c')
    for (const bad of [undefined, null, 3, '', 'drive:', 'drive:1:', 'drive::/a', 'drive:x:/a', 'driv:1:/a', 'general', '/dsh/home/auma/docs/a.md']) {
      expect(parseDriveTarget(bad), String(bad)).toBeNull()
    }
  })

  it('R9 the chat\'s copy of the drive rule is this one, byte for byte, and answers the same', () => {
    const block = (file: string): string => {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8')
      const begin = text.indexOf('// BEGIN DRIVE RULE')
      const end = text.indexOf('// END DRIVE RULE')
      expect(begin, file).toBeGreaterThanOrEqual(0)
      expect(end, file).toBeGreaterThan(begin)
      expect(text.indexOf('// BEGIN DRIVE RULE', begin + 1), file).toBe(-1)
      return text.slice(begin, end)
    }
    const here = block('../src/client/spatial/apps/media/drive-rule.ts')
    for (const name of ['SECRET_NAMES', 'SECRET_PREFIXES', 'SECRET_SUFFIX', 'SENSITIVE_NAME', 'DRIVE_SECRET_NAME', 'DRIVE_PLACES',
      'driveKeptOut', 'driveInPlaces', 'driveCanonical', 'drivePrivate', 'driveTarget', 'parseDriveTarget']) {
      expect(here, name).toContain(name)
    }
    expect(block('../../ui-chat/src/client/drive-link.ts')).toBe(here)
    const paths = [
      `${DOCS}/PENTORA.v0.md`, `${DOCS}/credentials.yaml.bak`, `${DOCS}/.ssh/config`, `${DOCS}/id_ed25519.pub`, `${DOCS}/notes-token.txt`,
      `${DOCS}/session.cap.md`, `${DOCS}/../private/x.md`, '/dsh/home/auma/captures/latest.png', '/dsh/home/auma/private/a.md',
      '/dsh/home/auma/seed/x.md', '/dsh/home/sessions/s.jsonl', '/dsh/home/owner/a.md', `${DOCS}/a\\b.md`,
    ]
    for (const path of paths) {
      expect([chatCopy.driveCanonical(path), chatCopy.driveKeptOut(path), chatCopy.driveInPlaces(path), chatCopy.drivePrivate(path)], path)
        .toEqual([driveCanonical(path), driveKeptOut(path), driveInPlaces(path), drivePrivate(path)])
    }
    expect(parseDriveTarget(chatCopy.driveTarget(`${DOCS}/a b.md`))).toBe(`${DOCS}/a b.md`)
  })
})
