import { applyCommand, DAW_LIMITS, generateId } from './project.js'
import { SOURCE_TIME_ROUNDOFF_SECONDS } from './sample-bounds.js'
import { intersectTrackRange } from './track-range.js'

/** Manual ranges use the DAW timeline, without any implied lyric/source clock. */
export function planTimelineGainRegion(project, trackId, startSeconds, endSeconds) {
  const track = project.tracks.find(track => track.id === trackId)
  if (!track) throw new Error('請先指定獨立人聲軌')
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds || endSeconds > DAW_LIMITS.maxDurationSeconds) throw new Error('請填入有效的時間軸起點與終點，終點須晚於起點')
  const geometry = intersectTrackRange(track, startSeconds, endSeconds)
  if (!geometry.intersections.length) throw new Error('這段時間沒有與指定人聲軌的片段交集')
  return { projectId: project.id, projectRevision: project.revision, trackId, timelineRange: { startSeconds, endSeconds }, ...geometry }
}

/** Commands remain local until Accept. New ranges are one atomic timeline
 * envelope; only the core derives internal crop shapes at clip boundaries. */
export function stageGainRegionDraft(project, plan, settings, { clipId, regionId } = {}) {
  if (plan.projectId !== project.id || plan.projectRevision !== project.revision) throw new Error('專案已修改，請重新準備區間')
  const { label, gain, fadeInSeconds, fadeOutSeconds } = settings
  if (!Number.isFinite(gain) || gain < 0 || gain > 1 || !Number.isFinite(fadeInSeconds) || fadeInSeconds < 0 || !Number.isFinite(fadeOutSeconds) || fadeOutSeconds < 0) throw new Error('保留音量須在 0–100%，邊緣平滑須為 0 毫秒以上')
  const track = project.tracks.find(track => track.id === plan.trackId)
  if (!track) throw new Error('請先指定獨立人聲軌')
  const length = plan.timelineRange.endSeconds - plan.timelineRange.startSeconds
  const fadeScale = fadeInSeconds + fadeOutSeconds > length ? length / (fadeInSeconds + fadeOutSeconds) : 1
  const strength = { label: label || '', gain, fadeInSeconds: fadeInSeconds * fadeScale, fadeOutSeconds: fadeOutSeconds * fadeScale }
  if (!regionId) return applyCommand(project, { type: 'track.gainRegion.add', trackId: track.id,
    region: { id: generateId('region'), ...plan.timelineRange, ...strength } })

  const clip = track.clips.find(clip => clip.id === clipId), old = clip?.gainRegions?.find(region => region.id === regionId)
  if (!old) throw new Error('此區間已不存在，請重新選取')
  if (plan.timelineRange.startSeconds < clip.atSeconds || plan.timelineRange.endSeconds > clip.atSeconds + clip.durationSeconds) throw new Error('編輯既有區間時，起點與終點須留在此片段內；跨片段請新增區間')
  const range = plan.intersections.find(item => item.clipId === clipId)
  if (!range) throw new Error('區間須位於目前片段內')
  const patch = { ...strength, startSeconds: range.startSeconds, endSeconds: range.endSeconds }
  for (const key of ['startSeconds', 'endSeconds', 'fadeInSeconds', 'fadeOutSeconds']) {
    if (Math.abs(patch[key] - old[key]) <= SOURCE_TIME_ROUNDOFF_SECONDS) delete patch[key]
  }
  return applyCommand(project, { type: 'clip.gainRegion.update', trackId: track.id, clipId, regionId, patch })
}
