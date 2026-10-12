export const MAX_DOCX_BYTES = 192 * 1024 * 1024
export interface DocxOptions { page: 'a4' | 'letter'; style: 'default' | 'compact'; allowImagePlaceholders?: boolean }
export const defaultDocxOptions: DocxOptions = { page: 'a4', style: 'default' }
