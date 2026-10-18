import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RedlineComment, RedlineItem, RedlinePending } from '../types'

// Where the helper (app/helper.js) keeps captures and the queue of sent redlines:
// %REDLINE_DATA% if set, else %LOCALAPPDATA%\Redline. Learned once, handed to every helper run.
let DATA = ''
let QUEUE = ''
async function dataDir($: EngineInterface) {
  if (!DATA) {
    DATA = (await $.env.get('REDLINE_DATA')) || `${(await $.env.get('LOCALAPPDATA')) ?? ''}\\Redline`
    QUEUE = `${DATA}\\queue`
  }
  return DATA
}
const NODE_PATHS = ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files (x86)\\nodejs\\node.exe']
const PANE = 'redline'

const queue = atom({ plugin: 'redline', key: 'queue' } as const, [] as RedlineItem[])

type Mark = { kind: string; colour?: string; ocr?: string }
// A quote from the conversation, with where it is (e.g. "Claude's reply 3 of 5"); plain strings from older items.
export type Quoted = string | { quote: string; where?: string }

export type Item = {
  id: string
  kind?: 'screen' | 'text'
  image?: string
  highlights?: Quoted[]
  crossed?: Quoted[]
  drawn?: Quoted[]
  sentSize?: { width: number; height: number } | null
  thumb?: string
  message?: string
  comments?: RedlineComment[]
  marks?: Mark[]
}

const COLOUR: Record<string, string> = {
  '#ff3b30': 'red', '#ffd60a': 'yellow', '#ffffff': 'white', '#30d158': 'green', '#0a84ff': 'blue',
}

const quote = (s: string | undefined) => (s ? `"${s.replace(/\s+/g, ' ').trim()}"` : '')

// The block the model reads beside the person's message (they never see it).
export function describe(item: Item): string {
  if (item.kind === 'text') return describeText(item)
  const size = item.sentSize ? ` (${item.sentSize.width}x${item.sentSize.height}, marks drawn in)` : ''
  const lines = [
    `Redline: the user marked up part of their screen and attached it to this message.`,
    `Open the image with the Read tool before answering: ${item.image}${size}`,
  ]
  if (item.message) lines.push(`His note: ${quote(item.message)}`)
  const comments = item.comments ?? []
  const kept = comments.filter(c => !c.removed)
  if (kept.length) {
    lines.push('Numbered comment pins on the image:')
    for (const c of kept) {
      lines.push(`  #${c.n} ${quote(c.text)}${c.ocr ? ` - pin points at text: ${quote(c.ocr)}` : ''}`)
    }
  }
  const dropped = comments.filter(c => c.removed).map(c => `#${c.n}`)
  if (dropped.length) lines.push(`He withdrew pin ${dropped.join(', ')} after drawing: ignore ${dropped.length === 1 ? 'it' : 'them'} on the image.`)
  const marks = (item.marks ?? []).filter(m => m.kind !== 'pen' || m.ocr)
  if (marks.length) {
    lines.push('Other marks:')
    for (const m of marks) {
      const colour = m.colour && COLOUR[m.colour] ? ` (${COLOUR[m.colour]})` : ''
      lines.push(`  - ${m.kind}${colour}${m.ocr ? ` on: ${quote(m.ocr)}` : ''}`)
    }
  }
  lines.push('The quoted text was read by OCR from the original screenshot and may contain small errors; the image is the source of truth.')
  return lines.join('\n')
}

// A Redline Text review: exact quotes from the last reply, no picture to open.
function describeText(item: Item): string {
  const lines = ['Redline Text: the user reviewed this conversation in a mirror window. Every quote below is exact text from it; "where" says which message.']
  if (item.message) lines.push(`His note: ${quote(item.message)}`)
  const kept = (item.comments ?? []).filter(c => !c.removed)
  if (kept.length) {
    lines.push('Comments:')
    for (const c of kept) {
      const on = c.quotes?.length
        ? c.quotes.map(x => (x.drawn && !x.quote ? 'a drawing' : `${x.drawn ? '(drawn around) ' : x.crossed ? '(crossed out) ' : ''}${quote(x.quote)}`) + (x.where ? ` (${x.where})` : '')).join(' + ')
        : `${quote(c.ocr)}${c.where ? ` (${c.where})` : ''}`
      lines.push(`  #${c.n} on ${on}: ${c.text}`)
    }
  }
  const dropped = (item.comments ?? []).filter(c => c.removed).map(c => `#${c.n}`)
  if (dropped.length) lines.push(`He withdrew comment ${dropped.join(', ')}: ignore ${dropped.length === 1 ? 'it' : 'them'}.`)
  const one = (x: Quoted) => (typeof x === 'string' ? quote(x) : `${quote(x.quote)}${x.where ? ` (${x.where})` : ''}`)
  const list = (title: string, xs?: Quoted[]) => { if (xs?.length) { lines.push(title); for (const x of xs) lines.push(`  - ${one(x)}`) } }
  list('Highlighted (keep / important):', item.highlights)
  list('Crossed out (remove or wrong):', item.crossed)
  list('Drew around (text under the drawing):', item.drawn)
  return lines.join('\n')
}

