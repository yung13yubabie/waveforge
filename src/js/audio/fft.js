// Minimal radix-2 Cooley-Tukey FFT (in-place, split re/im). Pure + testable.
// Used for linear-phase FIR design and FFT convolution at export time.

// n must be a power of two. Transforms in place; inverse normalises by 1/n.
export function fft(re, im, inverse = false) {
  const n = re.length
  if ((n & (n - 1)) !== 0) throw new Error('FFT length must be a power of 2')

  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr
      const ti = im[i]; im[i] = im[j]; im[j] = ti
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len
    const wre = Math.cos(ang), wim = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cre = 1, cim = 0
      const half = len >> 1
      for (let k = 0; k < half; k++) {
        const a = i + k, b = i + k + half
        const vre = re[b] * cre - im[b] * cim
        const vim = re[b] * cim + im[b] * cre
        re[b] = re[a] - vre; im[b] = im[a] - vim
        re[a] += vre;        im[a] += vim
        const ncre = cre * wre - cim * wim
        cim = cre * wim + cim * wre
        cre = ncre
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n }
  }
}

export function nextPow2(x) {
  let n = 1
  while (n < x) n <<= 1
  return n
}

// Linear convolution of two real signals via FFT overlap-add.
// Returns Float64Array of length a.length + b.length - 1.
export function fftConvolve(a, b) {
  const M = a.length, N = b.length
  const outLen = M + N - 1
  const fftSize = nextPow2(N * 2)          // block transform size
  const hop = fftSize - N + 1              // samples consumed per block
  const out = new Float64Array(outLen)

  // Pre-transform the kernel once
  const bre = new Float64Array(fftSize), bim = new Float64Array(fftSize)
  for (let i = 0; i < N; i++) bre[i] = b[i]
  fft(bre, bim)

  const xre = new Float64Array(fftSize), xim = new Float64Array(fftSize)
  for (let start = 0; start < M; start += hop) {
    xre.fill(0); xim.fill(0)
    const blk = Math.min(hop, M - start)
    for (let i = 0; i < blk; i++) xre[i] = a[start + i]
    fft(xre, xim)
    // pointwise multiply
    for (let i = 0; i < fftSize; i++) {
      const r = xre[i] * bre[i] - xim[i] * bim[i]
      const im2 = xre[i] * bim[i] + xim[i] * bre[i]
      xre[i] = r; xim[i] = im2
    }
    fft(xre, xim, true)
    const writeLen = Math.min(fftSize, outLen - start)
    for (let i = 0; i < writeLen; i++) out[start + i] += xre[i]
  }
  return out
}
