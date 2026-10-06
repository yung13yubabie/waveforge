import { test, expect } from '@playwright/test'

// Pending actual Chromium/CI execution. This is an engine harness only, not
// editor/preview/export UX acceptance and not a perceptual listening test.
test('Signalsmith actual module worker: independent controls, transfer, cancellation and no audio upload', async ({ page }) => {
  await page.goto('/')
  const requests=[]
  page.on('request', request => requests.push({method:request.method(),url:request.url()}))
  const result=await page.evaluate(async()=>{
    const {createSignalsmithPitchClient}=await import('/src/js/pitch/signalsmith-client.js')
    const {renderSignalsmithPitch}=await import('/src/js/pitch/signalsmith-render.js')
    const sr=48000,input=Float32Array.from({length:sr},(_,i)=>.3*Math.sin(2*Math.PI*220*i/sr)),original=input.slice()
    const client=createSignalsmithPitchClient(),progress=[]
    try{
      const rendered=await client.render([input],sr,{semitones:2,sourceToken:'browser-fixture:1',onProgress:p=>progress.push(p)})
      const direct=await renderSignalsmithPitch([input],sr,{semitones:2})
      const cancelled=client.render([input],sr,{semitones:-2}).then(()=>null,error=>error.name)
      client.cancel()
      const rejected=await cancelled
      const formant=await client.render([input],sr,{formantSemitones:2,sourceToken:'browser-fixture:2'})
      const bypass=await client.render([new Float32Array([0,-0,1.5,-2])],sr)
      return {length:rendered.channels[0].length,rate:rendered.sampleRate,sourceToken:rendered.sourceToken,
        originalIntact:input.byteLength===original.byteLength&&input.every((v,i)=>Object.is(v,original[i])),
        workerCoreParity:rendered.channels[0].every((v,i)=>v===direct.channels[0][i]),finite:rendered.channels[0].every(Number.isFinite),
        metadata:rendered.metadata,progress,rejected,formantBypassed:formant.metadata.bypassed,
        bypassExact:Object.is(bypass.channels[0][1],-0)&&bypass.channels[0][2]===1.5}
    }finally{client.dispose()}
  })
  expect(result.length).toBe(48000)
  expect(result.rate).toBe(48000)
  expect(result.sourceToken).toBe('browser-fixture:1')
  expect(result.originalIntact).toBe(true)
  expect(result.workerCoreParity).toBe(true)
  expect(result.finite).toBe(true)
  expect(result.rejected).toBe('AbortError')
  expect(result.formantBypassed).toBe(false)
  expect(result.bypassExact).toBe(true)
  expect(result.progress.at(-1)).toBe(1)
  expect(result.progress.every((p,i)=>i===0||p>=result.progress[i-1])).toBe(true)
  expect(requests.some(r=>r.method==='POST')).toBe(false)
  expect(requests.some(r=>/huggingface|hf\.space|signalsmith-audio|githubusercontent/.test(r.url))).toBe(false)
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
