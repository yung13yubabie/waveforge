/** Pure, shared graph capability check and exact-version timestamp adapter. */
export function assertCrossAttentionOutputs(pipeline) {
  const outputs = pipeline?.model?.sessions?.decoder_model_merged?.outputNames
  const expected = [0, 1, 2, 3].map(i => `cross_attentions.${i}`)
  if (!Array.isArray(outputs) || !expected.every(name => outputs.includes(name))) {
    throw new Error('This pinned ONNX decoder has not supplied all four required cross-attention outputs; automatic timing is unavailable')
  }
}

const FRAME_CORRECTION = Symbol.for('waveforge.whisper.3.8.1.mel-to-encoder-frames')

/**
 * 3.8.1 pipeline passes 100 Hz mel-frame count, but its timestamp extractor
 * directly slices the 50 Hz encoder attention axis. Python's reference uses
 * num_frames // 2. Correct the INPUT crop count, never generated timestamps.
 * See docs/validation/LYRICS_MODEL_SOURCE_AND_APPROVAL.md for exact source lines.
 */
export function installWhisperFrameCorrection(model, version) {
  if (version !== '3.8.1') throw new Error('Whisper frame correction is validated only against Transformers.js 3.8.1')
  if (typeof model?._extract_token_timestamps !== 'function') throw new Error('Expected the pinned Whisper timestamp extractor')
  if (model[FRAME_CORRECTION]) {
    if (model[FRAME_CORRECTION] !== model._extract_token_timestamps) throw new Error('Whisper timestamp extractor changed after frame correction')
    return model
  }
  const original = model._extract_token_timestamps
  const corrected = function (outputs, alignmentHeads, melFrames, ...rest) {
    // A <=20 s 16 kHz window has <=2000 mel frames. Floor matches Python //.
    if (!Number.isSafeInteger(melFrames) || melFrames < 2 || melFrames > 2000) {
      throw new RangeError('Whisper requires a valid non-zero encoder-frame count for this <=20-second window')
    }
    const encoderFrames = Math.floor(melFrames / 2)
    return original.call(this, outputs, alignmentHeads, encoderFrames, ...rest)
  }
  model._extract_token_timestamps = corrected
  Object.defineProperty(model, FRAME_CORRECTION, { value: corrected })
  return model
}

