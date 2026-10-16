import { applyPatches, type EditCommandResult, type Selection } from './document'
import { insertionDefinitions } from './quick-entry'

export interface CommandContext {
  documentId: string
  fileId: string | null
  textRevision: number
  selection: Selection
  active: boolean
  reading: boolean
  editorMode?: 'source' | 'split' | 'live'
  composing: boolean
  lockReason?: string
}
export interface CommandStatus { enabled: boolean; reason?: string; checked?: boolean | 'mixed' }
export interface CommandDefinition {
  id: string
  label: string
  aliases: readonly string[]
  group: string
  shortcut?: string
  allowReading?: boolean
}
export interface RegisteredCommand extends CommandDefinition {
  status?(context: CommandContext): CommandStatus
  run(context: CommandContext, argument?: unknown): void | boolean | Promise<void | boolean>
}

const definition = (id: string, label: string, group: string, aliases: string[], shortcut?: string, allowReading = false): CommandDefinition => ({ id, label, group, aliases, shortcut, allowReading })
export const commandDefinitions = [
  definition('format.bold', '加粗', '格式', ['bold'], 'Mod+B'),
  definition('format.italic', '斜体', '格式', ['italic'], 'Mod+I'),
  definition('format.strike', '删除线', '格式', ['strikethrough'], 'Mod+Shift+X'),
  definition('format.inlineCode', '行内代码', '格式', ['inline code']),
  definition('format.heading', '标题', '格式', ['heading'], 'Mod+Shift+H'),
  definition('format.bullet', '无序列表', '格式', ['bullet list'], 'Mod+Shift+U'),
  definition('format.ordered', '有序列表', '格式', ['ordered list'], 'Mod+Shift+O'),
  definition('format.task', '任务列表', '格式', ['task list'], 'Mod+Shift+T'),
  definition('format.quote', '引用', '格式', ['quote'], 'Mod+Shift+Q'),
  definition('format.code', '代码块', '格式', ['code block'], 'Mod+Shift+C'),
  definition('format.link', '链接', '格式', ['link'], 'Mod+K'),
  definition('code.language', '代码块语言', '格式', ['language']),
  definition('content.language', '选择代码语言', '格式', ['choose language']),
  definition('paragraph.convert', '转换为', '格式', ['convert paragraph', 'heading', 'list']),
  definition('insert.image', '插入图片', '插入', ['image'], 'Mod+Shift+P'),
  definition('insert.table', '插入表格', '插入', ['table']),
  ...insertionDefinitions,
  definition('table.edit', '编辑表格', '编辑', ['edit table']),
  definition('edit.undo', '撤销', '编辑', ['undo'], 'Mod+Z'),
  definition('edit.redo', '重做', '编辑', ['redo'], 'Mod+Shift+Z'),
  definition('edit.search', '查找 / 替换', '编辑', ['find', 'replace'], 'Mod+F'),
  ...(['source', 'split', 'live'] as const).map((mode, index) => definition(`view.${mode}`, ['源码', '分屏', '即时渲染'][index], '视图', [mode])),
  definition('view.reading', '阅读模式', '视图', ['reading'], undefined, true),
  definition('view.files', '文件树', '视图', ['files', 'workspace tree'], undefined, true),
  definition('view.outline', '大纲', '视图', ['outline'], undefined, true),
  definition('view.toolbar', '格式工具栏', '视图', ['toolbar']),
  definition('file.new', '新建文档', '文件', ['new']),
  definition('file.open', '打开文件', '文件', ['open']),
  definition('file.workspace', '打开工作区', '文件', ['workspace']),
  definition('file.save', '保存', '文件', ['save'], 'Mod+S'),
  definition('file.saveAs', '另存为 / 冲突副本', '文件', ['save as']),
  definition('file.reload', '重新加载外部版本', '文件', ['reload']),
  definition('file.exportHtml', '导出 HTML', '导出', ['export html']),
  definition('file.exportDocx', '导出 DOCX', '导出', ['export docx']),
  definition('file.print', '打印 / PDF', '导出', ['print', 'pdf'], 'Mod+P'),
  definition('file.history', '版本历史', '文件', ['history']),
  definition('file.mergeRecovery', '合并恢复记录', '文件', ['merge recovery']),
  definition('file.backup', '文档备份与恢复', '文件', ['backup', 'restore']),
  definition('file.batchImages', '批量处理图片', '文件', ['batch images']),
  definition('app.template', '从模板新建', '文件', ['template']),
  definition('app.settings', '设置', '应用', ['settings']),
  definition('app.recent', '最近打开', '文件', ['recent files', 'recent workspace']),
  definition('app.commands', '命令面板', '应用', ['command palette'], 'F1', true),
  definition('app.quickOpen', '快速打开', '文件', ['quick open', 'filename'], 'Mod+Alt+O'),
] as const

