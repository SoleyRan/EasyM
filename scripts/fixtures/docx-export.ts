import { preflightDocx, renderDocx, saveDocx } from '../../src/platform/docx'
// Standalone acceptance entry uses the actual platform API and inline Worker.
Object.assign(window, { docxAcceptance: { preflightDocx, renderDocx, saveDocx } })
