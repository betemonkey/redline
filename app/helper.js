#!/usr/bin/env node
// Redline helper: freeze the screen, let you draw on it in place, queue the result for Claude.
//   node helper.js capture          freeze, drag a box, draw right on the frozen screen
//   node helper.js edit <id>        reopen a queued redline with its marks ("Draw more")
//   node helper.js open <png>       open the editor on an existing image (tests; REDLINE_NO_BROWSER=1 prints the URL)
//   node helper.js text <file>      Redline Text: a conversation (.json, kept up to date by the mod) or one reply (.md) to review
//   node helper.js claim            move every queued redline to sent/ and print them as JSON
//   node helper.js discard [id]     drop queued redlines (moved to discarded/, nothing deleted)
'use strict'
const fs = require('fs')
const path = require('path')
const http = require('http')
const { spawn, spawnSync } = require('child_process')

const APP = __dirname
const SESSION = (process.argv.find(a => a.startsWith('--session=')) || '').slice(10)
process.argv = process.argv.filter(a => !a.startsWith('--session='))
const DATA = process.env.REDLINE_DATA || path.join(process.env.LOCALAPPDATA || require('os').homedir(), 'Redline')
const dir = name => { const d = path.join(DATA, name); fs.mkdirSync(d, { recursive: true }); return d }
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
  .find(p => fs.existsSync(p))
// CalculateNativeWinOcclusion off: Edge would otherwise treat the editor as hidden behind the frozen overlay and pause it.
const EDGE_FLAGS = ['--no-first-run', '--no-default-browser-check',
  '--disable-features=CalculateNativeWinOcclusion,msEdgeSidebarV2,msHubApps,msUndersideButton']
const psArgs = (script, args) => ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(APP, script), ...args]
const ps = (script, args) => spawnSync('powershell.exe', psArgs(script, args), { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
const psBg = (script, args) => spawn('powershell.exe', psArgs(script, args), { windowsHide: true, stdio: 'ignore' })

// Redline's preferences (the palette), kept with the data so every window sees the same choice.
function prefs(req, send) {
  const file = path.join(DATA, 'prefs.json')
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} } }
  if (req.method === 'GET') return send(200, 'application/json', JSON.stringify(read()))
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    try {
      const p = JSON.parse(body), next = read()
      if (/^(auto|black|steam|slate|forest|ember|light)$/.test(p.palette)) next.palette = p.palette
      fs.writeFileSync(file, JSON.stringify(next))
      send(200, 'application/json', JSON.stringify(next))
    } catch { send(400, 'text/plain', 'bad prefs') }
  })
}