export function sameCommandTarget(a: CommandContext, b: CommandContext): boolean {
  return a.documentId === b.documentId && a.fileId === b.fileId && a.textRevision === b.textRevision && a.selection.anchor === b.selection.anchor && a.selection.head === b.selection.head
}

export class CommandRegistry {
  private readonly commands = new Map<string, RegisteredCommand>()
  constructor(private readonly context: () => CommandContext) {}
  register(command: RegisteredCommand) {
    if (this.commands.has(command.id)) throw new Error(`Duplicate command: ${command.id}`)
    this.commands.set(command.id, command)
  }
  list(): CommandDefinition[] { return [...this.commands.values()] }
  capture(): CommandContext {
    const context = this.context()
    // CodeMirror SelectionRange exposes anchor/head through prototype getters.
    return { ...context, selection: { anchor: context.selection.anchor, head: context.selection.head } }
  }
  status(id: string, expected?: CommandContext): CommandStatus {
    const command = this.commands.get(id), context = this.context()
    if (!command) return { enabled: false, reason: '命令尚不可用。' }
    if (expected && !sameCommandTarget(expected, context)) return { enabled: false, reason: '正文或选区已变化，请重新选择后操作。' }
    if (!context.active) return { enabled: false, reason: '请切换到目标文档后操作。' }
    if (context.composing) return { enabled: false, reason: '请先完成输入法组合输入。' }
    if (context.lockReason) return { enabled: false, reason: context.lockReason }
    if (context.reading && !command.allowReading) return { enabled: false, reason: '请先退出阅读模式。' }
    return command.status?.(context) ?? { enabled: true }
  }
  async execute(id: string, argument?: unknown, expected?: CommandContext): Promise<CommandStatus> {
    const status = this.status(id, expected)
    if (!status.enabled) return status
    // Invoke synchronously before yielding so task locks are acquired by the handler.
    const result = await this.commands.get(id)!.run(this.capture(), argument)
    return result === false ? { enabled: false, reason: '操作未完成，请检查当前文档状态。' } : status
  }
}

/** Validate the entire transaction before CodeMirror sees any part of it. */
export function validateCommandEdit(text: string, result: EditCommandResult, expected: CommandContext, current: CommandContext): boolean {
  if (!sameCommandTarget(expected, current) || result.baseTextRevision !== current.textRevision || !current.active || current.reading || current.composing || current.lockReason) throw new Error('正文或选区已变化，或文档暂不可编辑。')
  const patches = [...result.patches].sort((a, b) => a.from - b.from || a.to - b.to)
  if (patches.some((patch, index) => typeof patch.insert !== 'string' || (index > 0 && patches[index - 1].from === patch.from))) throw new RangeError('Patch ranges are ambiguous')
  const next = applyPatches(text, patches)
  if (result.selection && [result.selection.anchor, result.selection.head].some(value => !Number.isInteger(value) || value < 0 || value > next.length)) throw new RangeError('Selection is outside the resulting document')
  return next !== text
}
