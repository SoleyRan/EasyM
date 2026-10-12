import { describe, expect, it } from 'vitest'
import { createFromTemplate, localDate } from './templates'

describe('document templates', () => {
  it('replaces only supported variables as literal text', () => {
    const result = createFromTemplate('meeting', { title: '$1\\draft {{date}}', date: '2026/10/10' })
    expect(result.name).toBe('$1_draft {{date}}.md')
    expect(result.text).toContain('# $1\\draft {{date}}')
    expect(result.text).toContain('日期：2026/10/10')
    expect(result.text).not.toContain('{{title}}')
  })

  it('creates safe names and deterministic local dates', () => {
    expect(createFromTemplate('project', { title: 'CON', date: localDate(new Date(2026, 0, 2)) }).name).toBe('_CON.md')
    expect(localDate(new Date(2026, 0, 2))).toBe('2026-01-02')
    expect(createFromTemplate('blank', { title: '', date: '' })).toEqual({ name: '未命名.md', text: '' })
  })
})
