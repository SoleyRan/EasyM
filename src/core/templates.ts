export interface NewDocument { name: string; text: string }
export type TemplateId = 'blank' | 'meeting' | 'project'

export const templates = [
  { id: 'blank', label: '空白文档', description: '从空白开始写作。', title: '', body: '' },
  { id: 'meeting', label: '会议纪要', description: '议题、讨论记录、决议与待办。', title: '会议纪要', body: '# {{title}}\n\n日期：{{date}}\n参会人员：\n\n## 会议议题\n\n- \n\n## 讨论记录\n\n\n## 会议决议\n\n- \n\n## 待办事项\n\n| 事项 | 负责人 | 截止日期 |\n| --- | --- | --- |\n|  |  |  |\n' },
  { id: 'project', label: '项目说明', description: '项目简介、使用方法与开发计划。', title: '项目说明', body: '# {{title}}\n\n更新日期：{{date}}\n\n## 项目简介\n\n描述项目目标和适用场景。\n\n## 主要功能\n\n- \n\n## 快速开始\n\n1. 安装与准备\n2. 配置\n3. 使用\n\n## 开发计划\n\n- [ ] 首个里程碑\n\n## 贡献说明\n\n\n## 许可证\n\n' },
] as const

export function localDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function documentName(title: string): string {
  let base = Array.from(title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()).slice(0, 80).join('').replace(/[. ]+$/, '')
  if (!base) base = '未命名'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = `_${base}`
  return base.toLowerCase().endsWith('.md') ? base : `${base}.md`
}

export function createFromTemplate(id: TemplateId, values: { title: string; date: string }): NewDocument {
  const template = templates.find(item => item.id === id)
  if (!template) throw new Error('未知模板')
  const title = values.title.trim() || template.title
  // One pass and a callback preserve dollar signs, backslashes and nested placeholders literally.
  const text = template.body.replace(/\{\{(title|date)\}\}/g, (_match, key: 'title' | 'date') => key === 'title' ? title : values.date)
  return { name: documentName(title), text }
}
