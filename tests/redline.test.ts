import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { conversation, describe, pendingOf, summarise } from '../hooks/register.tsx'

// Stand-ins for the engine beneath the plugin: nothing queued, an empty band, the prompt's bottom.
function engine(on: On) {
  on('state.get', ($, e) => ({ value: e.key === 'menu' ? false : [], version: 1 }) as never)
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, null) as never })
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
}

test('above the chat box: the Redline button is always there, nothing else while nothing waits', async ($, on) => {
  engine(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'redline', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10 } as never })
    expect(await ui.find({ key: 'redline' })).toBeDefined()
    expect(await ui.find({ key: 'discard' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a message passes untouched when nothing is waiting', async ($, on) => {
  engine(on)
  const result = await $.prompt.submit({ text: 'hello' })
  expect(result.text).toBe('hello')
  expect(result.context ?? []).toEqual([])
})

test('removed pins are not counted and Claude is told to ignore them', () => {
  const p = pendingOf([{ id: 'x', thumb: '', width: 1, height: 1, message: '', marks: 2,
    comments: [{ n: 1, text: 'a' }, { n: 2, text: 'b', removed: true }] }])
  expect(p).toEqual({ captures: 1, comments: 1, marks: 2 })
  const text = describe({ id: 'x', image: 'C:/x.png', comments: [{ n: 1, text: 'a' }, { n: 2, text: 'b', removed: true }] })
  expect(text).toContain('#1 "a"')
  expect(text).not.toContain('#2 "b"')
  expect(text).toContain('He withdrew pin #2 after drawing: ignore it on the image.')
})

test('the band counts what is waiting', () => {
  expect(summarise({ captures: 1, comments: 2, marks: 1 })).toBe('1 capture · 2 comments · 1 mark')
  expect(summarise({ captures: 2, comments: 0, marks: 0 })).toBe('2 captures')
})

test('Claude gets the image path, the comments with their OCR text, and the marks', () => {
  const text = describe({
    id: 'x',
    image: 'C:/Redline/sent/x.png',
    sentSize: { width: 760, height: 200 },
    message: 'fix these two',
    comments: [{ n: 1, text: 'info not correct', ocr: 'Skill that teaches the agent' }],
    marks: [{ kind: 'highlight', colour: '#ffd60a', ocr: 'Multi-monitor capture' }, { kind: 'pen' }],
  })
  expect(text).toContain('Read tool before answering: C:/Redline/sent/x.png (760x200, marks drawn in)')
  expect(text).toContain('His note: "fix these two"')
  expect(text).toContain('#1 "info not correct" - pin points at text: "Skill that teaches the agent"')
  expect(text).toContain('- highlight (yellow) on: "Multi-monitor capture"')
  expect(text).not.toContain('- pen')
})

test('a Redline Text review reaches Claude as exact quotes, no picture to open', () => {
  const text = describe({
    id: 't', kind: 'text', message: 'mostly fine',
    comments: [{ n: 1, text: 'keep it casual', ocr: 'Who will look at it' }, { n: 2, text: 'x', ocr: 'y', removed: true }],
    highlights: ['A single repository'], crossed: ['runs Nginx Proxy Manager'], drawn: ['Day one: skeleton'],
  })
  expect(text).not.toContain('Read tool')
  expect(text).toContain('His note: "mostly fine"')
  expect(text).toContain('#1 on "Who will look at it": keep it casual')
  expect(text).toContain('He withdrew comment #2')
  expect(text).toContain('- "A single repository"')
  expect(text).toContain('- "runs Nginx Proxy Manager"')
  expect(text).toContain('Drew around (text under the drawing):')
})

test('the mirror shows your messages and Claude replies, a reply split by tool calls as one, tool results left out', () => {
  const msgs = conversation([
    { role: 'user', text: 'plan my site' },
    { role: 'assistant', text: 'Looking at your repo first.' },
    { role: 'user', text: 'file contents', toolResults: [{}] },
    { role: 'assistant', text: 'Here is the plan.' },
    { role: 'assistant', text: '' },
    { role: 'user', text: 'friends mostly' },
  ])
  expect(msgs).toEqual([
    { role: 'user', text: 'plan my site' },
    { role: 'assistant', text: 'Looking at your repo first.\n\nHere is the plan.' },
    { role: 'user', text: 'friends mostly' },
  ])
})

test('quotes say which message they are in', () => {
  const text = describe({ id: 't', kind: 'text', comments: [{ n: 1, text: 'yes', ocr: 'Employers', where: 'your reply 1 of 2' }], highlights: [{ quote: 'friends mostly', where: 'my message 2 of 2' }] })
  expect(text).toContain('#1 on "Employers" (your reply 1 of 2): yes')
  expect(text).toContain('- "friends mostly" (my message 2 of 2)')
})

test('one comment for several marks lists every quote, cross-outs and drawings named', () => {
  const text = describe({ id: 't', kind: 'text', comments: [{ n: 1, text: 'simpler please', quotes: [
    { quote: 'static site', where: 'your latest reply' },
    { quote: 'own domain', where: 'your latest reply', crossed: true },
    { quote: '', drawn: true },
  ] }] })
  expect(text).toContain('#1 on "static site" (your latest reply) + (crossed out) "own domain" (your latest reply) + a drawing: simpler please')
})
