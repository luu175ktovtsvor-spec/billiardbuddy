import { extname } from 'node:path'

/** Return the browser-facing media type for a supported video container. */
export function videoMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.mov': return 'video/quicktime'
    case '.webm': return 'video/webm'
    case '.mkv': return 'video/x-matroska'
    case '.avi': return 'video/x-msvideo'
    case '.m4v': return 'video/x-m4v'
    case '.mpeg':
    case '.mpg': return 'video/mpeg'
    case '.ts': return 'video/mp2t'
    case '.3gp': return 'video/3gpp'
    case '.ogv': return 'video/ogg'
    case '.flv': return 'video/x-flv'
    case '.mxf': return 'application/mxf'
    default: return 'video/mp4'
  }
}

/** Browser-facing MIME for a managed secondary media input.  The stream probe
 * remains authoritative for whether the bytes really contain the requested
 * kind; this helper only chooses the stable response/container type. */
export function projectAssetMimeType(path: string, assetKind: 'music' | 'voice_over' | 'b_roll' | 'overlay'): string {
  const extension = extname(path).toLowerCase()
  if (assetKind === 'music' || assetKind === 'voice_over') {
    switch (extension) {
      case '.wav': return 'audio/wav'
      case '.flac': return 'audio/flac'
      case '.aac': return 'audio/aac'
      case '.m4a': return 'audio/mp4'
      case '.ogg':
      case '.opus': return 'audio/ogg'
      case '.webm': return 'audio/webm'
      default: return 'audio/mpeg'
    }
  }
  if (assetKind === 'overlay') {
    if (extension === '.png') return 'image/png'
    if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
    if (extension === '.webp') return 'image/webp'
  }
  return videoMimeType(path)
}
