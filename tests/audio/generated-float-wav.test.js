// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { encodeGeneratedFloatWav, validateGeneratedFloatWavInput, GENERATED_FLOAT_WAV_LIMITS } from '../../src/js/audio/generated-float-wav.js'
import { wavSampleRate } from '../../src/js/audio/asset-decode.js'
import { createProject, applyCommand, registerAudioBuffer } from '../../src/js/daw/project.js'
import { ProjectHistory } from '../../src/js/daw/history.js'
import { exportProjectArchive, importProjectArchive } from '../../src/js/daw/archive.js'
import { sha256Hex } from '../../src/js/audio/sha256.js'
const encode = (channels, sampleRate = 48000, options = {}) => encodeGeneratedFloatWav(channels, sampleRate, { yieldControl: async () => {}, ...options })
const tag = (view, offset) => String.fromCharCode(...new Uint8Array(view.buffer, offset, 4))
const sameBits = (a,b) => Buffer.from(a.buffer,a.byteOffset,a.byteLength).equals(Buffer.from(b.buffer,b.byteOffset,b.byteLength))
// Independent narrow RIFF chunk reader, deliberately not a shipped decoder.
function fixtureDecode(bytes) {
  const v=new DataView(bytes);expect(tag(v,0)).toBe('RIFF');expect(tag(v,8)).toBe('WAVE');expect(v.getUint32(4,true)).toBe(bytes.byteLength-8)
  let rate,channels,payload,frames
  for(let at=12;at+8<=bytes.byteLength;){const name=tag(v,at),size=v.getUint32(at+4,true),data=at+8;expect(data+size).toBeLessThanOrEqual(bytes.byteLength)
    if(name==='fmt '){expect(size).toBe(18);expect(v.getUint16(data,true)).toBe(3);channels=v.getUint16(data+2,true);rate=v.getUint32(data+4,true);expect(v.getUint16(data+14,true)).toBe(32);expect(v.getUint16(data+16,true)).toBe(0);expect(v.getUint16(data+12,true)).toBe(channels*4);expect(v.getUint32(data+8,true)).toBe(rate*channels*4)}
    if(name==='fact')frames=v.getUint32(data,true)
    if(name==='data')payload={data,size}
    at=data+size+(size&1)
  }
  expect(payload.size).toBe(frames*channels*4)
  const pcm=Array.from({length:channels},(_,c)=>Float32Array.from({length:frames},(_,i)=>v.getFloat32(payload.data+(i*channels+c)*4,true)))
  return {sampleRate:rate,numberOfChannels:channels,length:frames,duration:frames/rate,getChannelData:c=>pcm[c]}
}
const samples=()=>new Float32Array([0,-0,1,-1,1.5,-2,.123456789,1e-40,-1e-40,3.4028234663852886e38])

