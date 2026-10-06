// Research-only configuration sweep of documented C++ APIs. Never selects a
// production setting automatically, changes channels, or substitutes dry edges.
import { createSignalsmithModule } from '../src/js/pitch/vendor/signalsmith-stretch/SignalsmithStretch.mjs'
import { tone, crossingFrequency, centsError, peak } from '../tests/audio/pitch-shift-fixtures.js'
const configurations = [
  { name: 'default' }, { name: 'cheaper' },
  { name: '120ms-10ms', blockMs: 120, intervalMs: 10 },
  { name: '240ms-20ms', blockMs: 240, intervalMs: 20 },
  { name: '240ms-30ms', blockMs: 240, intervalMs: 30 },
  { name: '360ms-30ms', blockMs: 360, intervalMs: 30 },
  { name: '480ms-30ms', blockMs: 480, intervalMs: 30 },
]
async function render(channels, sr, st, config) {
  const m = await createSignalsmithModule()
  if (config.blockMs) m._configure(channels.length, Math.round(config.blockMs * sr / 1000), Math.round(config.intervalMs * sr / 1000), false)
  else if (config.name === 'cheaper') m._presetCheaper(channels.length, sr)
  else m._presetDefault(channels.length, sr)
  m._reset(); m._setTransposeSemitones(st, 0); m._setFormantSemitones(0, false)
  const il=m._inputLatency(), ol=m._outputLatency(), bufferLength=Math.max(il,ol,2048), p=m._setBuffers(channels.length,bufferLength), length=channels[0].length
  const output=channels.map(()=>new Float32Array(length))
  const fill=(at,count)=>channels.forEach((x,c)=>{const t=new Float32Array(m.HEAP8.buffer,p+c*bufferLength*4,count);t.fill(0);if(at<length)t.set(x.subarray(at,Math.min(length,at+count)))})
  fill(0,il);m._seek(il,1)
  for(let at=0;at<length+ol;at+=2048){const count=Math.min(2048,length+ol-at);fill(at+il,count);m._process(count,count);output.forEach((x,c)=>{const a=new Float32Array(m.HEAP8.buffer,p+(c+channels.length)*bufferLength*4,count);const from=Math.max(0,ol-at),to=Math.min(count,length+ol-at);for(let i=from;i<to;i++)x[at+i-ol]=a[i]})}
  m._flush(ol)
  return {channels:output,inputLatency:il,outputLatency:ol,blockSamples:m._blockSamples(),intervalSamples:m._intervalSamples(),wasmMemoryBytes:m.HEAP8.buffer.byteLength}
}
const results=[]
for(const config of configurations){
  const item={config,tones:[],closeStereo:[],impulses:[]};const start=performance.now()
  for(const sr of [44100,48000,96000]){
    for(const st of [-2,2])for(const frequency of [55,110,180,220,440,997]){
      const r=await render([tone(sr,1,frequency)],sr,st,config),measured=crossingFrequency(r.channels[0],sr)
      item.tones.push({sr,st,frequency,measured,cents:centsError(measured,frequency*2**(st/12))})
    }
    for(const frequencies of [[220,230],[220,240],[55,60]])for(const st of [-2,2]){
      const r=await render(frequencies.map(f=>tone(sr,1,f)),sr,st,config)
      item.closeStereo.push({sr,st,frequencies,cents:r.channels.map((x,c)=>centsError(crossingFrequency(x,sr),frequencies[c]*2**(st/12))),latency:[r.inputLatency,r.outputLatency],block:r.blockSamples,interval:r.intervalSamples,wasmMemoryBytes:r.wasmMemoryBytes})
    }
  }
  for(const st of [-2,2])for(const index of [0,100,24000,47900,47999]){
    const x=new Float32Array(48000);x[index]=.8;const y=(await render([x],48000,st,config)).channels[0];let max=0,energy=0,pre=0;for(let i=0;i<y.length;i++){if(Math.abs(y[i])>Math.abs(y[max]))max=i;energy+=y[i]**2;if(i<index)pre+=y[i]**2}
    item.impulses.push({st,index,peakDelayMs:(max-index)/48,energyDb:10*Math.log10(energy/.64),peakDb:20*Math.log10(peak(y)/.8),preEnergyFraction:pre/energy})
  }
  item.wallMilliseconds=performance.now()-start
  item.summary={maximumAbsToneCents:Math.max(...item.tones.map(x=>Math.abs(x.cents))),maximumAbsStereoCents:Math.max(...item.closeStereo.flatMap(x=>x.cents.map(Math.abs))),maximumAbsImpulseDelayMs:Math.max(...item.impulses.map(x=>Math.abs(x.peakDelayMs))),minimumImpulseEnergyDb:Math.min(...item.impulses.map(x=>x.energyDb))}
  results.push(item)
}
console.log(JSON.stringify({configurationsSource:'https://github.com/Signalsmith-Audio/signalsmith-stretch/blob/222093b4cc13ddb4d07c826bc3c1559326091731/README.md',note:'Custom configurations exercise the documented configure API; their quality is not endorsed by upstream. All native multichannel; no independent-channel fallback. These are observations, not perceptual acceptance.',results},null,2))
