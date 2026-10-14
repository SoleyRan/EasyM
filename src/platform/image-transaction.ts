import { applyPatches, imageMarkdown, insertImage, type Selection, type TextPatch } from '../core/document'
import type { ImageInstance, ImageRecipe } from '../core/images'
import { addResources, type ImageResources, type ImageResult } from './images'

interface Change {
  text: string
  baseText: string
  selection: Selection
  replaceImage: boolean
  resources: ImageResources
  instance: ImageInstance
  source: Blob
  result: ImageResult
  recipe: ImageRecipe
  alt: string
  displayPath: string
}

// Persist resources and the proposed body before exposing a new reference in the editor.
export async function commitImageChange(change: Change, persist: (text: string, resources: ImageResources) => Promise<void>, patch: (patch: TextPatch) => boolean): Promise<ImageResources> {
  if (change.text !== change.baseText) throw new Error('正文已变化，请取消后重新选择图片。')
  const instance = { ...change.instance, displayPath: change.displayPath, recipe: change.recipe }
  const next = addResources(change.resources, { [instance.sourcePath]: change.source, [instance.displayPath]: change.result.blob }, instance)
  const command = insertImage(change.text, change.selection, imageMarkdown(change.alt, instance.displayPath), change.replaceImage)
  const text = applyPatches(change.text, command.patches)
  await persist(text, next)
  if (!patch(command.patches[0])) throw new Error('无法提交正文，请重新打开已保存文件。')
  return next
}
