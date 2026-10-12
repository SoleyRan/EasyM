export async function fillSource(page, text) {
  // Draft loading temporarily makes the content grid inert, including new tabs.
  // Playwright fill() does not wait for an inert ancestor and can silently lose
  // the input. Resolve only the active, ready editor before writing the fixture.
  const editor = page.locator('.document-panel:not([hidden]) .content-grid:not([inert])').getByRole('textbox', { name: 'Markdown 源码编辑器' })
  await editor.fill(text)
}
