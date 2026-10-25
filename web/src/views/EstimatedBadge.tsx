/**
 * Scenes rebuilt from an ordinary video (tools/video2capture) are estimates: depth, scale and
 * the camera path are guessed by a model, not measured by LiDAR. Say so wherever one is shown,
 * so it never passes as a measured scan.
 */
export function isEstimated(m: { source?: string; depth?: { estimated?: boolean } } | null | undefined): boolean {
  return Boolean(m && (m.source === 'video' || m.depth?.estimated))
}

export function EstimatedBadge({ manifest }: { manifest: { source?: string; depth?: { estimated?: boolean } } | null | undefined }) {
  if (!isEstimated(manifest)) return null
  return (
    <span className="estimated-badge" title="Rebuilt from an ordinary video by a depth model. Depth, scale and the camera path are estimated, not measured.">
      Estimated from a video, not measured
    </span>
  )
}
