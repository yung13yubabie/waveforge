import { sourceFrameBounds, SOURCE_TIME_ROUNDOFF_SECONDS } from './sample-bounds.js'
import { sliceGainRegions } from './gain-regions.js'
import { intersectTrackRange } from './track-range.js'

/** Bounded, non-destructive audio editing. Times are seconds; tempo is grid-only. */
export const PROJECT_SCHEMA = 'waveforge.project.v1'
export const CLIP_TRANSPOSE_ENGINE = 'signalsmith-stretch-1.3.2'
export const DAW_LIMITS = Object.freeze({
  maxDurationSeconds: 600, maxTracks: 16, maxClips: 256, maxAssets: 64,
  maxDecodedBytes: 256 * 1024 * 1024, maxRenderBytes: 256 * 1024 * 1024,
  maxCombinedBytes: 512 * 1024 * 1024, maxEnvelopePoints: 8,
  maxAutomationPoints: 32, maxAutomationGain: 2,
  maxGainRegionsPerClip: 64, maxGainRegions: 1024, maxGainRegionEnvelopePoints: 4, maxGainRegionLabel: 120,
})
const OUTPUT_RATES = [44100, 48000, 96000]
const EPSILON = 1e-9
const clone = value => JSON.parse(JSON.stringify(value))
const fail = message => { throw new Error(`DAW: ${message}`) }
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
function number(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${label} must be ${min}–${max}`)
}
function integer(value, label, min, max) {
  number(value, label, min, max)
  if (!Number.isSafeInteger(value)) fail(`${label} must be an integer`)
}
function text(value, label, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${label} must be 1–${max} characters`)
}
function id(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) fail(`${label} is invalid`)
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be plain metadata`)
}
function onlyKeys(value, allowed, label) {
  object(value, label)
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label}: unsupported field ${key}`)
}
function array(value, label, max) {
  if (!Array.isArray(value) || value.length > max) fail(`${label} exceeds the ${max} item limit`)
}
function unique(value, seen, label) {
  id(value, label)
  if (seen.has(value)) fail(`duplicate ${label}: ${value}`)
  seen.add(value)
}
export function generateId(prefix = 'id') {
  const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${suffix}`
}
export function createProject(options = {}) {
  const project = { schema: PROJECT_SCHEMA, id: generateId('project'), revision: 0,
    name: 'Untitled project', masterGainDb: 0, sampleRate: 48000, tempo: 120, timeSignature: [4, 4], assets: [], tracks: [], ...options }
  validateProject(project)
  return clone(project)
}
export function getProjectDuration(project) {
  return Math.max(0, ...project.tracks.flatMap(track => track.clips.map(clip => clip.atSeconds + clip.durationSeconds)))
}
export function getDecodedBytes(project) {
  return project.assets.reduce((total, asset) => total + (asset.length ?? Math.ceil(asset.duration * asset.sampleRate)) * asset.channels * 4, 0)
}
/** Optional saved timeline range, independent of selected clips. Frame bounds
 * cover the half-open range using the output rate, never a source asset rate. */
export function validateTimelineSelection(selection, durationSeconds, sampleRate) {
  onlyKeys(selection, ['startSeconds', 'endSeconds'], 'timeline selection')
  number(selection.startSeconds, 'timeline selection start', 0, Math.min(durationSeconds, DAW_LIMITS.maxDurationSeconds))
  number(selection.endSeconds, 'timeline selection end', selection.startSeconds, Math.min(durationSeconds, DAW_LIMITS.maxDurationSeconds))
  if (!(selection.endSeconds > selection.startSeconds)) fail('timeline selection must have positive duration')
  const bounds = sourceFrameBounds(selection.startSeconds, selection.endSeconds - selection.startSeconds, sampleRate)
  if (bounds.last <= bounds.first) fail('timeline selection must contain at least one output frame')
  return selection
}
export function validateProject(project) {
  onlyKeys(project, ['schema', 'id', 'revision', 'name', 'masterGainDb', 'sampleRate', 'tempo', 'timeSignature', 'gridOriginSeconds', 'assets', 'tracks', 'timelineSelection'], 'project')
  if (project.schema !== PROJECT_SCHEMA) fail('unsupported project schema')
  id(project.id, 'project ID'); text(project.name, 'project name')
  integer(project.revision, 'revision', 0, Number.MAX_SAFE_INTEGER - 1)
  if (!OUTPUT_RATES.includes(project.sampleRate)) fail('output sample rate must be 44100, 48000 or 96000 Hz')
  number(project.tempo, 'tempo', 20, 300)
  // Grid metadata never changes audio timing and must survive deleting clips.
  if (own(project, 'gridOriginSeconds')) number(project.gridOriginSeconds, 'grid origin seconds', 0, DAW_LIMITS.maxDurationSeconds)
  number(project.masterGainDb, 'master gain dB', -60, 12)
  if (!Array.isArray(project.timeSignature) || project.timeSignature.length !== 2) fail('invalid time signature')
  integer(project.timeSignature[0], 'time signature numerator', 1, 16)
  if (![1, 2, 4, 8, 16].includes(project.timeSignature[1])) fail('invalid time signature denominator')
  array(project.assets, 'assets', DAW_LIMITS.maxAssets)
  array(project.tracks, 'tracks', DAW_LIMITS.maxTracks)
  const assetIds = new Set(), trackIds = new Set(), clipIds = new Set()
  const assets = new Map()
  for (const asset of project.assets) {
    onlyKeys(asset, ['id', 'name', 'hash', 'duration', 'sampleRate', 'channels', 'length', 'sourceSampleRate', 'decodeBackend'], 'asset')
    unique(asset.id, assetIds, 'asset ID'); text(asset.name, 'asset name')
    if (asset.hash !== undefined && asset.hash !== '' && (typeof asset.hash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(asset.hash))) fail('asset hash must be SHA-256 hex')
    number(asset.duration, 'asset duration', Number.MIN_VALUE, DAW_LIMITS.maxDurationSeconds)
    integer(asset.sampleRate, 'asset sample rate', 8000, 192000)
    if (asset.duration < 1 / asset.sampleRate) fail('asset must contain at least one sample')
    integer(asset.channels, 'asset channels', 1, 2)
    if (asset.length !== undefined) {
      integer(asset.length, 'asset frame count', 1, DAW_LIMITS.maxDurationSeconds * asset.sampleRate)
      if (Math.abs(asset.length / asset.sampleRate - asset.duration) > 1 / asset.sampleRate + EPSILON) fail('asset frame count does not match duration')
    }
    if (asset.sourceSampleRate !== undefined && asset.sourceSampleRate !== null) integer(asset.sourceSampleRate, 'source sample rate', 8000, 192000)
    if (asset.decodeBackend !== undefined) text(asset.decodeBackend, 'decode backend', 80)
    assets.set(asset.id, asset)
  }
  if (getDecodedBytes(project) > DAW_LIMITS.maxDecodedBytes) fail('decoded assets exceed 256 MiB; use shorter source files')
  let clipCount = 0, gainRegionCount = 0
  for (const track of project.tracks) {
    onlyKeys(track, ['id', 'name', 'gainDb', 'pan', 'mute', 'solo', 'clips'], 'track')
    unique(track.id, trackIds, 'track ID'); text(track.name, 'track name')
    number(track.gainDb, 'track gain dB', -60, 12); number(track.pan, 'track pan', -1, 1)
    if (typeof track.mute !== 'boolean' || typeof track.solo !== 'boolean') fail('mute and solo must be booleans')
    array(track.clips, 'track clips', DAW_LIMITS.maxClips)
    clipCount += track.clips.length
    if (clipCount > DAW_LIMITS.maxClips) fail('project exceeds 256 clips')
    for (const clip of track.clips) {
      onlyKeys(clip, ['id', 'assetId', 'name', 'atSeconds', 'offsetSeconds', 'durationSeconds', 'gainDb', 'fadeInSeconds', 'fadeOutSeconds', 'gainEnvelope', 'volumeAutomation', 'gainRegions', 'transpose'], 'clip')
      unique(clip.id, clipIds, 'clip ID'); text(clip.name, 'clip name')
      const asset = assets.get(clip.assetId)
      if (!asset) fail(`clip ${clip.id} has missing asset ${clip.assetId}`)
      number(clip.atSeconds, 'clip position', 0, DAW_LIMITS.maxDurationSeconds)
      number(clip.offsetSeconds, 'source offset', 0, asset.duration)
      number(clip.durationSeconds, 'clip duration', 1 / asset.sampleRate, asset.duration + SOURCE_TIME_ROUNDOFF_SECONDS)
      if (clip.atSeconds + clip.durationSeconds > DAW_LIMITS.maxDurationSeconds + EPSILON) fail('timeline exceeds 600 seconds')
      if (clip.offsetSeconds + clip.durationSeconds > asset.duration + EPSILON) fail('clip extends beyond its source')
      if (clip.transpose !== undefined) validateClipTranspose(clip, asset, assets)
      number(clip.gainDb, 'clip gain dB', -60, 12)
      number(clip.fadeInSeconds, 'fade in', 0, clip.durationSeconds)
      number(clip.fadeOutSeconds, 'fade out', 0, clip.durationSeconds)
      if (clip.fadeInSeconds + clip.fadeOutSeconds > clip.durationSeconds + EPSILON) fail('clip fades overlap; shorten a fade')
      if (clip.gainRegions !== undefined) {
        array(clip.gainRegions, 'clip gain regions', DAW_LIMITS.maxGainRegionsPerClip)
        gainRegionCount += clip.gainRegions.length
        if (gainRegionCount > DAW_LIMITS.maxGainRegions) fail('project exceeds 1024 gain regions')
        const regionIds = new Set()
        for (const region of clip.gainRegions) {
          validateGainRegion(region, clip.durationSeconds)
          unique(region.id, regionIds, 'gain region ID')
        }
      }
      if (clip.volumeAutomation !== undefined) {
        array(clip.volumeAutomation, 'volume automation', DAW_LIMITS.maxAutomationPoints)
        if (clip.volumeAutomation.length < 2) fail('volume automation needs start and end points')
        let previous = -1
        for (const point of clip.volumeAutomation) {
          onlyKeys(point, ['timeSeconds', 'value'], 'volume automation point')
          number(point.timeSeconds, 'automation time', 0, clip.durationSeconds)
          number(point.value, 'automation gain', 0, DAW_LIMITS.maxAutomationGain)
          if (point.timeSeconds <= previous) fail('volume automation points must be strictly ordered')
          previous = point.timeSeconds
        }
        if (clip.volumeAutomation[0].timeSeconds !== 0 || previous !== clip.durationSeconds) fail('volume automation must span the clip exactly')
      }
      if (clip.gainEnvelope !== undefined) {
        array(clip.gainEnvelope, 'gain envelope', DAW_LIMITS.maxEnvelopePoints)
        if (clip.gainEnvelope.length < 2) fail('gain envelope needs start and end points')
        let previous = -1
        for (const point of clip.gainEnvelope) {
          onlyKeys(point, ['timeSeconds', 'value'], 'gain envelope point')
          number(point.timeSeconds, 'envelope time', 0, clip.durationSeconds)
          number(point.value, 'envelope gain', 0, 1)
          if (point.timeSeconds <= previous) fail('gain envelope points must be strictly ordered')
          previous = point.timeSeconds
        }
        if (clip.gainEnvelope[0].timeSeconds !== 0 || Math.abs(previous - clip.durationSeconds) > EPSILON) fail('gain envelope must span the clip')
      }
    }
  }
  if (own(project, 'timelineSelection')) validateTimelineSelection(project.timelineSelection, getProjectDuration(project), project.sampleRate)
  return project
}
function validateGainRegion(region, clipDuration) {
  onlyKeys(region, ['id', 'label', 'startSeconds', 'endSeconds', 'gain', 'fadeInSeconds', 'fadeOutSeconds', 'attenuationEnvelope'], 'gain region')
  id(region.id, 'gain region ID')
  if (region.label !== undefined && (typeof region.label !== 'string' || region.label.length > DAW_LIMITS.maxGainRegionLabel || /[\x00-\x1f\x7f]/.test(region.label))) fail('gain region label must be at most 120 characters without control characters')
  number(region.startSeconds, 'gain region start', 0, clipDuration)
  number(region.endSeconds, 'gain region end', region.startSeconds, clipDuration)
  const duration = region.endSeconds - region.startSeconds
  if (!(duration > 0)) fail('gain region must have positive duration')
  number(region.gain, 'gain region gain', 0, 1)
  number(region.fadeInSeconds, 'gain region fade in', 0, duration)
  number(region.fadeOutSeconds, 'gain region fade out', 0, duration)
  if (region.fadeInSeconds + region.fadeOutSeconds > duration + EPSILON) fail('gain region fades overlap; shorten a fade')
  if (region.attenuationEnvelope !== undefined) {
    array(region.attenuationEnvelope, 'gain region attenuation envelope', DAW_LIMITS.maxGainRegionEnvelopePoints)
    if (region.attenuationEnvelope.length < 2) fail('gain region attenuation envelope needs start and end points')
    let previous = -1
    for (const point of region.attenuationEnvelope) {
      onlyKeys(point, ['timeSeconds', 'value'], 'gain region attenuation point')
      number(point.timeSeconds, 'gain region attenuation time', 0, duration)
      number(point.value, 'gain region attenuation strength', 0, 1)
      if (point.timeSeconds <= previous) fail('gain region attenuation points must be strictly ordered')
      previous = point.timeSeconds
    }
    if (region.attenuationEnvelope[0].timeSeconds !== 0 || previous !== duration) fail('gain region attenuation envelope must span the region exactly')
  }
}
/** Bounded optional lineage, versioned separately so old projects still open.
 * The fixed recipe is descriptive metadata, never executable/plugin data. */
function validateClipTranspose(clip, generated, assets) {
  const t = clip.transpose
  onlyKeys(t, ['version', 'engine', 'sourceAssetId', 'sourceOffsetSeconds', 'sourceDurationSeconds', 'cropFirstFrame', 'cropLastFrame', 'semitones', 'cents', 'formantSemitones', 'formantCompensation'], 'clip transpose')
  if (t.version !== 1 || t.engine !== CLIP_TRANSPOSE_ENGINE) fail('unsupported clip transpose version or engine')
  id(t.sourceAssetId, 'transpose original asset ID')
  const source = assets.get(t.sourceAssetId)
  if (!source || source.id === generated.id || source.decodeBackend === 'generated-float32-wav') fail('transpose original must reference a retained, non-generated source asset')
  if (!OUTPUT_RATES.includes(source.sampleRate) || generated.sampleRate !== source.sampleRate || generated.channels !== source.channels || generated.decodeBackend !== 'generated-float32-wav') fail('transpose generated/source formats do not match')
  number(t.sourceOffsetSeconds, 'transpose original offset', 0, source.duration)
  number(t.sourceDurationSeconds, 'transpose original duration', 1 / source.sampleRate, 30 + SOURCE_TIME_ROUNDOFF_SECONDS)
  if (t.sourceOffsetSeconds + t.sourceDurationSeconds > source.duration + EPSILON) fail('transpose original interval exceeds source')
  const sourceFrames = source.length ?? sourceFrameBounds(0, source.duration, source.sampleRate).last
  integer(t.cropFirstFrame, 'transpose first frame', 0, sourceFrames)
  integer(t.cropLastFrame, 'transpose last frame', t.cropFirstFrame + 1, sourceFrames)
  const bounds = sourceFrameBounds(t.sourceOffsetSeconds, t.sourceDurationSeconds, source.sampleRate)
  const frames = t.cropLastFrame - t.cropFirstFrame
  if (t.cropFirstFrame !== bounds.first || t.cropLastFrame !== bounds.last || frames > 30 * source.sampleRate || generated.length !== frames) fail('transpose crop does not match the original interval and generated frames')
  number(t.semitones, 'transpose semitones', -2, 2); number(t.cents, 'transpose cents', -100, 100)
  number(t.semitones + t.cents / 100, 'transpose combined pitch', -2, 2)
  number(t.formantSemitones, 'transpose formants', -2, 2)
  if (typeof t.formantCompensation !== 'boolean') fail('transpose compensation must be boolean')
  if ((t.semitones + t.cents / 100 !== 0 || t.formantSemitones !== 0) && frames < Math.ceil(source.sampleRate * .12)) fail('transpose nonzero recipe needs at least 120 ms')
  const generatedOffset = bounds.offsetSeconds
  if (Math.abs(generated.duration - frames / source.sampleRate) > EPSILON || clip.offsetSeconds < generatedOffset - EPSILON || clip.offsetSeconds + clip.durationSeconds > generatedOffset + t.sourceDurationSeconds + EPSILON) fail('transpose clip extends beyond its captured original interval')
  const original = getClipOriginalSource(clip, source.sampleRate)
  if (original.offsetSeconds < 0 || original.offsetSeconds + clip.durationSeconds > source.duration + EPSILON) fail('transpose current clip exceeds retained original')
}
/** Map a trimmed/split generated clip back into its retained original. The
 * unchanged clip round-trips its exact captured offset rather than rounding. */
export function getClipOriginalSource(clip, sampleRate) {
  if (!clip.transpose) return { assetId: clip.assetId, offsetSeconds: clip.offsetSeconds }
  const t = clip.transpose, generatedOffset = sourceFrameBounds(t.sourceOffsetSeconds, t.sourceDurationSeconds, sampleRate).offsetSeconds
  return { assetId: t.sourceAssetId, offsetSeconds: t.sourceOffsetSeconds + (clip.offsetSeconds - generatedOffset) }
}
/** Envelope uses linear amplitude ramps, never dB interpolation. */
export function getClipEnvelope(clip) {
  if (clip.gainEnvelope) return clone(clip.gainEnvelope)
  const points = [{ timeSeconds: 0, value: clip.fadeInSeconds > 0 ? 0 : 1 }]
  if (clip.fadeInSeconds > 0) points.push({ timeSeconds: clip.fadeInSeconds, value: 1 })
  const fadeOutStart = clip.durationSeconds - clip.fadeOutSeconds
  if (fadeOutStart > points.at(-1).timeSeconds && clip.fadeOutSeconds > 0) points.push({ timeSeconds: fadeOutStart, value: 1 })
  if (clip.durationSeconds > points.at(-1).timeSeconds) points.push({ timeSeconds: clip.durationSeconds, value: clip.fadeOutSeconds > 0 ? 0 : 1 })
  return points
}
export function envelopeValueAt(points, seconds) {
  if (seconds <= points[0].timeSeconds) return points[0].value
  for (let index = 1; index < points.length; index++) {
    const left = points[index - 1], right = points[index]
    if (seconds <= right.timeSeconds) {
      const fraction = (seconds - left.timeSeconds) / (right.timeSeconds - left.timeSeconds)
      return left.value + (right.value - left.value) * fraction
    }
  }
  return points.at(-1).value
}
/** A separate linear-amplitude multiplier; absent automation is exactly unity. */
export function getClipVolumeAutomation(clip) {
  return clip.volumeAutomation ? clone(clip.volumeAutomation) : [{ timeSeconds: 0, value: 1 }, { timeSeconds: clip.durationSeconds, value: 1 }]
}
function sliceEnvelope(points, start, end) {
  return [{ timeSeconds: 0, value: envelopeValueAt(points, start) },
    ...points.filter(point => point.timeSeconds > start && point.timeSeconds < end).map(point => ({ ...point, timeSeconds: point.timeSeconds - start })),
    { timeSeconds: end - start, value: envelopeValueAt(points, end) }]
}
function sliceClip(clip, start, end) {
  const durationSeconds = end - start
  return { ...clip, atSeconds: clip.atSeconds + start, offsetSeconds: clip.offsetSeconds + start,
    durationSeconds, fadeInSeconds: Math.min(durationSeconds, Math.max(0, clip.fadeInSeconds - start)),
    fadeOutSeconds: Math.min(durationSeconds, Math.max(0, end - (clip.durationSeconds - clip.fadeOutSeconds))),
    gainEnvelope: sliceEnvelope(getClipEnvelope(clip), start, end),
    ...(clip.gainRegions ? { gainRegions: sliceGainRegions(clip.gainRegions, start, end) } : {}),
    ...(clip.volumeAutomation ? { volumeAutomation: sliceEnvelope(clip.volumeAutomation, start, end) } : {}) }
}
function makeTrack(input = {}) {
  return { id: generateId('track'), name: 'Audio track', gainDb: 0, pan: 0, mute: false, solo: false, clips: [], ...input }
}
function makeClip(project, input) {
  object(input, 'clip')
  const asset = project.assets.find(candidate => candidate.id === input.assetId)
  if (!asset) fail('cannot add a clip without its source asset')
  return { id: generateId('clip'), assetId: asset.id, name: asset.name, atSeconds: 0,
    offsetSeconds: 0, durationSeconds: asset.duration - (input.offsetSeconds ?? 0),
    gainDb: 0, fadeInSeconds: 0, fadeOutSeconds: 0, ...input }
}
function trackById(project, trackId) {
  const track = project.tracks.find(candidate => candidate.id === trackId)
  if (!track) fail(`track not found: ${trackId}`)
  return track
}
function clipById(track, clipId) {
  const clip = track.clips.find(candidate => candidate.id === clipId)
  if (!clip) fail(`clip not found: ${clipId}`)
  return clip
}
// Group commands accept data only, including their reference arrays. Reject
// accessors and hidden/symbol keys before reading them or cloning metadata.
function groupKeys(value, allowed, label) {
  object(value, label)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!allowed.includes(key) || !descriptor.enumerable || !own(descriptor, 'value')) fail(`${label}: unsupported field ${String(key)}`)
  }
}
function groupArray(value, label) {
  array(value, label, DAW_LIMITS.maxClips)
  if (Object.getPrototypeOf(value) !== Array.prototype || !value.length) fail(`${label} must contain 1–${DAW_LIMITS.maxClips} items`)
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length ||
        !descriptor.enumerable || !own(descriptor, 'value')) fail(`${label}: invalid array metadata`)
  }
  for (let index = 0; index < value.length; index++) if (!own(value, index)) fail(`${label}: missing item`)
}
function resolveClipGroup(project, refs) {
  groupArray(refs, 'clip references')
  const seen = new Set()
  return refs.map(ref => {
    groupKeys(ref, ['trackId', 'clipId'], 'clip reference')
    id(ref.trackId, 'reference track ID'); unique(ref.clipId, seen, 'reference clip ID')
    const track = trackById(project, ref.trackId), clip = clipById(track, ref.clipId)
    return { track, clip }
  })
}
function describeResolvedGroup(selected) {
  const startSeconds = Math.min(...selected.map(({ clip }) => clip.atSeconds))
  const endSeconds = Math.max(...selected.map(({ clip }) => clip.atSeconds + clip.durationSeconds))
  return { refs: selected.map(({ track, clip }) => ({ trackId: track.id, clipId: clip.id })),
    count: selected.length, trackCount: new Set(selected.map(({ track }) => track.id)).size,
    startSeconds, endSeconds, durationSeconds: endSeconds - startSeconds,
    minDeltaSeconds: startSeconds === 0 ? 0 : -startSeconds, maxDeltaSeconds: DAW_LIMITS.maxDurationSeconds - endSeconds }
}
/** Group positions share one delta. Bounds never clamp members separately or
 * quantize source offsets, durations, fades or common-envelope coordinates. */
export function describeClipGroup(project, refs) {
  validateProject(project)
  return describeResolvedGroup(resolveClipGroup(project, refs))
}
function validateGroupDelta(selected, deltaSeconds) {
  const { minDeltaSeconds, maxDeltaSeconds } = describeResolvedGroup(selected)
  number(deltaSeconds, 'clip group delta seconds', minDeltaSeconds, maxDeltaSeconds)
}
function resolvedGroupOverlaps(selected, deltaSeconds, duplicate) {
  const selectedIds = new Set(selected.map(({ clip }) => clip.id)), overlaps = []
  for (const { track, clip } of selected) {
    const at = clip.atSeconds + deltaSeconds, end = at + clip.durationSeconds
    for (const other of track.clips) {
      // Moving replaces the selected clips. Copying leaves all originals in
      // place, so those originals must also count as potential collisions.
      if (!duplicate && selectedIds.has(other.id)) continue
      const startSeconds = Math.max(at, other.atSeconds)
      const endSeconds = Math.min(end, other.atSeconds + other.durationSeconds)
      // Endpoints are half-open. Only arithmetic roundoff is ignored, far
      // below a single native/output frame even at the latest project time.
      const tolerance = 8 * Number.EPSILON * Math.max(1, Math.abs(startSeconds), Math.abs(endSeconds))
      if (endSeconds - startSeconds > tolerance) overlaps.push({ trackId: track.id, clipId: clip.id,
        otherClipId: other.id, startSeconds, endSeconds })
    }
  }
  return overlaps
}
/** Concrete same-track collision pairs for preview and the atomic guard. */
export function getClipGroupOverlaps(project, refs, deltaSeconds, options = {}) {
  validateProject(project)
  groupKeys(options, ['duplicate'], 'clip overlap options')
  if (own(options, 'duplicate') && typeof options.duplicate !== 'boolean') fail('duplicate must be boolean')
  const selected = resolveClipGroup(project, refs)
  validateGroupDelta(selected, deltaSeconds)
  return resolvedGroupOverlaps(selected, deltaSeconds, options.duplicate === true)
}
function applyClipGroupCommand(project, command) {
  const duplicate = command.type === 'clips.duplicate', remove = command.type === 'clips.remove'
  groupKeys(command, remove ? ['type', 'refs'] : ['type', 'refs', 'deltaSeconds', 'allowOverlap', ...(duplicate ? ['newIds'] : [])], 'clip group command')
  const selected = resolveClipGroup(project, command.refs)
  if (remove) {
    const selectedIds = new Set(selected.map(({ clip }) => clip.id))
    for (const track of project.tracks) track.clips = track.clips.filter(clip => !selectedIds.has(clip.id))
    return
  }
  validateGroupDelta(selected, command.deltaSeconds)
  if (own(command, 'allowOverlap') && typeof command.allowOverlap !== 'boolean') fail('allowOverlap must be boolean')
  if (command.allowOverlap !== true) {
    const overlaps = resolvedGroupOverlaps(selected, command.deltaSeconds, duplicate)
    if (overlaps.length) {
      const error = new Error(`DAW: clip group would overlap ${overlaps.length} existing clip pair(s); confirm overlap for this operation`)
      error.code = 'CLIP_GROUP_OVERLAP'; error.overlaps = overlaps
      throw error
    }
  }
  if (duplicate) {
    const usedIds = new Set(project.tracks.flatMap(track => track.clips.map(clip => clip.id)))
    if (usedIds.size + selected.length > DAW_LIMITS.maxClips) fail('project exceeds 256 clips')
    if (own(command, 'newIds')) {
      groupArray(command.newIds, 'new clip IDs')
      if (command.newIds.length !== selected.length) fail('new clip IDs must match clip references')
    }
    const newIds = selected.map((_, index) => {
      const newId = command.newIds ? command.newIds[index] : generateId('clip')
      unique(newId, usedIds, 'clip ID')
      return newId
    })
    selected.forEach(({ track, clip }, index) => track.clips.push({ ...clone(clip), id: newIds[index], atSeconds: clip.atSeconds + command.deltaSeconds }))
  } else {
    for (const { clip } of selected) clip.atSeconds += command.deltaSeconds
  }
}
function patch(target, changes, allowed, label) {
  onlyKeys(changes, allowed, label)
  Object.assign(target, clone(changes))
}
function makeGainRegion(input, clipDuration) {
  onlyKeys(input, ['id', 'label', 'startSeconds', 'endSeconds', 'gain', 'fadeInSeconds', 'fadeOutSeconds'], 'gain region input')
  const defaultFade = Math.min(.01, (input.endSeconds - input.startSeconds) / 2)
  const region = { id: generateId('region'), fadeInSeconds: defaultFade, fadeOutSeconds: defaultFade, ...input }
  // Validate raw values before JSON cloning (Infinity/NaN must never become null).
  validateGainRegion(region, clipDuration)
  return clone(region)
}
/** Crop one timeline envelope into a clip. The shared geometry pins clip-edge
 * intersections to their exact stored duration, avoiding subtraction drift at
 * late timeline positions. Only roundoff at that endpoint is normalized. */
function cropTrackGainRegion(region, clip, intersection) {
  const cropped = sliceGainRegions([region], clip.atSeconds, clip.atSeconds + clip.durationSeconds)[0]
  cropped.startSeconds = intersection.startSeconds
  cropped.endSeconds = intersection.endSeconds
  const duration = cropped.endSeconds - cropped.startSeconds
  cropped.fadeInSeconds = Math.min(duration, cropped.fadeInSeconds)
  cropped.fadeOutSeconds = Math.min(duration - cropped.fadeInSeconds, cropped.fadeOutSeconds)
  if (cropped.attenuationEnvelope) {
    const points = cropped.attenuationEnvelope
    cropped.attenuationEnvelope = [points[0], ...points.slice(1, -1).filter(point => point.timeSeconds < duration),
      { ...points.at(-1), timeSeconds: duration }]
  }
  validateGainRegion(cropped, clip.durationSeconds)
  return cropped
}
/** Every successful command returns independent metadata; failed commands do not touch input. */
export function applyCommand(project, command) {
  validateProject(project); object(command, 'command')
  const type = Object.getOwnPropertyDescriptor(command, 'type')
  if (!type || !own(type, 'value')) fail('command type must be plain metadata')
  const next = clone(project)
  switch (command.type) {
    case 'project.update': {
      patch(next, command.patch, ['name', 'masterGainDb', 'sampleRate', 'tempo', 'timeSignature', 'gridOriginSeconds'], 'project patch')
      // Check the raw optional field too: JSON cloning can discard undefined.
      if (own(command.patch, 'gridOriginSeconds')) number(command.patch.gridOriginSeconds, 'grid origin seconds', 0, DAW_LIMITS.maxDurationSeconds)
      break
    }
    case 'timelineSelection.set': {
      onlyKeys(command, ['type', 'selection'], 'timeline selection command')
      // Validate before JSON cloning; non-finite numbers must never become null.
      validateTimelineSelection(command.selection, getProjectDuration(next), next.sampleRate)
      next.timelineSelection = clone(command.selection)
      break
    }
    case 'timelineSelection.clear': {
      onlyKeys(command, ['type'], 'timeline selection command')
      delete next.timelineSelection
      break
    }
    case 'asset.add': next.assets.push(clone(command.asset)); break
    case 'track.add': next.tracks.push(makeTrack(command.track ? clone(command.track) : {})); break
    case 'track.remove': {
      trackById(next, command.trackId)
      next.tracks = next.tracks.filter(track => track.id !== command.trackId); break
    }
    case 'track.duplicate': {
      const source = trackById(next, command.trackId)
      next.tracks.push({ ...clone(source), id: command.newId ?? generateId('track'), name: `${source.name.slice(0, 249)} copy`,
        clips: source.clips.map(clip => ({ ...clone(clip), id: generateId('clip') })) }); break
    }
    case 'track.update': patch(trackById(next, command.trackId), command.patch, ['name', 'gainDb', 'pan', 'mute', 'solo'], 'track patch'); break
    case 'track.gainRegion.add': {
      const track = trackById(next, command.trackId)
      // Start/end are absolute timeline seconds. Construct the edge ramps once
      // across the requested range, then crop, including gaps and overlapping
      // clips. Splits inside the range must not restart an entrance/exit fade.
      const region = makeGainRegion(command.region, DAW_LIMITS.maxDurationSeconds)
      const { intersections } = intersectTrackRange(track, region.startSeconds, region.endSeconds)
      if (!intersections.length) fail('gain region range does not intersect any audio clips')
      for (const intersection of intersections) {
        const clip = clipById(track, intersection.clipId)
        clip.gainRegions = [...(clip.gainRegions ?? []), cropTrackGainRegion(region, clip, intersection)]
      }
      // The shared final validation checks every resulting clip, duplicate ID,
      // and project limit before publishing this single command revision.
      break
    }
    case 'clip.add': trackById(next, command.trackId).clips.push(makeClip(next, clone(command.clip))); break
    case 'clips.move':
    case 'clips.duplicate':
    case 'clips.remove': applyClipGroupCommand(next, command); break
    case 'clip.remove': {
      const track = trackById(next, command.trackId); clipById(track, command.clipId)
      track.clips = track.clips.filter(clip => clip.id !== command.clipId); break
    }
    case 'clip.move': {
      const track = trackById(next, command.trackId), clip = clipById(track, command.clipId)
      clip.atSeconds = command.atSeconds
      if (command.toTrackId && command.toTrackId !== track.id) {
        const target = trackById(next, command.toTrackId)
        track.clips = track.clips.filter(candidate => candidate.id !== clip.id); target.clips.push(clip)
      }
      break
    }
    case 'clip.duplicate': {
      const track = trackById(next, command.trackId), clip = clipById(track, command.clipId)
      const target = command.toTrackId ? trackById(next, command.toTrackId) : track
      target.clips.push({ ...clone(clip), id: command.newId ?? generateId('clip'),
        atSeconds: command.atSeconds ?? clip.atSeconds + clip.durationSeconds }); break
    }
    case 'clip.split': {
      const track = trackById(next, command.trackId), clip = clipById(track, command.clipId)
      number(command.atSeconds, 'split position', clip.atSeconds, clip.atSeconds + clip.durationSeconds)
      const cut = command.atSeconds - clip.atSeconds
      if (cut <= 0 || cut >= clip.durationSeconds) fail('split must be inside the clip')
      track.clips.splice(track.clips.indexOf(clip), 1, sliceClip(clip, 0, cut),
        { ...sliceClip(clip, cut, clip.durationSeconds), id: command.newId ?? generateId('clip') }); break
    }
    case 'clip.trim': {
      const track = trackById(next, command.trackId), clip = clipById(track, command.clipId)
      number(command.startSeconds, 'trim start', clip.atSeconds, clip.atSeconds + clip.durationSeconds)
      number(command.endSeconds, 'trim end', command.startSeconds, clip.atSeconds + clip.durationSeconds)
      track.clips.splice(track.clips.indexOf(clip), 1, sliceClip(clip, command.startSeconds - clip.atSeconds, command.endSeconds - clip.atSeconds)); break
    }
    case 'clip.automation.add': {
      const clip = clipById(trackById(next, command.trackId), command.clipId)
      onlyKeys(command.point, ['timeSeconds', 'value'], 'volume automation point')
      // Validate before cloning: JSON would turn NaN/Infinity into null.
      number(command.point.timeSeconds, 'automation time', 0, clip.durationSeconds)
      number(command.point.value, 'automation gain', 0, DAW_LIMITS.maxAutomationGain)
      const points = getClipVolumeAutomation(clip)
      points.push({ ...command.point }); points.sort((a, b) => a.timeSeconds - b.timeSeconds)
      clip.volumeAutomation = points
      break
    }
    case 'clip.automation.update': {
      const clip = clipById(trackById(next, command.trackId), command.clipId)
      const points = getClipVolumeAutomation(clip)
      integer(command.index, 'automation point index', 0, points.length - 1)
      patch(points[command.index], command.patch, ['timeSeconds', 'value'], 'volume automation point patch')
      // Keep point identity and endpoint positions stable. Reordering is an error.
      clip.volumeAutomation = points
      break
    }
    case 'clip.automation.remove': {
      const clip = clipById(trackById(next, command.trackId), command.clipId)
      const points = getClipVolumeAutomation(clip)
      integer(command.index, 'interior automation point index', 1, points.length - 2)
      points.splice(command.index, 1); clip.volumeAutomation = points
      break
    }
    case 'clip.automation.reset': {
      delete clipById(trackById(next, command.trackId), command.clipId).volumeAutomation
      break
    }
    case 'clip.gainRegion.add':
    case 'clip.gainRegion.addMany': {
      const clip = clipById(trackById(next, command.trackId), command.clipId)
      const regions = command.type === 'clip.gainRegion.add' ? [command.region] : command.regions
      array(regions, 'new gain regions', DAW_LIMITS.maxGainRegionsPerClip)
      if (!regions.length) fail('add at least one gain region')
      clip.gainRegions = [...(clip.gainRegions ?? []), ...regions.map(region => makeGainRegion(region, clip.durationSeconds))]
      break
    }
    case 'clip.gainRegion.update': {
      const clip = clipById(trackById(next, command.trackId), command.clipId)
      const index = clip.gainRegions?.findIndex(region => region.id === command.regionId) ?? -1
      if (index < 0) fail(`gain region not found: ${command.regionId}`)
      onlyKeys(command.patch, ['label', 'startSeconds', 'endSeconds', 'gain', 'fadeInSeconds', 'fadeOutSeconds'], 'gain region patch')
      const region = { ...clip.gainRegions[index], ...command.patch }
      // Only explicit boundary/fade edits reset a cropped shape. Strength and
      // label changes keep exact partial fades, including a unity gain roundtrip.
      if (['startSeconds', 'endSeconds', 'fadeInSeconds', 'fadeOutSeconds'].some(key => own(command.patch, key))) delete region.attenuationEnvelope
      validateGainRegion(region, clip.durationSeconds)
      clip.gainRegions[index] = clone(region)
      break
    }
    case 'clip.gainRegion.remove': {
      const clip = clipById(trackById(next, command.trackId), command.clipId)
      const index = clip.gainRegions?.findIndex(region => region.id === command.regionId) ?? -1
      if (index < 0) fail(`gain region not found: ${command.regionId}`)
      clip.gainRegions.splice(index, 1)
      if (!clip.gainRegions.length) delete clip.gainRegions
      break
    }
    case 'clip.gainRegion.reset': {
      delete clipById(trackById(next, command.trackId), command.clipId).gainRegions
      break
    }
    case 'clip.replaceSource': {
      const clip = clipById(trackById(next, command.trackId), command.clipId)
      const asset = next.assets.find(candidate => candidate.id === command.assetId)
      if (!asset) fail('replacement source asset is missing')
      number(command.offsetSeconds, 'replacement source offset', 0, asset.duration)
      if (command.offsetSeconds + clip.durationSeconds > asset.duration + EPSILON) {
        fail('替換錄音長度不足；請減少新錄音起點、選較長的錄音，或先裁短原片段。原片段保持不變')
      }
      // Only source identity and source position change. No stretching, timing
      // guesses, renamed clip, gain reset, or destructive source-buffer edits.
      clip.assetId = asset.id; clip.offsetSeconds = command.offsetSeconds
      // A different recording drops the former recipe. A generated replacement
      // supplies a complete validated recipe in this same atomic command.
      if (command.transpose !== undefined) clip.transpose = clone(command.transpose)
      else delete clip.transpose
      break
    }
    case 'clip.update': {
      const clip = clipById(trackById(next, command.trackId), command.clipId)
      patch(clip, command.patch, ['name', 'gainDb', 'fadeInSeconds', 'fadeOutSeconds'], 'clip patch')
      // Explicit fade edits intentionally replace a cropped envelope. Gain/name edits preserve it.
      if (own(command.patch, 'fadeInSeconds') || own(command.patch, 'fadeOutSeconds')) delete clip.gainEnvelope
      break
    }
    default: fail(`unsupported command ${command.type}`)
  }
  // A structural edit can remove the end of a saved range. Clear the entire
  // range in this same undoable edit, never silently clamp either endpoint.
  // A newly requested out-of-bounds range is rejected above, never cleared.
  if (next.timelineSelection && command.type !== 'timelineSelection.set' &&
      next.timelineSelection.endSeconds > getProjectDuration(next)) delete next.timelineSelection
  next.revision = project.revision + 1
  validateProject(next)
  return next
}
/** Registration never copies or alters PCM. Original file blobs are retained by the caller. */
export function registerAudioBuffer(project, buffers, buffer, options = {}) {
  if (!(buffers instanceof Map)) fail('runtime buffers must be a Map')
  if (!buffer || typeof buffer.getChannelData !== 'function') fail('decoded AudioBuffer required')
  const asset = { id: options.id ?? generateId('asset'), name: options.name ?? 'Imported audio', hash: options.hash ?? '',
    duration: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels, length: buffer.length }
  if (options.sourceSampleRate !== undefined) asset.sourceSampleRate = options.sourceSampleRate
  if (options.decodeBackend !== undefined) asset.decodeBackend = options.decodeBackend
  const next = applyCommand(project, { type: 'asset.add', asset })
  const heldBuffers = new Set([...buffers.values(), buffer])
  let heldBytes = 0
  for (const held of heldBuffers) {
    if (!held || !Number.isSafeInteger(held.length) || !Number.isSafeInteger(held.numberOfChannels)) fail('invalid runtime audio buffer')
    heldBytes += held.length * held.numberOfChannels * 4
  }
  if (heldBytes > DAW_LIMITS.maxDecodedBytes || buffers.size >= DAW_LIMITS.maxAssets) fail('retained audio and undo sources exceed the 256 MiB / 64 asset limit; start a new project')
  if (buffers.has(asset.id)) fail('runtime buffer ID already exists')
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel)
    if (!(data instanceof Float32Array) || data.length !== buffer.length) fail('invalid decoded PCM channel')
    for (let index = 0; index < data.length; index++) if (!Number.isFinite(data[index])) fail('decoded PCM contains non-finite samples')
  }
  buffers.set(asset.id, buffer)
  return { project: next, asset: next.assets.at(-1) }
}
