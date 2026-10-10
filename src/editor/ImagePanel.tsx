import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { defaultRecipe, imageGeometry, type ImageRecipe } from '../core/images'
import { processImage, type ImageResult } from '../platform/images'

export interface ImageEdit {
  source: Blob
  width: number
  height: number
  alt: string
  recipe: ImageRecipe
}

interface Props { image: ImageEdit; onCancel(): void; onBusy(busy: boolean): void; onChange(recipe: ImageRecipe, alt: string): void; onApply(result: ImageResult, recipe: ImageRecipe, alt: string): Promise<void> }

export function ImagePanel({ image, onCancel, onBusy, onChange, onApply }: Props) {
  const [recipe, setRecipe] = useState<ImageRecipe>(image.recipe)
  const [alt, setAlt] = useState(image.alt)
  const [lock, setLock] = useState(true)
  const [zoom, setZoom] = useState(100)
  const [error, setError] = useState('')
  const [applying, setApplying] = useState(false)
  const [rendering, setRendering] = useState(true)
  const [preview, setPreview] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')
  const dialog = useRef<HTMLDivElement>(null)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const operation = useRef<AbortController | null>(null)
  const closed = useRef(false)
  const changed = useRef(onChange); changed.current = onChange
  const reportBusy = useRef(onBusy); reportBusy.current = onBusy
  useEffect(() => { changed.current(recipe, alt) }, [recipe, alt])
  useEffect(() => { reportBusy.current(applying); return () => reportBusy.current(false) }, [applying])
  const crop = recipe.crop ?? { unit: 'sourcePixel' as const, x: 0, y: 0, width: image.width, height: image.height }

  useEffect(() => {
    closed.current = false
    const url = URL.createObjectURL(image.source); setSourceUrl(url)
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !dialog.current?.contains(document.activeElement)) return
      const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)') ?? [])
      const first = items[0], last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', trap)
    return () => { closed.current = true; operation.current?.abort(); URL.revokeObjectURL(url); previous?.focus(); document.removeEventListener('keydown', trap) }
  }, [image.source])

  useEffect(() => {
    const controller = new AbortController()
    let url = ''
    setRendering(true); setError('')
    const timer = window.setTimeout(() => {
      processImage(image.source, recipe, controller.signal).then((result) => {
        if (controller.signal.aborted) return
        url = URL.createObjectURL(result.blob); setPreview(url); setRendering(false)
      }).catch((err) => { if (!controller.signal.aborted) { setError(err.message); setRendering(false) } })
    }, 180)
    return () => { clearTimeout(timer); controller.abort(); if (url) URL.revokeObjectURL(url) }
  }, [image.source, recipe])

  const cancel = () => { operation.current?.abort(); onCancel() }
  const updateCrop = (field: keyof Omit<typeof crop, 'unit'>, value: number) => setRecipe({ ...recipe, crop: { ...crop, [field]: value }, resize: undefined })
  function preset(ratio?: number) {
    let width = image.width, height = image.height
    if (ratio) { width = Math.min(width, Math.floor(height * ratio)); height = Math.min(height, Math.floor(width / ratio)) }
    setRecipe({ ...recipe, crop: { unit: 'sourcePixel', x: Math.floor((image.width - width) / 2), y: Math.floor((image.height - height) / 2), width, height }, resize: undefined })
  }
  let output = { width: crop.width, height: crop.height }
  try { output = imageGeometry(image.width, image.height, recipe).output } catch { /* Inline error is provided by the processor. */ }
  function resize(field: 'width' | 'height', value: number) {
    const rotated = recipe.rotateDegrees % 180 ? { width: crop.height, height: crop.width } : crop
    const next = { ...output, [field]: value }
    if (lock) next[field === 'width' ? 'height' : 'width'] = Math.max(1, Math.round(value * (field === 'width' ? rotated.height / rotated.width : rotated.width / rotated.height)))
    setRecipe({ ...recipe, resize: next })
  }
  function point(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    return { x: Math.max(0, Math.min(image.width - 1, Math.round((event.clientX - bounds.left) / bounds.width * image.width))), y: Math.max(0, Math.min(image.height - 1, Math.round((event.clientY - bounds.top) / bounds.height * image.height))) }
  }
  async function apply() {
    if (applying) return
    const controller = new AbortController(); operation.current = controller
    setApplying(true); setError('')
    try {
      const result = await processImage(image.source, recipe, controller.signal)
      if (!controller.signal.aborted) await onApply(result, recipe, alt)
    } catch (err) { if (!controller.signal.aborted && !closed.current) setError(err instanceof Error ? err.message : '应用失败，原版本仍保留。') }
    finally { if (!closed.current) setApplying(false) }
  }

  return <div className="modal-backdrop" onKeyDown={(event) => { if (event.key === 'Escape' && !applying) { event.stopPropagation(); cancel() } }}>
    <div ref={dialog} className="image-dialog" role="dialog" aria-modal="true" aria-labelledby="image-title">
      <div className="panel-title"><div><strong id="image-title">编辑图片副本</strong><span>源副本 {image.width} × {image.height} · 修改只影响当前引用</span></div><button aria-label="取消图片编辑" disabled={applying} onClick={cancel}>×</button></div>
      <fieldset disabled={applying} className="image-controls">
        <div className="image-crop-stage">
          <p>在源图片上拖动选择裁剪范围，也可输入坐标。</p>
          <div className="crop-surface" style={{ aspectRatio: `${image.width}/${image.height}` }} onPointerDown={(event) => { pointer.current = point(event); event.currentTarget.setPointerCapture(event.pointerId) }} onPointerMove={(event) => {
            if (!pointer.current) return
            const end = point(event), start = pointer.current
            setRecipe({ ...recipe, crop: { unit: 'sourcePixel', x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.max(1, Math.abs(end.x - start.x)), height: Math.max(1, Math.abs(end.y - start.y)) }, resize: undefined })
          }} onPointerUp={() => { pointer.current = null }} onPointerCancel={() => { pointer.current = null }}>
            <img src={sourceUrl || undefined} alt="裁剪源图片" draggable={false} />
            <div className="crop-overlay" style={{ left: `${crop.x / image.width * 100}%`, top: `${crop.y / image.height * 100}%`, width: `${crop.width / image.width * 100}%`, height: `${crop.height / image.height * 100}%` }} />
          </div>
          <div className="ratio-picker">{[['自由', undefined], ['1:1', 1], ['4:3', 4 / 3], ['16:9', 16 / 9]].map(([label, ratio]) => <button key={label} onClick={() => preset(ratio as number | undefined)}>{label}</button>)}</div>
          <div className="crop-fields">{(['x', 'y', 'width', 'height'] as const).map((field) => <label key={field}>{ { x: '裁剪 X', y: '裁剪 Y', width: '裁剪宽', height: '裁剪高' }[field]}<input type="number" min={field === 'x' || field === 'y' ? 0 : 1} value={crop[field]} onChange={(event) => updateCrop(field, Number(event.target.value))} /></label>)}</div>
        </div>
        <div className="image-settings">
          <label className="field-label">Alt 文本<input className="alt-input" value={alt} onChange={(event) => setAlt(event.target.value)} /></label>
          <div className="size-fields"><label>输出宽<input type="number" min="1" max="8192" value={output.width} onChange={(event) => resize('width', Number(event.target.value))} /></label><span>×</span><label>输出高<input type="number" min="1" max="8192" value={output.height} onChange={(event) => resize('height', Number(event.target.value))} /></label></div>
          <label className="check-field"><input type="checkbox" checked={lock} onChange={(event) => setLock(event.target.checked)} />锁定宽高比</label>
          <div className="transform-buttons"><button onClick={() => setRecipe({ ...recipe, rotateDegrees: ((recipe.rotateDegrees + 90) % 360) as ImageRecipe['rotateDegrees'], resize: undefined })}>旋转 90°</button><button aria-pressed={recipe.flipHorizontal} onClick={() => setRecipe({ ...recipe, flipHorizontal: !recipe.flipHorizontal })}>水平翻转</button><button aria-pressed={recipe.flipVertical} onClick={() => setRecipe({ ...recipe, flipVertical: !recipe.flipVertical })}>垂直翻转</button></div>
          <label className="field-label">输出格式<select value={recipe.output.mime} onChange={(event) => setRecipe({ ...recipe, output: { mime: event.target.value as ImageRecipe['output']['mime'] } })}><option value="image/png">PNG（保留透明）</option><option value="image/jpeg">JPEG（白色背景）</option></select></label>
          <label className="field-label">查看倍率（仅预览）<input type="range" min="25" max="200" step="25" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} />{zoom}%</label>
          <div className="result-preview" aria-label="图片修改预览">{preview && <img src={preview} alt={alt || '输出预览'} style={{ width: `${zoom}%` }} />}</div>
          <button className="restore-button" onClick={() => setRecipe({ ...defaultRecipe(image.recipe.output.mime), orientationNormalized: true })}>恢复源副本</button>
        </div>
      </fieldset>
      {error && <p className="image-error" role="alert">{error}</p>}
      <div className="panel-actions"><span role="status">{applying ? '正在生成并应用图片…' : rendering ? '正在更新预览…' : '图片修改待应用'}</span><button disabled={applying} onClick={cancel}>取消</button><button className="apply-button" disabled={applying || rendering || !!error} onClick={() => void apply()}>应用修改</button></div>
    </div>
  </div>
}
