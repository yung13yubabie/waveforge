export const signalNames = ['impulse', 'sine100', 'sine1000', 'sine10000', 'multitone', 'noise', 'transient', 'correlated', 'antiphase']
export function signal(ctx, kind, seconds = 0.6) {
  const b = ctx.createBuffer(2, Math.round(ctx.sampleRate * seconds), ctx.sampleRate)
  let seed = 12345
  for (let i = 0; i < b.length; i++) {
    const t = i / b.sampleRate
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    let x = 0
    if (kind === 'impulse') x = i === 512 ? 0.7 : 0
    else if (kind === 'noise') x = (seed / 4294967296 - 0.5) * 0.8
    else if (kind === 'transient') x = 0.8 * Math.exp(-t * 35) * Math.sin(2 * Math.PI * 100 * t)
    else if (kind === 'multitone') x = [100, 1000, 10000].reduce((s, hz) => s + 0.15 * Math.sin(2 * Math.PI * hz * t), 0)
    else x = 0.6 * Math.sin(2 * Math.PI * (Number(kind.replace('sine', '')) || 1000) * t)
    b.getChannelData(0)[i] = x; b.getChannelData(1)[i] = kind === 'antiphase' ? -x : x
  }
  return b
}
