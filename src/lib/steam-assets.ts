// Build Steam store-asset URLs from data persisted in `steam_apps` /
// `steam_subs`.
//
// `assetUrlFormat` is the value of `assets.asset_url_format` from the
// IStoreBrowseService/GetItems response — e.g.
//   "steam/apps/2997230/${FILENAME}?t=1776154869"
// The literal token "${FILENAME}" gets substituted with the asset's path
// (e.g. "5980b81c.../capsule_231x87.jpg" or just "capsule_231x87.jpg" for
// legacy hashless apps).
//
// `fallback` is a last-ditch hashless URL used when the persisted format /
// path are missing — e.g. a sub Steam refused to give us metadata for due
// to region restrictions. The hashless path doesn't exist for every SKU
// (newer modern apps only have hashed assets), but when it does it's free,
// so callers should pass one whenever they have an id+filename. Failed
// loads collapse via the consumer's `onError` handler.
const ASSET_BASE = 'https://shared.akamai.steamstatic.com/store_item_assets/'
const FILENAME_TOKEN = '${FILENAME}'

export type SteamAssetFallback = {
  readonly kind: 'app' | 'sub'
  readonly id: number
  readonly filename: string
}

export const steamAssetUrl = (
  assetUrlFormat: string | null,
  assetPath: string | null,
  fallback?: SteamAssetFallback,
): string | null => {
  if (assetUrlFormat !== null && assetPath !== null) {
    return ASSET_BASE + assetUrlFormat.replace(FILENAME_TOKEN, assetPath)
  }
  if (fallback !== undefined) {
    const stem = fallback.kind === 'app' ? 'apps' : 'subs'
    return `${ASSET_BASE}steam/${stem}/${String(fallback.id)}/${fallback.filename}`
  }
  return null
}

// The small_capsule path Steam returns is the 231x87 variant. Swap the
// filename to render the smaller 184x69 version (same hash). Steam's filename
// convention is stable so this string-swap is safe.
export const smallCapsuleSmallSize = (assetPath: string | null): string | null =>
  assetPath === null ? null : assetPath.replace('capsule_231x87.jpg', 'capsule_184x69.jpg')
