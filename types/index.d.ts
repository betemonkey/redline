/** One comment pin as the side panel shows it; `removed` = the user dropped it after drawing. */
export type RedlineComment = {
  n: number
  text: string
  ocr?: string
  removed?: boolean
  where?: string
  /** Redline Text: one comment for several marks (highlights, cross-outs, drawings), each with its quote */
  quotes?: { quote: string; where?: string; drawn?: boolean; crossed?: boolean }[]
}

/** A redline waiting in the queue (sent from the editor, not yet attached to a message). */
export type RedlineItem = {
  id: string
  /** 'screen' = a marked-up capture, 'text' = a Redline Text review (exact quotes, no picture) */
  kind: 'screen' | 'text'
  thumb: string
  width: number
  height: number
  message: string
  comments: RedlineComment[]
  marks: number
}

/** What is waiting in the queue, summed up for the band. */
export type RedlinePending = { captures: number; comments: number; marks: number }

declare module 'claude-code' {
  interface PluginState {
    redline: { queue: RedlineItem[]; menu: boolean }
  }
}
