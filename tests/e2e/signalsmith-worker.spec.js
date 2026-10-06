import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { renderSignalsmithPitch } from '../../src/js/pitch/signalsmith-render.js'

// This is an engine harness only, not
// editor/preview/export UX acceptance and not a perceptual listening test.
test('Signalsmith actual module worker: independent controls, transfer, cancellation and no audio upload', async ({ page }, testInfo) => {
  // The app deliberately runs WASM in a Worker. Its main-page CSP must stay
  // strict. Compute the direct-core oracle in the Node test runner, then send
  // identical synthetic Float32 bytes to the actual browser Worker.
  const sampleRate = 48000
  const fixture = Float32Array.from({ length: sampleRate }, (_, i) => .3 * Math.sin(2 * Math.PI * 220 * i / sampleRate))
  const expectedInputHash = createHash('sha256').update(Buffer.from(fixture.buffer)).digest('hex')
  const direct = await renderSignalsmithPitch([fixture], sampleRate, { semitones: 2 })
  const expectedHash = createHash('sha256').update(Buffer.from(direct.channels[0].buffer)).digest('hex')
  await page.goto('/')
  const requests=[]
  page.on('request', request => requests.push({method:request.method(),url:request.url()}))
  const result=await page.evaluate(async({ inputBase64 })=>{
    const {createSignalsmithPitchClient}=await import('/src/js/pitch/signalsmith-client.js')
    const sr=48000,input=new Float32Array(Uint8Array.from(atob(inputBase64), char=>char.charCodeAt(0)).buffer),original=input.slice()
    const inputPcmHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', input))]
      .map(byte=>byte.toString(16).padStart(2,'0')).join('')
    const mainThreadWasmError = await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0]))
      .then(()=>null, error=>({name:error.name,message:error.message}))
    const client=createSignalsmithPitchClient(),progress=[]
    try{
      const rendered=await client.render([input],sr,{semitones:2,sourceToken:'browser-fixture:1',onProgress:p=>progress.push(p)})
      const workerPcmHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', rendered.channels[0]))]
        .map(byte=>byte.toString(16).padStart(2,'0')).join('')
      const cancelled=client.render([input],sr,{semitones:-2}).then(()=>null,error=>error.name)
      client.cancel()
      const rejected=await cancelled
      const formant=await client.render([input],sr,{formantSemitones:2,sourceToken:'browser-fixture:2'})
      const bypass=await client.render([new Float32Array([0,-0,1.5,-2])],sr)
      return {length:rendered.channels[0].length,rate:rendered.sampleRate,channels:rendered.channels.length,sourceToken:rendered.sourceToken,
        originalIntact:input.byteLength===original.byteLength&&input.every((v,i)=>Object.is(v,original[i])),
        inputPcmHash,workerPcmHash,mainThreadWasmError,finite:rendered.channels[0].every(Number.isFinite),
        metadata:rendered.metadata,progress,rejected,formantBypassed:formant.metadata.bypassed,
        bypassExact:Object.is(bypass.channels[0][1],-0)&&bypass.channels[0][2]===1.5}
    }finally{client.dispose()}
  }, { inputBase64: Buffer.from(fixture.buffer).toString('base64') })
  expect(result.length).toBe(48000)
  expect(result.rate).toBe(48000)
  expect(result.channels).toBe(1)
  expect(result.sourceToken).toBe('browser-fixture:1')
  expect(result.originalIntact).toBe(true)
  expect(result.workerPcmHash).toBe(expectedHash)
  expect(result.inputPcmHash).toBe(expectedInputHash)
  expect(result.metadata).toMatchObject({ engine: 'signalsmith-stretch-1.3.2', semitones: 2, inputSamples: 48000, outputSamples: 48000, outputGain: 1, bypassed: false })
  expect(result.mainThreadWasmError?.name).toBe('CompileError')
  expect(result.mainThreadWasmError?.message).toContain('Content Security')
  expect(result.finite).toBe(true)
  expect(result.rejected).toBe('AbortError')
  expect(result.formantBypassed).toBe(false)
  expect(result.bypassExact).toBe(true)
  expect(result.progress.at(-1)).toBe(1)
  expect(result.progress.every((p,i)=>i===0||p>=result.progress[i-1])).toBe(true)
  expect(requests.some(r=>r.method==='POST')).toBe(false)
  expect(requests.some(r=>/huggingface|hf\.space|signalsmith-audio|githubusercontent/.test(r.url))).toBe(false)
  const evidencePath = testInfo.outputPath('signalsmith-worker-core-and-csp.json')
  await writeFile(evidencePath, JSON.stringify({ nodeInputHash: expectedInputHash, nodeOutputHash: expectedHash,
    browser: result, requests, scope: 'Direct-core Node oracle versus genuine browser Worker; main-page CSP unchanged; not perceptual validation' }, null, 2))
  await testInfo.attach('signalsmith-worker-core-and-csp.json', { path: evidencePath, contentType: 'application/json' })
})

test('Signalsmith actual worker preserves supported rates and two native channels', async ({ page }) => {
  await page.goto('/')
  const results=await page.evaluate(async()=>{
    const {createSignalsmithPitchClient}=await import('/src/js/pitch/signalsmith-client.js')
    const client=createSignalsmithPitchClient(),results=[]
    try{
      for(const sr of [44100,48000,96000])for(const semitones of [-2,2]){
        const input=[220,240].map(hz=>Float32Array.from({length:sr/2},(_,i)=>.2*Math.sin(2*Math.PI*hz*i/sr)))
        const result=await client.render(input,sr,{semitones,sourceToken:`${sr}:${semitones}`})
        results.push({sr,rate:result.sampleRate,lengths:result.channels.map(x=>x.length),finite:result.channels.every(x=>x.every(Number.isFinite)),inputIntact:input.every(x=>x.byteLength===sr/2*4),sourceToken:result.sourceToken,outputPeak:result.metadata.outputPeak})
      }
      return results
    }finally{client.dispose()}
  })
  expect(results).toHaveLength(6)
  for(const result of results){
    expect(result.rate).toBe(result.sr)
    expect(result.lengths).toEqual([result.sr/2,result.sr/2])
    expect(result.finite).toBe(true)
    expect(result.inputIntact).toBe(true)
    expect(result.outputPeak).toBeGreaterThan(0)
  }
})
