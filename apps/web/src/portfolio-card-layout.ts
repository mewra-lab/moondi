export const fitCanvasText = (value: string, measure: (value: string) => number, maxWidth: number): string => {
  if (measure(value) <= maxWidth) return value

  const ellipsis = '…'
  let low = 0
  let high = Array.from(value).length
  const characters = Array.from(value)

  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (measure(`${characters.slice(0, middle).join('')}${ellipsis}`) <= maxWidth) low = middle
    else high = middle - 1
  }

  return `${characters.slice(0, low).join('')}${ellipsis}`
}
