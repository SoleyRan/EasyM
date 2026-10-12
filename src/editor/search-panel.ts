import { EditorView, type Panel, type ViewUpdate } from '@codemirror/view'
import { closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, SearchQuery, setSearchQuery } from '@codemirror/search'
import { isolateHistory } from '@codemirror/commands'
import { currentSearchMatch, MAX_SEARCH_MATCHES, type SearchResults } from '../core/search'
import SearchWorker from '../platform/search-worker?worker&inline'

export function createSearchPanel(view: EditorView): Panel {
  const dom = document.createElement('div')
  dom.className = 'easym-search'
  dom.setAttribute('role', 'search')
  dom.setAttribute('aria-label', '文档内查找与替换')
  let query = getSearchQuery(view.state)
  let revision = 0, timer: number | undefined, worker: Worker | null = null
  let results: SearchResults | null = null, destroyed = false, composing = false
  const searchInput = input('查找文本', query.search)
  searchInput.setAttribute('main-field', 'true')
  const replaceInput = input('替换为', query.replace)
  const count = document.createElement('span')
  count.className = 'search-count'
  count.setAttribute('role', 'status')
  count.setAttribute('aria-live', 'polite')
  const caseInput = checkbox('区分大小写', query.caseSensitive)
  const wordInput = checkbox('整词匹配', query.wholeWord)
  const first = row(), second = row()
  first.append(searchInput, button('上一项', () => navigate(true)), button('下一项', () => navigate(false)), count)
  first.append(caseInput.label, wordInput.label, button('关闭查找', () => { closeSearchPanel(view); view.focus() }, '×'))
  const replaceButton = button('替换当前项', () => runReplace(false))
  const replaceAllButton = button('全部替换', () => runReplace(true))
  second.append(replaceInput, replaceButton, replaceAllButton)
  dom.append(first, second)

  function input(label: string, value: string) {
    const node = document.createElement('input')
    node.type = 'text'; node.value = value; node.placeholder = label
    node.setAttribute('aria-label', label)
    node.autocomplete = 'off'; node.spellcheck = false
    node.addEventListener('input', commit)
    return node
  }
  function checkbox(labelText: string, checked: boolean) {
    const label = document.createElement('label'), node = document.createElement('input')
    node.type = 'checkbox'; node.checked = checked
    node.addEventListener('change', commit)
    label.append(node, labelText)
    return { label, node }
  }
  function row() { const node = document.createElement('div'); node.className = 'search-row'; return node }
  function button(label: string, action: () => void, text = label) {
    const node = document.createElement('button')
    node.type = 'button'; node.textContent = text; node.setAttribute('aria-label', label)
    node.addEventListener('click', action)
    return node
  }
  function commit() {
    if (composing) return
    const next = new SearchQuery({ search: searchInput.value, replace: replaceInput.value, caseSensitive: caseInput.node.checked, wholeWord: wordInput.node.checked, literal: true })
    if (!next.eq(query)) view.dispatch({ effects: setSearchQuery.of(next) })
  }
  function navigate(previous: boolean) {
    if (!query.valid || composing || view.composing) return
    ;(previous ? findPrevious : findNext)(view)
  }
  function runReplace(all: boolean) {
    if (!query.valid || composing || view.composing || view.state.readOnly || (all && (!results || results.limited))) return
    // Replacements participate in the same undo stack, as separate actions.
    view.dispatch({ annotations: isolateHistory.of('full') })
    ;(all ? replaceAll : replaceNext)(view)
    view.dispatch({ annotations: isolateHistory.of('full') })
  }
  function showResults() {
    if (!results) return
    const { from, to } = view.state.selection.main
    const current = currentSearchMatch(results.matches, from, to)
    count.textContent = results.limited ? `超过 ${MAX_SEARCH_MATCHES.toLocaleString('en-US')} 项` : `${current} / ${results.matches.length} 项`
    replaceButton.disabled = !query.valid || results.matches.length === 0 || view.state.readOnly
    replaceAllButton.disabled = replaceButton.disabled || results.limited
    replaceAllButton.title = results.limited ? '匹配过多，请缩小查询范围或逐项替换' : '全部替换可一次撤销'
  }
  function recount() {
    window.clearTimeout(timer)
    results = null; revision++
    replaceButton.disabled = !query.valid || view.state.readOnly
    replaceAllButton.disabled = true
    if (!query.valid) { count.textContent = '0 / 0 项'; return }
    count.textContent = worker ? '正在查找…' : '计数不可用'
    if (!worker) return
    timer = window.setTimeout(() => {
      worker?.postMessage({ text: view.state.doc.toString(), options: { search: query.search, caseSensitive: query.caseSensitive, wholeWord: query.wholeWord }, revision })
    }, 120)
  }
  dom.addEventListener('keydown', event => {
    if (event.isComposing || view.composing || event.keyCode === 229) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSearchPanel(view); view.focus() }
    else if (event.key === 'Enter' && event.target === searchInput) { event.preventDefault(); navigate(event.shiftKey) }
    else if (event.key === 'Enter' && event.target === replaceInput) { event.preventDefault(); runReplace(false) }
    else if (event.key === 'F3' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'g')) { event.preventDefault(); navigate(event.shiftKey) }
  })
  dom.addEventListener('compositionstart', () => { composing = true })
  dom.addEventListener('compositionend', () => { composing = false; commit() })
  try {
    worker = new SearchWorker()
    worker.onmessage = (event: MessageEvent<{ revision: number; results?: SearchResults; error?: string }>) => {
      if (destroyed || event.data.revision !== revision) return
      if (event.data.results) { results = event.data.results; showResults() }
      else { count.textContent = '计数不可用'; replaceAllButton.disabled = true }
    }
    worker.onerror = () => { if (!destroyed) { count.textContent = '计数不可用'; results = null; replaceAllButton.disabled = true } }
  } catch { worker = null }
  recount()
  return {
    dom, top: true,
    mount: () => searchInput.select(),
    update: (update: ViewUpdate) => {
      const next = getSearchQuery(update.state)
      const changed = !next.eq(query)
      const matchingChanged = next.search !== query.search || next.caseSensitive !== query.caseSensitive || next.wholeWord !== query.wholeWord
      query = next
      if (changed) {
        // Avoid moving the search input's IME caret on ordinary input events.
        if (searchInput.value !== query.search) searchInput.value = query.search
        if (replaceInput.value !== query.replace) replaceInput.value = query.replace
        caseInput.node.checked = query.caseSensitive; wordInput.node.checked = query.wholeWord
      }
      if (update.docChanged || matchingChanged) recount()
      else if (update.selectionSet) showResults()
    },
    destroy: () => { destroyed = true; window.clearTimeout(timer); worker?.terminate() },
  }
}
