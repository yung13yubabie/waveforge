import { DAW_LIMITS, validateProject } from './project.js'
import { intersectTrackRange } from './track-range.js'

const fail = message => { throw new Error(`歌詞區間：${message}`) }
const validRange = (start, end, duration) => Number.isFinite(start) && Number.isFinite(end) &&
  start >= 0 && end > start && end <= duration

/** Pure sentence-to-clip mapping. The caller must explicitly choose a vocal
 * track and establish timeline = lyric source time + timelineOffsetSeconds.
 * Independent files need not share a hash, name, duration, or clock. Nothing in
 * this planner infers that relationship, changes PCM, or estimates word times.
 *
 * startSeconds/endSeconds are optional manual refinements in the lyric source
 * clock. Subtitle display offsets and the tempo/grid never enter this mapping.
 * Gaps describe uncovered timeline spans; overlapping clips count once toward
 * coverage but each receives its own clip-local intersection.
 *
 * A caller applying intersections must recheck selectionToken, project ID and
 * revision, stage every clip command, and only commit the complete result once.
 */
export function planLyricRegion(project, selection, options = {}) {
  validateProject(project)
  if (selection?.version !== 1 || selection.ready !== true || selection.precision !== 'sentence' ||
      typeof selection.token !== 'string' || !selection.token || selection.token.length > 256 ||
      !Number.isSafeInteger(selection.sessionRevision) || selection.sessionRevision < 0) {
    fail(selection?.blocker || '請重新選取已連結來源且有完整時間的歌詞句子')
  }
  const { source, line } = selection
  if (!source || !/^[a-f0-9]{64}$/.test(source.hash) || !Number.isFinite(source.duration) || source.duration <= 0 ||
      !line || typeof line.id !== 'string' || !/^line-[1-9]\d*$/.test(line.id) || line.sung !== true ||
      !validRange(line.start, line.end, source.duration)) fail('選取的歌詞來源或句子時間無效')
  const { trackId, timelineOffsetSeconds, startSeconds = line.start, endSeconds = line.end } = options
  const track = project.tracks.find(item => item.id === trackId)
  if (!track) fail('請指定已匯入的獨立人聲軌')
  // Even zero must be supplied explicitly, after the user checks the two clocks.
  if (!Number.isFinite(timelineOffsetSeconds)) fail('請明確設定歌詞時間到多軌時間軸的偏移秒數')
  if (!validRange(startSeconds, endSeconds, source.duration)) fail('手動句首與句尾須在歌詞原音檔範圍內')
  const timelineStart = startSeconds + timelineOffsetSeconds, timelineEnd = endSeconds + timelineOffsetSeconds
  if (!validRange(timelineStart, timelineEnd, DAW_LIMITS.maxDurationSeconds)) fail('套用區間超出多軌時間軸範圍')
  const geometry = intersectTrackRange(track, timelineStart, timelineEnd)
  if (!geometry.intersections.length) fail('這段時間沒有與指定人聲軌的片段交集')
  return {
    version: 1, projectId: project.id, projectRevision: project.revision, selectionToken: selection.token,
    trackId: track.id, lineId: line.id, sourceHash: source.hash,
    sourceRange: { startSeconds, endSeconds }, timelineOffsetSeconds,
    timelineRange: { startSeconds: timelineStart, endSeconds: timelineEnd },
    ...geometry,
  }
}
