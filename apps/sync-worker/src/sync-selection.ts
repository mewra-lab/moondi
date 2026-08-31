export const mergeTradeAssets = (...groups: string[][]): string[] => [
  ...new Set(groups.flat().map((asset) => asset.toUpperCase()).filter((asset) => asset !== 'THB')),
].sort()
