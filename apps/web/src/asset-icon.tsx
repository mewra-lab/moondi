import { useState } from 'react'

export function AssetIcon({ asset }: { asset: string }) {
  const [failedAsset, setFailedAsset] = useState<string>()
  const symbol = asset.toUpperCase()
  const canLoad = /^[A-Z0-9]{1,16}$/.test(symbol) && symbol !== 'OTHER' && failedAsset !== symbol

  return (
    <span aria-hidden="true" className="asset-monogram">
      {canLoad ? (
        <img alt="" crossOrigin="anonymous" decoding="async" height={32} loading="lazy"
          onError={() => setFailedAsset(symbol)} referrerPolicy="no-referrer"
          src={`https://cdn.bitkubnow.com/coins/icon/32/${symbol}.png`} width={32} />
      ) : asset.slice(0, 3)}
    </span>
  )
}
