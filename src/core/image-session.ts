import type { Selection } from './document'
import type { ImageInstance, ImageRecipe } from './images'
import type { ImageReference } from './markdown'

// Structured-cloneable: the source blob and pending recipe travel with the body draft.
export interface ImageSession {
  source: Blob
  width: number
  height: number
  alt: string
  recipe: ImageRecipe
  target: ImageReference | null
  selection: Selection
  baseText: string
  instance: ImageInstance
  operationId: string
  displayToken: string
}