function readPngSize(file) {
  const b = fs.readFileSync(file)
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

// Redline's own Edge, windowless, kept running: a cold Edge takes ~14 s to show the editor, a warm one well under 1 s.
// When it already runs this hands off and does nothing.
function warm() {
  if (!EDGE || process.env.REDLINE_NO_BROWSER) return
  spawn(EDGE, [`--user-data-dir=${dir('edge')}`, '--no-startup-window', ...EDGE_FLAGS], { detached: true, stdio: 'ignore' }).unref()
}

function capture(rect) {
  warm() // gets a head start while you drag the box
  const id = stamp()
  const screen = path.join(dir('captures'), `${id}.png`)
  const ready = path.join(dir('tmp'), `${id}.ready`)
  const extra = rect && rect.startsWith('auto:') ? ['-AutoRect', rect.slice(5), '-Ready', ready] // tests: real overlay, box picked by itself
    : rect ? ['-Rect', rect] : ['-Ready', ready] // a fixed box (tests) skips the drag
  const child = spawn('powershell.exe', psArgs('capture.ps1', ['-Out', screen, ...extra]), { windowsHide: true })
  let out = '', started = false
  child.stdout.on('data', d => {
    out += d
    const nl = out.indexOf('\n')
    if (started || nl < 0) return
    started = true
    const pick = JSON.parse(out.slice(0, nl))
    session({ id, screen, monitor: pick.monitor, sel: pick.sel, scale: pick.scale || 1, ready })
  })
  child.on('exit', code => { if (!started) process.exit(code === 2 ? 0 : 1) })
}

function edit(id) {
  const file = path.join(dir('queue'), `${id}.json`)
  const item = JSON.parse(fs.readFileSync(file, 'utf8'))
  session({ id, screen: item.screen, monitor: item.monitor, sel: item.sel, scale: item.scale || 1, state: item.state, message: item.message, session: item.session })
}

function openImage(png) {
  const size = readPngSize(png)
  session({ id: stamp(), screen: png, monitor: { x: 0, y: 0, w: size.width, h: size.height }, sel: { x: 0, y: 0, w: size.width, h: size.height } })
}

// One editing session: a local page over the frozen screen; ends on Send, Cancel or the window closing.
function session(s) {
  const title = `Redline ${s.id}`
  let timer = null
  const log = line => { try { fs.appendFileSync(path.join(dir('tmp'), `${s.id}.log`), `${new Date().toISOString()} ${line}
`) } catch {} }
  const bye = ms => { clearTimeout(timer); timer = setTimeout(() => { closeWindow(); process.exit(0) }, ms) }
  const closeWindow = () => { if (!process.env.REDLINE_NO_BROWSER) ps('place.ps1', ['-Title', title, '-Close']) }
  bye(60 * 60 * 1000) // never linger more than an hour

  const server = http.createServer((req, res) => {
    const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body) }
    const url = req.url.split('?')[0]
    if (req.method === 'GET' && url === '/') return send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(APP, 'annotator.html')))
    if (req.method === 'GET' && url === '/screen.png') return send(200, 'image/png', fs.readFileSync(s.screen))
    if (req.method === 'GET' && url === '/meta') {
      return send(200, 'application/json', JSON.stringify({ id: s.id, title, ...readPngSize(s.screen), sel: s.sel, state: s.state || null, message: s.message || '' }))
    }
    if (req.method === 'POST' && url === '/opened') {
      let body = ''; req.on('data', c => { body += c }); req.on('end', () => log(`opened ${body}`))
      send(200, 'text/plain', 'ok')
      // The editor is drawn: let the frozen overlay step aside, then give the editor the keyboard.
      if (s.ready) { fs.writeFileSync(s.ready, ''); setTimeout(() => psBg('place.ps1', ['-Title', title, '-Focus']), 350) }
      return bye(60 * 60 * 1000)
    }
    if (req.method === 'POST' && (url === '/cancel' || url === '/closed')) { send(200, 'text/plain', 'ok'); return bye(url === '/cancel' ? 50 : 4000) }
    if (req.method === 'POST' && url === '/send') {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        try {
          const item = finish(JSON.parse(body), s)
          send(200, 'application/json', JSON.stringify({ ok: true, id: item.id }))
          bye(400)
        } catch (err) {
          send(500, 'application/json', JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
        }
      })
      return
    }
    if (url === '/prefs') return prefs(req, send) // the colour palette both Redline windows share
    send(404, 'text/plain', 'not found')
  })
  server.listen(0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}/?t=${encodeURIComponent(title)}`
    if (process.env.REDLINE_NO_BROWSER) { console.log(url); return }
    if (!EDGE) { spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref(); return }
    const m = s.monitor
    // Edge's own fullscreen on the monitor the box is on: aim the window at that monitor's middle
    // (Edge takes positions in system-DPI units), then fullscreen snaps it to the whole monitor.
    const k = s.scale || 1
    const px = Math.round((m.x + m.w / 2) / k - 300), py = Math.round((m.y + m.h / 2) / k - 200)
    log(`launch monitor=${JSON.stringify(m)} scale=${k} pos=${px},${py}`)
    spawn(EDGE, [`--app=${url}`, `--user-data-dir=${dir('edge')}`, ...EDGE_FLAGS, `--window-position=${px},${py}`, '--window-size=600,400', '--start-fullscreen'],
    { detached: true, stdio: 'ignore' }).unref()
    // A warm Edge ignores the window flags: move the window onto the monitor and make it fullscreen there.
    psBg('place.ps1', ['-Title', title, '-X', m.x, '-Y', m.y, '-W', m.w, '-H', m.h, '-Fullscreen'].map(String))
  })
}

// Turns what the editor sent into a queue item: marked-up PNG, a small JPEG for Claude's panel, comments + OCR.
function finish(payload, s) {
  const q = dir('queue')
  const image = path.join(q, `${s.id}.png`)
  fs.writeFileSync(image, Buffer.from(String(payload.png).replace(/^data:image\/png;base64,/, ''), 'base64'))

  const regions = (payload.regions || []).filter(r => r.w > 3 && r.h > 3)
  const ocr = {}
  if (regions.length) {
    const rf = path.join(dir('tmp'), `${s.id}-regions.json`)
    fs.writeFileSync(rf, JSON.stringify(regions))
    const r = ps('ocr.ps1', ['-Image', s.screen, '-Regions', rf])
    try { for (const o of JSON.parse(r.stdout.trim() || '[]')) ocr[o.id] = (o.text || '').trim() } catch { /* OCR is a bonus: the image still goes */ }
  }
  const item = {
    id: s.id,
    created: new Date().toISOString(),
    image,
    screen: s.screen,
    monitor: s.monitor,
    scale: s.scale || 1,
    sel: payload.sel || s.sel,
    sentSize: payload.sentSize || null,
    thumb: payload.thumb || '',
    message: (payload.message || '').trim(),
    comments: (payload.comments || []).map(c => ({ ...c, ocr: ocr[c.regionId] || '' })),
    marks: (payload.marks || []).map(m => ({ ...m, ocr: ocr[m.regionId] || '' })),
    state: payload.state || null,
    session: SESSION || s.session || '',
    autoSend: !!(SESSION || s.session), // sent straight into that session (a hotkey capture has none: it waits as a card)
  }
  // JSON last, through a rename: the mod treats a .json in queue/ as "ready".
  fs.writeFileSync(path.join(q, `${s.id}.json.tmp`), JSON.stringify(item, null, 2))
  fs.renameSync(path.join(q, `${s.id}.json.tmp`), path.join(q, `${s.id}.json`))
  return item
}

// Redline Text: Claude's reply in a scrolling page; select to comment, highlight, cross out, draw. No screenshot at all.
function text(file) {
  const id = stamp(), title = `Redline Text ${id}`
  // A .json file is the mirrored conversation the mod rewrites after every reply; a .md file is one reply.
  const load = () => file.endsWith('.json') ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : { messages: [{ role: 'assistant', text: fs.readFileSync(file, 'utf8') }] }
  let timer = null
  const bye = ms => { clearTimeout(timer); timer = setTimeout(() => process.exit(0), ms) }
  bye(3 * 60 * 60 * 1000)
  const server = http.createServer((req, res) => {
    const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body) }
    const url = req.url.split('?')[0]
    if (req.method === 'GET' && url === '/') return send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(APP, 'text.html')))
    if (req.method === 'GET' && url === '/doc') bye(3 * 60 * 60 * 1000) // (re)loaded: a refresh must not end the session
    if (req.method === 'GET' && url === '/doc') {
      try { return send(200, 'application/json', JSON.stringify((d => ({ title, live: file.endsWith('.json'), version: fs.statSync(file).mtimeMs, busy: !!d.busy, messages: d.messages }))(load()))) }
      catch (err) { return send(500, 'application/json', JSON.stringify({ error: String(err) })) } // mid-rewrite: the next poll gets it
    }
    if (req.method === 'POST' && url === '/closed') { send(200, 'text/plain', 'ok'); return bye(30000) }
    if (req.method === 'POST' && url === '/send-text') {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        try {
          const r = JSON.parse(body), q = dir('queue'), sid = stamp() // the window stays open: every send is its own item
          const item = { id: sid, kind: 'text', created: new Date().toISOString(), source: file, message: (r.message || '').trim(),
            comments: (r.comments || []).map(c => ({ n: c.n, text: c.text, ocr: c.quote, where: c.where, quotes: c.quotes })),
            highlights: r.highlights || [], crossed: r.crossed || [], drawn: r.drawn || [], session: SESSION, autoSend: !!SESSION }
          fs.writeFileSync(path.join(q, `${sid}.json.tmp`), JSON.stringify(item, null, 2))
          fs.renameSync(path.join(q, `${sid}.json.tmp`), path.join(q, `${sid}.json`))
          send(200, 'application/json', JSON.stringify({ ok: true, id: sid }))
        } catch (err) { send(500, 'application/json', JSON.stringify({ ok: false, error: String((err && err.message) || err) })) }
      })
      return
    }
    if (url === '/prefs') return prefs(req, send) // the colour palette both Redline windows share
    send(404, 'text/plain', 'not found')
  })
  server.listen(0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}/`
    if (process.env.REDLINE_NO_BROWSER || !EDGE) { console.log(url); if (!EDGE && !process.env.REDLINE_NO_BROWSER) spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref(); return }
    warm()
    spawn(EDGE, [`--app=${url}`, `--user-data-dir=${dir('edge')}`, ...EDGE_FLAGS, '--window-size=1280,960'], { detached: true, stdio: 'ignore' }).unref()
    psBg('place.ps1', ['-Title', title, '-Maximize'])
  })
}

