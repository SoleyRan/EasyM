import { useState } from 'react'
import { listWorkspace, WORKSPACE_IMAGE_TYPE, type Workspace, type WorkspaceEntry, type WorkspaceImage } from '../platform/workspace'
import { navigateButtons } from './navigation'

interface Props {
  workspace: Workspace; disabled: boolean; selected: string | null
  onOpen(path: string): void; onImage(image: WorkspaceImage): void; onError(message: string): void
}

function Entry({ entry, depth, ...props }: Props & { entry: WorkspaceEntry; depth: number }) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<WorkspaceEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const image = { id: props.workspace.id, path: entry.path }
  async function toggle() {
    if (loading) return
    if (expanded) { setExpanded(false); return }
    if (!children) {
      setLoading(true)
      try { setChildren(await listWorkspace(props.workspace.id, entry.path)) }
      catch (error) { props.onError(String(error)); return }
      finally { setLoading(false) }
    }
    setExpanded(true)
  }
  return <li>
    <button className={`file-row ${props.selected === entry.path ? 'active' : ''}`} style={{ paddingLeft: 12 + depth * 14 }}
      disabled={props.disabled} aria-busy={loading || undefined} title={entry.kind === 'image' ? `插入图片：${entry.path}` : entry.path}
      aria-expanded={entry.kind === 'directory' ? expanded : undefined}
      draggable={entry.kind === 'image' && !props.disabled} onDragStart={(event) => { event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData(WORKSPACE_IMAGE_TYPE, JSON.stringify(image)) }}
      onClick={() => entry.kind === 'directory' ? void toggle() : entry.kind === 'document' ? props.onOpen(entry.path) : props.onImage(image)}>
      <span aria-hidden>{entry.kind === 'directory' ? expanded ? '▾' : '▸' : entry.kind === 'image' ? '▣' : '□'}</span>
      <span className="tree-name">{entry.name}</span>{loading && <span>…</span>}
    </button>
    {expanded && <ul>{children?.length ? children.map((child) => <Entry key={child.path} {...props} entry={child} depth={depth + 1} />) : <li className="tree-empty">没有 Markdown 或图片</li>}</ul>}
  </li>
}

export function WorkspaceTree(props: Props) {
  return <nav className="workspace-tree" aria-label="工作区文件" onKeyDown={event => navigateButtons(event, '.file-row', true)}><div className="sidebar-label" title={props.workspace.name}>{props.workspace.name}</div>
    <ul>{props.workspace.entries.length ? props.workspace.entries.map((entry) => <Entry key={entry.path} {...props} entry={entry} depth={0} />) : <li className="tree-empty">没有 Markdown 或图片</li>}</ul>
  </nav>
}
