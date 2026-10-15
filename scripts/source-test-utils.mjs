export async function fillSource(page, text) {
  // Draft loading temporarily makes the content grid inert, including new tabs.
  // Resolve only the active, ready editor before writing the fixture so input
  // cannot be lost while a draft is loading or a task holds the editor lock.
  const editor = page.locator('.document-panel:not([hidden]):not([inert]) .app-shell:not([inert]) .content-grid:not([inert]) [aria-label="Markdown 源码编辑器"][aria-readonly="false"]')
  // Select through CodeMirror's keymap, rather than a DOM Range: after undo /
  // redo the contenteditable DOM selection can lag the editor state, causing
  // fill() to insert a fixture beside the old text instead of replacing it.
  await editor.press('ControlOrMeta+a')
  await page.keyboard.insertText(text)
}
