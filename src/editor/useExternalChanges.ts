import { useEffect, useRef, useState } from 'react'
import { desktop, inspectDocument } from '../platform/storage'
import { decodeFile, type FileSnapshot } from '../core/codec'
import { listenForFocus } from '../platform/window'

export type ExternalChange = { revision: string; snapshot: FileSnapshot } | { error: string }

// One bounded read per active document. Generation guards discard replies from
// a prior tab/base revision; a timed-out native read retains its single-flight
// slot until it finishes, rather than accumulating background IO.
export function useExternalChanges(fileId: string | null, revision: string | null, enabled: boolean) {
  const [change, setChange] = useState<ExternalChange | null>(null)
  const [checking, setChecking] = useState(false)
  const blocked = useRef(false), inFlight = useRef(false), generation = useRef(0)
  const retry = useRef<() => void>(() => undefined)
  useEffect(() => { setChange(null); blocked.current = false }, [fileId, revision])
  useEffect(() => {
    if (!desktop || !fileId || !enabled) { setChecking(false); return }
    const token = ++generation.current
    let timer: number | undefined, deadline: number | undefined, queued = false
    const check = () => {
      if (token !== generation.current || document.visibilityState === 'hidden') return
      blocked.current = true; setChecking(true)
      if (inFlight.current) {
        queued = true
        if (deadline === undefined) deadline = window.setTimeout(() => {
          if (token === generation.current) { setChecking(false); setChange({ error: '仍在等待上一项磁盘检查；当前编辑已保留，请稍后重试或另存副本。' }) }
        }, 10000)
        return
      }
      let expired = false
      window.clearTimeout(deadline)
      deadline = window.setTimeout(() => {
        expired = true
        if (token === generation.current) { setChecking(false); setChange({ error: '检查磁盘版本超时；当前编辑已保留，请重试或另存副本。' }) }
      }, 10000)
      queued = false; inFlight.current = true
      void inspectDocument(fileId, revision).then(result => {
        if (expired || token !== generation.current) return
        if (result.revision === revision) { setChange(null); blocked.current = false }
        else {
          if (!result.bytes) throw new Error('磁盘版本变化，但未读取到正文。')
          try { setChange({ revision: result.revision, snapshot: decodeFile(result.bytes) }) }
          catch { throw new Error('磁盘正文不是支持的 UTF-8 Markdown，当前编辑已保留。') }
        }
      }).catch(error => {
        if (!expired && token === generation.current) setChange({ error: error instanceof Error ? error.message : String(error) })
      }).finally(() => {
        window.clearTimeout(deadline); deadline = undefined; inFlight.current = false
        if (token === generation.current) setChecking(false)
        // A new generation may be waiting for this old read to release its slot.
        retry.current()
      })
    }
    const request = () => { blocked.current = true; window.clearTimeout(timer); timer = window.setTimeout(check, 150) }
    retry.current = () => { if (queued && token === generation.current) request() }
    const visibility = () => { if (document.visibilityState === 'visible') request() }
    let unlisten: (() => void) | undefined
    void listenForFocus(request).then(stop => { if (token !== generation.current) stop(); else unlisten = stop }).catch(() => undefined)
    window.addEventListener('focus', request)
    document.addEventListener('visibilitychange', visibility)
    check()
    return () => {
      generation.current++; window.clearTimeout(timer); window.clearTimeout(deadline)
      unlisten?.()
      window.removeEventListener('focus', request); document.removeEventListener('visibilitychange', visibility)
    }
  }, [fileId, revision, enabled])
  return { change, checking, blocked, recheck: () => { window.dispatchEvent(new Event('focus')) } }
}