describe('internal lossless generated Float32 WAV persistence',()=>{
  for(const sr of [44100,48000,96000])for(const channelCount of [1,2]){
    it(`preserves exact Float32 bits and native channel layout at ${sr} Hz/${channelCount} ch`,async()=>{
      const channels=Array.from({length:channelCount},(_,c)=>c===0?samples():samples().reverse()),originals=channels.map(x=>x.slice())
      const bytes=await encode(channels,sr),restored=fixtureDecode(bytes)
      expect(bytes.byteLength).toBe(58+channels.length*channels[0].length*4)
      expect(wavSampleRate(bytes)).toBe(sr)
      expect(restored.sampleRate).toBe(sr)
      for(let c=0;c<channelCount;c++){expect(sameBits(restored.getChannelData(c),channels[c])).toBe(true);expect(sameBits(channels[c],originals[c])).toBe(true)}
    })
  }
  it.each([NaN,Infinity,-Infinity])('rejects %s without clipping or mutating source',async value=>{
    const input=new Float32Array([.1,value,.3]),before=input.slice()
    await expect(encode([input])).rejects.toThrow('finite');expect(sameBits(input,before)).toBe(true)
  })
  it('checks hard shape/resource bounds before output allocation',()=>{
    const x=new Float32Array(1)
    for(const args of [[[],48000],[[x,x,x],48000],[[x],16000],[[new Float64Array(1)],48000],[[x,new Float32Array(2)],48000],[[new Float32Array(0)],48000],[[x,,],48000],[[,x],48000],[[new Float32Array(96000*30+1)],96000],[[x],48000,{signal:{}}]])expect(()=>validateGeneratedFloatWavInput(...args)).toThrow()
    expect(GENERATED_FLOAT_WAV_LIMITS.maxEncodedBytes).toBe(23040058)
    expect(()=>validateGeneratedFloatWavInput([new Float32Array(new SharedArrayBuffer(4))],48000)).toThrow('Shared')
  })
  it('serializes the maximum 30-second/96 kHz stereo allocation exactly within its cap',async()=>{
    const left=new Float32Array(96000*30),right=new Float32Array(left.length)
    left[0]=-0;left[left.length-1]=1.25;right[0]=-.5;right[right.length-1]=-1.5
    const bytes=await encode([left,right],96000),view=new DataView(bytes)
    expect(bytes.byteLength).toBe(GENERATED_FLOAT_WAV_LIMITS.maxEncodedBytes)
    expect(Object.is(view.getFloat32(58,true),-0)).toBe(true)
    expect(view.getFloat32(62,true)).toBe(-.5)
    expect(view.getFloat32(bytes.byteLength-8,true)).toBe(1.25)
    expect(view.getFloat32(bytes.byteLength-4,true)).toBe(-1.5)
    expect(view.getUint32(46,true)).toBe(96000*30)
  })
  it('cancels before work and after a bounded yield; only successful completion emits 1',async()=>{
    const first=new AbortController();first.abort();await expect(encode([samples()],48000,{signal:first.signal})).rejects.toMatchObject({name:'AbortError'})
    const second=new AbortController(),progress=[]
    await expect(encode([new Float32Array(48000)],48000,{signal:second.signal,onProgress:x=>progress.push(x),yieldControl:async()=>second.abort()})).rejects.toMatchObject({name:'AbortError'})
    expect(progress.at(-1)).toBeLessThan(1)
    const done=[];await encode([new Float32Array(48000)],48000,{onProgress:x=>done.push(x)})
    expect(done.at(-1)).toBe(1);expect(done.every((x,i)=>i===0||x>=done[i-1])).toBe(true)
  })
  it('seals completed bytes before terminal observers, so late abort/observer throws do not report false failure',async()=>{
    const controller=new AbortController(),events=[]
    const bytes=await encode([samples()],48000,{signal:controller.signal,onProgress:value=>{events.push(value);if(value===1)controller.abort();throw Error('observer')}})
    expect(bytes.byteLength).toBe(58+samples().length*4)
    expect(events.at(-1)).toBe(1);expect(controller.signal.aborted).toBe(true)
  })
  it('fits existing asset/hash/history/ZIP validation without silently converting to integer PCM',async()=>{
    const original=samples(),bytes=await encode([original],44100),buffer=fixtureDecode(bytes),buffers=new Map(),files=new Map()
    const initial=createProject({id:'float-roundtrip',sampleRate:48000}),history=new ProjectHistory(initial)
    const registered=registerAudioBuffer(initial,buffers,buffer,{id:'generated',name:'generated.wav',hash:await sha256Hex(bytes),sourceSampleRate:44100,decodeBackend:'generated-float32-wav'})
    files.set('generated',new File([bytes],'generated.wav',{type:'audio/wav'}))
    let project=applyCommand(registered.project,{type:'track.add',track:{id:'track'}})
    project=applyCommand(project,{type:'clip.add',trackId:'track',clip:{id:'clip',assetId:'generated'}})
    history.push(project);expect(history.undo()).toEqual(initial);expect(history.redo()).toEqual(project)
    const archive=await exportProjectArchive(project,files)
    const restored=await importProjectArchive(archive,{decodeAsset:async wav=>fixtureDecode(wav)})
    expect(restored.project).toEqual(project)
    expect(Buffer.from(await restored.files.get('generated').arrayBuffer()).equals(Buffer.from(bytes))).toBe(true)
    expect(sameBits(restored.buffers.get('generated').getChannelData(0),original)).toBe(true)
    // New browser sessions restore saved state/media, not the in-memory history.
    expect(new ProjectHistory(restored.project).canUndo).toBe(false)
  })
})
