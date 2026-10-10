import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { defaultRecipe } from '../core/images'
import { materializeResources, saveDocument } from './storage'

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }))
const instance = { instanceId: 'img-one', documentId: null, sourcePath: 'assets/.originals/img-one-source.png', displayPath: 'assets/img-one-v1.png', sourceHash: 'sha256:source', recipe: defaultRecipe(), referenceRevision: 1 }
const file = { id: 'authorized-id', name: 'note.md', revision: 'sha256:old' }

beforeEach(() => { vi.mocked(invoke).mockReset() })

describe('native resource closure', () => {
  it('hydrates source and display bytes for draft recovery and save-as', async () => {
    vi.mocked(invoke).mockResolvedValue({ bytes: [1, 2, 3], mime: 'image/png' })
    const input = { assets: {}, instances: [instance] }
    const restored = await materializeResources(file.id, input)
    expect(Object.keys(restored.assets)).toEqual([instance.sourcePath, instance.displayPath])
    expect(input.assets).toEqual({})
    expect(await restored.assets[instance.sourcePath].arrayBuffer()).toEqual(Uint8Array.from([1, 2, 3]).buffer)
    expect(invoke).toHaveBeenCalledWith('read_image', { id: file.id, relativePath: instance.sourcePath })
  })

  it('reuses the self-contained draft after its previous native session expires', async () => {
    const assets = { [instance.sourcePath]: new Blob(['source']), [instance.displayPath]: new Blob(['display']) }
    const input = { assets, instances: [instance] }
    expect(await materializeResources(null, input)).toEqual(input)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('copies managed images before saving the document at a new location', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => command === 'read_image' ? { bytes: [1], mime: 'image/png' } : { id: 'new-id', name: 'copy.md', revision: 'sha256:new' })
    const bytes = new TextEncoder().encode(`![one](${instance.displayPath})`)
    const operationId = crypto.randomUUID()
    await saveDocument(file, bytes, true, { assets: {}, instances: [instance] }, operationId)
    const request = vi.mocked(invoke).mock.calls.find(([command]) => command === 'save_document')?.[1]
    expect(request).toMatchObject({ saveAs: true, assets: [{ path: instance.sourcePath, bytes: [1] }, { path: instance.displayPath, bytes: [1] }], operationId })
  })

  it('refuses a save-as with missing local images before writing text', async () => {
    await expect(saveDocument(file, new TextEncoder().encode('![missing](pictures/a.png)'), true, { assets: {}, instances: [] })).rejects.toThrow('未托管或缺失图片')
    expect(invoke).not.toHaveBeenCalledWith('save_document', expect.anything())
  })
})
