// The integer encoders quantize/clamp by design. Gate final deliveries first.
export function assertIntegerHeadroom(channels, allowHardClip = false) {
  let peak = 0
  for (const channel of channels) for (const sample of channel) {
    if (!Number.isFinite(sample)) throw new Error('處理結果含非有限數值，已停止輸出')
    peak = Math.max(peak, Math.abs(sample))
  }
  if (peak > 1 && !allowHardClip) {
    throw new Error(`成品超峰值 ${ (20 * Math.log10(peak)).toFixed(2) } dBFS。請降低母帶增益、啟用 True Peak 限制，或明確勾選「允許硬削波」再輸出。`)
  }
  return peak > 1
}
