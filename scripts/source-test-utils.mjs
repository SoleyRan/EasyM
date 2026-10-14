export async function fillSource(page, text) {
  // Draft loading temporarily makes the content grid inert, including new tabs.
  // Playwright fill() does not wait for an inert ancestor and can silently lose
  // the input. Resolve only the active, ready editor before writing the fixture.
  const editor = page.locator('.document-panel:not([hidden]):not([inert]) .app-shell:not([inert]) .content-grid:not([inert]) [aria-label="Markdown 源码编辑器"][aria-readonly="false"]')
  await editor.fill(text)
}