export function summarise(p: RedlinePending): string {
  const n = (k: number, one: string) => (k === 1 ? `1 ${one}` : `${k} ${one}s`)
  return [n(p.captures, 'capture'), p.comments ? n(p.comments, 'comment') : '', p.marks ? n(p.marks, 'mark') : '']
    .filter(Boolean).join(' · ')
}

export function pendingOf(items: readonly RedlineItem[]): RedlinePending {
  return {
    captures: items.length,
    comments: items.reduce((s, i) => s + i.comments.filter(c => !c.removed).length, 0),
    marks: items.reduce((s, i) => s + i.marks, 0),
  }
}

// The image as the desktop app draws it: a JPEG inside an SVG (a mod's picture element).
export function thumbSvg(item: RedlineItem): string {
  const { width: w, height: h } = item
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><image href="${item.thumb}" x="0" y="0" width="${w}" height="${h}"/></svg>`
}

async function nodeBin($: EngineInterface): Promise<string> {
  for (const p of NODE_PATHS) if (await $.fs.exists(p)) return p
  return 'node'
}

let mySession = ''

// Reads the queue folder; only files that changed since the last look are parsed again.
const seen = new Map<string, { mtime: number; item: RedlineItem; auto: boolean }>()
async function scan($: EngineInterface): Promise<RedlineItem[]> {
  await dataDir($)
  const files = (await $.fs.exists(QUEUE)) ? (await $.fs.list(QUEUE)).filter(f => f.kind === 'file' && f.name.endsWith('.json')) : []
  const next: RedlineItem[] = []
  const auto: string[] = []
  for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
    const hit = seen.get(f.name)
    if (hit && hit.mtime === f.mtimeMs) { next.push(hit.item); if (hit.auto) auto.push(hit.item.id); continue }
    try {
      const raw = JSON.parse(await $.fs.read(`${QUEUE}\\${f.name}`)) as Item
      const item: RedlineItem = {
        id: raw.id,
        kind: raw.kind === 'text' ? 'text' : 'screen',
        thumb: raw.thumb ?? '',
        width: raw.sentSize?.width ?? 400,
        height: raw.sentSize?.height ?? 300,
        message: raw.message ?? '',
        comments: (raw.comments ?? []).map(c => ({ n: c.n, text: c.text, ocr: c.ocr, removed: c.removed, where: c.where })),
        marks: raw.kind === 'text' ? (raw.highlights?.length ?? 0) + (raw.crossed?.length ?? 0) + (raw.drawn?.length ?? 0) : raw.marks?.length ?? 0,
      }
      const mine = !!(raw as { autoSend?: boolean }).autoSend && (raw as { session?: string }).session === mySession && !!mySession
      seen.set(f.name, { mtime: f.mtimeMs, item, auto: mine })
      next.push(item)
      if (mine) auto.push(item.id)
    } catch {
      // half-written or foreign file: the next scan sees it whole
    }
  }
  const now = (await read($, queue)) ?? []
  const key = (l: readonly RedlineItem[]) => JSON.stringify(l.map(i => [i.id, i.message, i.comments, i.marks, i.thumb.length]))
  if (key(now) !== key(next)) {
    await update($, queue, () => next)
    // something new came in: show it in the side panel
    if (next.some(i => !now.find(o => o.id === i.id) && !auto.includes(i.id))) void $.ui.open({ id: PANE, title: 'Redline' })
  }
  if (!next.length && now.length) void $.ui.close({ id: PANE })
  const fresh = auto.filter(id => !sending.has(id))
  if (fresh.length) { fresh.forEach(id => sending.add(id)); void sendNow($, fresh) }
  return next
}

async function helper($: EngineInterface, args: string[]) {
  return $.process.run([await nodeBin($), `${$.plugin.root}\\app\\helper.js`, ...args], { timeoutMs: 60_000, env: { REDLINE_DATA: await dataDir($) } })
}

// Starts the helper detached (through Start-Process), so the editor outlives this call.
async function launch($: EngineInterface, args: string[]) {
  const node = await nodeBin($)
  // session.start doesn't run again when the mod is reloaded mid-session, so ask now if we never learned it
  if (!mySession) mySession = await $.session.id().catch(() => '')
  const withSession = mySession ? [...args, `--session=${mySession}`] : args // its Send goes straight into this session
  const list = [`'"${$.plugin.root}\\app\\helper.js"'`, ...withSession.map(a => `'${a}'`)].join(',')
  await $.process.run([
    'powershell.exe', '-NoProfile', '-WindowStyle', 'Hidden', '-Command',
    `$env:REDLINE_DATA='${await dataDir($)}'; Start-Process -WindowStyle Hidden -FilePath '${node}' -ArgumentList ${list}`,
  ])
}

// The conversation as the mirror shows it: your messages and Claude's replies (a reply's pieces between tool
// calls joined), tool results left out.
export type MirrorMessage = { role: 'user' | 'assistant'; text: string }
export function conversation(rows: readonly { role: 'user' | 'assistant'; text: string; toolResults?: readonly unknown[] }[]): MirrorMessage[] {
  const out: MirrorMessage[] = []
  for (const r of rows) {
    const text = r.text.trim()
    if (!text || (r.role === 'user' && r.toolResults?.length)) continue
    const last = out[out.length - 1]
    if (r.role === 'assistant' && last?.role === 'assistant') last.text += `\n\n${text}`
    else out.push({ role: r.role, text })
  }
  return out
}

// The window that mirrors this conversation (null when none is open), refreshed after every reply.
let mirror: string | null = null
let lastWritten = ''
let busy = false // Claude is working on a turn: the mirror shows "Claude is thinking"
async function writeConversation($: EngineInterface, file: string): Promise<boolean> {
  const messages = conversation(await $.session.messages())
  if (!messages.length) return false
  const body = JSON.stringify({ busy, messages })
  if (body === lastWritten) return true // nothing new: the page keeps what it has
  lastWritten = body
  await $.fs.write(file, JSON.stringify({ updated: await $.clock.now(), busy, messages }))
  return true
}

// Redline Text: the whole conversation mirrored in its own window, kept up to date after every reply.
async function openMirror($: EngineInterface): Promise<boolean> {
  mirror = `${await dataDir($)}\\text\\${Date.now()}.json`
  lastWritten = ''
  if (!(await writeConversation($, mirror))) { mirror = null; return false }
  await launch($, ['text', mirror])
  return true
}

// The Redline icon (a comment pin), as the Svg element draws it beside the button.
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect width="64" height="64" rx="15" fill="#1f1f1d"/><path d="M14 50V30a18 18 0 1 1 18 18H14z" fill="#e5484d"/><path d="M23 36c4-3 6 2 10-1s5-6 9-4" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/></svg>'
const menu = atom({ plugin: 'redline', key: 'menu' } as const, false)

// Edits one queued item's JSON in place (the comment texts, a removed pin, the note).
async function edit($: EngineInterface, id: string, change: (item: Item) => void) {
  await dataDir($)
  const file = `${QUEUE}\\${id}.json`
  if (!(await $.fs.exists(file))) return
  const item = JSON.parse(await $.fs.read(file)) as Item
  change(item)
  await $.fs.write(file, JSON.stringify(item, null, 2))
  await scan($)
}

// Sends the waiting redlines now, as their own message: the note is the text (the prompt.submit hook attaches them).
// Sends redlines now, as their own message. The redlines go in as hidden rows Claude reads (a message a plugin
// submits doesn't pass the prompt.submit hook), then the note is submitted as the message.
const sending = new Set<string>()
async function sendNow($: EngineInterface, ids: string[] = []) {
  const { exitCode, stdout } = await helper($, ['claim', ...ids])
  const items = exitCode === 0 ? (JSON.parse(stdout || '[]') as Item[]) : []
  await scan($)
  if (!items.length) return
  for (const item of items) await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: describe(item) }] } })
  void $.ui.close({ id: PANE })
  const text = items.map(i => i.message).filter(Boolean).join(' / ') || (items.length === 1 ? "Here's my Redline." : `Here are my ${items.length} Redlines.`)
  await $.prompt.submit({ text, asUser: true })
}

// A thumbnail that fits a w x h box, keeping the capture's shape.
function fit(item: RedlineItem, w: number, h: number) {
  const k = Math.min(w / item.width, h / item.height)
  return { width: Math.round(item.width * k), height: Math.round(item.height * k) }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'redline',
      description: 'Freeze the screen, drag a box, draw and comment on it; sent with your next message',
      argumentHint: '[text | discard]',
      immediate: true,
    })
    mySession = await $.session.id()
    await scan($)
    let tick = 0
    $.clock.every(1500, () => {
      void scan($)
      // the mirror: rewrite every 3 s while open (a reply's last pieces land after the turn ends)
      if (mirror && ++tick % 2 === 0) void writeConversation($, mirror).catch(() => undefined)
    })
    // Ctrl+Alt+Shift+R from anywhere; hotkey.ps1 keeps one copy alive across sessions (named mutex).
    const node = await nodeBin($)
    await $.process.run([
      'powershell.exe', '-NoProfile', '-WindowStyle', 'Hidden', '-Command',
      `$env:REDLINE_DATA='${await dataDir($)}'; Start-Process -WindowStyle Hidden -FilePath powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','"${$.plugin.root}\\app\\hotkey.ps1"','-Node','"${node}"','-Helper','"${$.plugin.root}\\app\\helper.js"'`,
    ]).catch(() => undefined)
    // Redline's Edge, windowless and kept warm, so the editor opens in under a second
    await launch($, ['warm']).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'redline' }, async ($, e) => {
    if (e.args.trim() === 'text') {
      if (!(await openMirror($))) return { text: 'Redline Text: there is nothing in this conversation to review yet.' }
      return { text: 'Redline Text: this conversation is open in its own window and follows new replies. Select text to comment, highlight or cross out; ✏️ Draw to draw; then Send to Claude.' }
    }
    if (e.args.trim() === 'discard') {
      await helper($, ['discard'])
      await scan($)
      return { text: 'Redline: dropped everything that was waiting.' }
    }
    await launch($, ['capture'])
    return { text: 'Redline: drag a box around what you want to mark (Esc cancels), draw on it, then Send. It rides along with your next message.' }
  })

  // Keep the mirror window up to date: after each turn, write the conversation again (the page polls it).
  on('turn.start', async ($, e, next) => {
    busy = true
    if (mirror) await writeConversation($, mirror).catch(() => undefined)
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    busy = false
    if (mirror) await writeConversation($, mirror).catch(() => undefined)
    return result
  })

  // Attach every waiting redline to the next real message (not to slash commands).
  on('prompt.submit', async ($, e, next) => {
    const ours = e.origin?.kind === 'plugin' && e.origin.name === 'redline'
    if (e.command || (e.isMeta && !ours) || !((await read($, queue)) ?? []).length) return next(e)
    const { exitCode, stdout } = await helper($, ['claim'])
    const items = exitCode === 0 ? (JSON.parse(stdout || '[]') as Item[]) : []
    await update($, queue, () => [])
    void $.ui.close({ id: PANE })
    if (!items.length) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...items.map(describe)] })
  })

  // The card above the prompt: thumbnail (where the surface draws pictures), what is waiting, Preview / Discard.
  // Above the chat box: the Redline button (icon + menu: Capture screen / Review this conversation), and, when a
  // Redline is waiting, what it holds with Send / Preview / Discard.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const items = (await read($, queue)) ?? [] // never written yet reads as nothing waiting
    const open = !!(await read($, menu))
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    const Svg = 'Svg' in els ? els.Svg : undefined
    const close = () => update($, menu, () => false)
    const first = items[0]
    const said = items.flatMap(i => i.comments.filter(c => !c.removed).map(c => quote(c.text))).slice(0, 2).join(', ')
    const t = first ? fit(first, 56, 40) : { width: 0, height: 0 }
    return (
      <Box flexDirection="row" alignItems="center" justifyContent="flex-start" gap={1}>
        {/* the logo (a picture can't be clicked in a mod), and right on it the ▾ that opens Redline */}
        {Svg ? <Svg key="icon" alt="Redline" source={ICON} width={28} height={28} /> : null}
        <Button key="redline" label={Svg ? (open ? '▴' : '▾') : (open ? 'Redline ▴' : 'Redline ▾')} onPress={() => update($, menu, v => !v)} />
        {open ? (
          <Box flexDirection="row" gap={1}>
            <Button key="capture" label="Capture screen" onPress={async () => { await close(); await launch($, ['capture']) }} />
            <Button key="review" label="Review conversation" onPress={async () => {
              await close()
              if (!(await openMirror($))) $.ui.toast('Redline Text: nothing in this conversation to review yet')
            }} />
          </Box>
        ) : null}
        {first && !open ? (
          <Box flexDirection="row" alignItems="center" gap={1} flexGrow={1} flexShrink={1}>
            {Svg && first.thumb ? <Svg key="thumb" alt="Redline thumbnail" source={thumbSvg(first)} width={t.width} height={t.height} /> : null}
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Text bold><Text color="red">● </Text>Redline ready</Text>
              <Text dimColor wrap="truncate-end">{summarise(pendingOf(items))}{said ? ` · ${said}` : ''}</Text>
            </Box>
            <Button key="send" label="Send to Claude" variant="primary" onPress={() => sendNow($)} />
            <Button key="preview" label="Preview" onPress={() => { void $.ui.open({ id: PANE, title: 'Redline' }) }} />
            <Button key="discard" label="Discard" onPress={async () => { await helper($, ['discard']); await scan($) }} />
          </Box>
        ) : null}
        {first && !open ? null : <Box key="spacer" flexGrow={1} />}
      </Box>
    )
  })

  // The side panel: the marked image, every comment editable or removable, the note, Draw more / Discard.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const items = (await read($, queue)) ?? [] // never written yet reads as nothing waiting
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    const Svg = 'Svg' in els ? els.Svg : undefined
    const Input = 'Input' in els ? els.Input : undefined // the mobile app draws no field
    if (!items.length) return <Text dimColor>Nothing waiting. Use /redline or Ctrl+Alt+Shift+R.</Text>
    const width = Math.max(200, Math.min(520, ((e.props as { bodyColumns?: number }).bodyColumns ?? 60) * 8))
    return (
      <Box flexDirection="column" gap={1}>
        {items.map(item => (
          <Box key={`item-${item.id}`} flexDirection="column" gap={1}>
            {Svg && item.thumb ? (
              <Svg key={`img-${item.id}`} alt="The marked-up capture" source={thumbSvg(item)} width={width} height={Math.round((width * item.height) / item.width)} />
            ) : item.kind === 'text' ? (
              <Text bold>Redline Text review · {item.marks} mark{item.marks === 1 ? '' : 's'}</Text>
            ) : (
              <Text dimColor>{item.width} x {item.height} capture (picture shown in the Claude app)</Text>
            )}
            {item.comments.map(c => (
              <Box key={`row-${item.id}-${c.n}`} flexDirection="row" alignItems="center" gap={1}>
                <Text color={c.removed ? undefined : 'red'} dimColor={c.removed}>#{c.n}</Text>
                {c.removed ? (
                  <Text dimColor strikethrough>{c.text}</Text>
                ) : Input ? (
                  <Box flexGrow={1}>
                    <Input
                      key={`c-${item.id}-${c.n}`}
                      value={c.text}
                      submitLabel="Save"
                      onSubmit={(value: string) => edit($, item.id, it => { it.comments = (it.comments ?? []).map(x => (x.n === c.n ? { ...x, text: value.trim() || x.text } : x)) })}
                    />
                  </Box>
                ) : (
                  <Text>{c.text}</Text>
                )}
                <Button
                  key={`rm-${item.id}-${c.n}`}
                  label={c.removed ? 'Undo' : 'Remove'}
                  onPress={() => edit($, item.id, it => { it.comments = (it.comments ?? []).map(x => (x.n === c.n ? { ...x, removed: !x.removed } : x)) })}
                />
              </Box>
            ))}
            {c0(item) && <Text dimColor>{c0(item)}</Text>}
            {Input ? (
              <Input
                key={`note-${item.id}`}
                label="Note for Claude"
                placeholder="Optional note…"
                value={item.message}
                submitLabel="Save"
                onSubmit={(value: string) => edit($, item.id, it => { it.message = value.trim() })}
              />
            ) : item.message ? <Text>Note: {item.message}</Text> : null}
            <Button key={`send-${item.id}`} label="Send to Claude" variant="primary" onPress={() => sendNow($)} />
            <Box flexDirection="row" gap={1}>
              {item.kind === 'screen' ? <Button key={`more-${item.id}`} label="Draw more" onPress={() => launch($, ['edit', item.id])} /> : null}
              <Button key={`drop-${item.id}`} label="Discard" onPress={async () => { await helper($, ['discard', item.id]); await scan($) }} />
            </Box>
          </Box>
        ))}
      </Box>
    )
  })
}

// One line under the comments: what the pins point at is read by OCR when sending.
function c0(item: RedlineItem): string {
  const withText = item.comments.filter(c => !c.removed && c.ocr).length
  return withText ? `OCR found the text under ${withText === 1 ? '1 pin' : `${withText} pins`}.` : ''
}
