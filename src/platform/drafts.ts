import type { FileSnapshot } from '../core/codec'
import type { ImageResources } from './images'
import type { ImageSession } from '../core/image-session'

export interface Draft {
  version: 1
  name: string
  text: string
  snapshot: FileSnapshot
  updatedAt: number
  documentId?: string
  fileId?: string | null
  baseRevision?: string | null
  resources?: ImageResources
  imageSession?: ImageSession | null
}

function connect(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('easym-drafts', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('drafts')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
    request.onblocked = () => reject(new Error('草稿数据库被其他窗口锁定。'))
  })
}

async function access(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
  const db = await connect()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('drafts', mode)
    const request = action(transaction.objectStore('drafts'))
    transaction.oncomplete = () => { db.close(); resolve(request.result) }
    transaction.onerror = () => { db.close(); reject(transaction.error) }
    transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error('草稿保存被中断。')) }
  })
}

export const drafts = {
  load: async (): Promise<Draft | undefined> => {
    const draft = await access('readonly', (store) => store.get('current')) as Draft | undefined
    if (draft && draft.version !== 1) throw new Error('草稿格式不兼容，已保留原数据。')
    return draft
  },
  save: (draft: Draft): Promise<unknown> => access('readwrite', (store) => store.put(draft, 'current')),
  clear: (): Promise<unknown> => access('readwrite', (store) => store.delete('current')),
}