function moveAll(to, only = []) {
  const q = dir('queue'), dest = dir(to), out = []
  for (const f of fs.readdirSync(q).filter(f => f.endsWith('.json') && (!only.length || only.includes(f.slice(0, -5)))).sort()) {
    let item
    try { item = JSON.parse(fs.readFileSync(path.join(q, f), 'utf8')) } catch { continue }
    try { fs.renameSync(path.join(q, f), path.join(dest, f)) } catch { continue } // another session claimed it first
    if (item.image) { // Redline Text items have no picture
      const png = path.join(dest, path.basename(item.image))
      try { fs.renameSync(item.image, png); item.image = png } catch { /* keep the old path */ }
    }
    fs.writeFileSync(path.join(dest, f), JSON.stringify(item, null, 2))
    out.push(item)
  }
  return out
}

const [cmd, arg] = process.argv.slice(2)
const ids = process.argv.slice(3)
if (cmd === 'warm') warm()
else if (cmd === 'capture') capture(arg) // arg: optional "x,y,w,h" in virtual-screen px, for tests
else if (cmd === 'edit') edit(arg)
else if (cmd === 'text') text(path.resolve(arg))
else if (cmd === 'open') openImage(path.resolve(arg))
else if (cmd === 'claim') process.stdout.write(JSON.stringify(moveAll('sent', ids).map(({ thumb, state, ...rest }) => rest)))
else if (cmd === 'discard') process.stdout.write(JSON.stringify(moveAll('discarded', ids).map(i => i.id)))
else { console.error('usage: helper.js capture | edit <id> | open <png> | claim | discard [id]'); process.exit(64) }
