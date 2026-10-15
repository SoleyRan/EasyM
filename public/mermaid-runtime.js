let used = false
window.addEventListener('message', async event => {
  if (event.source !== window.parent || used || !event.data || event.data.type !== 'easym-mermaid') return
  used = true
  const { token, source, theme } = event.data
  if (typeof token !== 'string' || typeof source !== 'string' || source.length > 8000) return
  try {
    await new Promise((resolve, reject) => {
      const url = new URL(event.data.engine, location.href)
      if (url.origin !== location.origin || !url.pathname.endsWith('.js')) throw new Error('engine')
      const script = document.createElement('script'); script.src = url.href; script.onload = () => resolve(); script.onerror = () => reject(new Error('load')); document.head.append(script)
    })
    const colors = { light: ['#e9f1fe', '#273852', '#235bca'], dark: ['#202c3e', '#dce6f5', '#91b8ff'], paper: ['#f1e8d8', '#4e4234', '#8b5224'], forest: ['#dfebdb', '#2f4935', '#2d6b46'] }
    const [fill, text, line] = colors[theme] ?? colors.light
    window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, maxTextSize: 8000, maxEdges: 120, theme: 'base', htmlLabels: false,
      flowchart: { htmlLabels: false, useMaxWidth: false }, sequence: { useMaxWidth: false },
      themeVariables: { primaryColor: fill, primaryTextColor: text, primaryBorderColor: line, lineColor: line, textColor: text, actorTextColor: text, actorBkg: fill, actorBorder: line, signalColor: line, signalTextColor: text, noteBkgColor: fill, noteTextColor: text, labelTextColor: text, fontFamily: 'Arial, sans-serif' } })
    const result = await window.mermaid.render('easymDiagram', source)
    parent.postMessage({ type: 'easym-mermaid-result', token, svg: result.svg }, '*')
  } catch { parent.postMessage({ type: 'easym-mermaid-result', token, error: '语法错误或渲染失败' }, '*') }
})
parent.postMessage({ type: 'easym-mermaid-ready' }, '*')
