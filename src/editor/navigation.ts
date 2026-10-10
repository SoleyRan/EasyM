import type { KeyboardEvent } from 'react'

export function navigateButtons(event: KeyboardEvent<HTMLElement>, selector: string, tree = false) {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(selector)
  if (!button || button.disabled) return
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(selector)).filter(item => !item.disabled)
  const index = buttons.indexOf(button)
  let target: HTMLButtonElement | undefined
  if (event.key === 'ArrowDown') target = buttons[Math.min(index + 1, buttons.length - 1)]
  else if (event.key === 'ArrowUp') target = buttons[Math.max(index - 1, 0)]
  else if (event.key === 'Home') target = buttons[0]
  else if (event.key === 'End') target = buttons.at(-1)
  else if (tree && event.key === 'ArrowRight') {
    if (button.getAttribute('aria-expanded') === 'false') button.click()
    else if (button.getAttribute('aria-expanded') === 'true') target = button.closest('li')?.querySelector<HTMLButtonElement>(':scope > ul button') ?? undefined
  } else if (tree && event.key === 'ArrowLeft') {
    if (button.getAttribute('aria-expanded') === 'true') button.click()
    else target = button.closest('li')?.parentElement?.closest('li')?.querySelector<HTMLButtonElement>(':scope > button') ?? undefined
  } else return
  event.preventDefault()
  target?.focus()
  target?.scrollIntoView?.({ block: 'nearest' })
}
