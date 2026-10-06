import { test, expect } from '@playwright/test'

// Integration harness only: no shipping UI change, no remote upload, and no
// perceptual validation. Run in a permitted real-browser environment, not here.
test('same Signalsmith PCM survives native audition, accepted asset, Undo/Redo and ordinary ZIP decode', async ({ page }) => {
  await page.goto('/')
  const records=await page.evaluate(async()=>{
    const {createSignalsmithPitchClient}=await import('/src/js/pitch/signalsmith-client.js')
    const {encodeGeneratedFloatWav}=await import('/src/js/audio/generated-float-wav.js')
    const {createProject,applyCommand,registerAudioBuffer}=await import('/src/js/daw/project.js')
    const {ProjectHistory}=await import('/src/js/daw/history.js')
    const {renderProject}=await import('/src/js/daw/render.js')
    const {exportProjectArchive,importProjectArchive}=await import('/src/js/daw/archive.js')
    const {decodeSourceAsset}=await import('/src/js/audio/asset-decode.js')
    const {sha256Hex}=await import('/src/js/audio/sha256.js')
    const bitEqual=(a,b)=>{if(a.byteLength!==b.byteLength)return false;const aa=new Uint8Array(a.buffer,a.byteOffset,a.byteLength),bb=new Uint8Array(b.buffer,b.byteOffset,b.byteLength);return aa.every((v,i)=>v===bb[i])}
    const native=(channels,sr)=>{const b=new AudioBuffer({numberOfChannels:channels.length,length:channels[0].length,sampleRate:sr});channels.forEach((x,c)=>b.copyToChannel(x,c));return b}
    const client=createSignalsmithPitchClient(),records=[]
    try{
      for(const sr of [44100,48000,96000]){
        const pcm=[180,230].map((hz,c)=>Float32Array.from({length:Math.round(sr*1.5)},(_,i)=>.2*Math.sin(2*Math.PI*hz*i/sr)*(c?-0.5:1)))
        const source=native(pcm,sr),originalBytes=await encodeGeneratedFloatWav(pcm,sr)
        const buffers=new Map(),files=new Map(),originalFile=new File([originalBytes],'original-float.wav',{type:'audio/wav'})
        let project=registerAudioBuffer(createProject({sampleRate:sr}),buffers,source,{id:'source',name:originalFile.name,hash:await sha256Hex(originalBytes),sourceSampleRate:sr,decodeBackend:'generated-float32-wav'}).project
        files.set('source',originalFile)
        project=applyCommand(project,{type:'track.add',track:{id:'vocal',gainDb:-2}})
        project=applyCommand(project,{type:'clip.add',trackId:'vocal',clip:{id:'phrase',assetId:'source',atSeconds:.25,offsetSeconds:.125,durationSeconds:1,fadeInSeconds:.1,fadeOutSeconds:.1}})
        project=applyCommand(project,{type:'clip.automation.add',trackId:'vocal',clipId:'phrase',point:{timeSeconds:.5,value:.7}})
        const originalProject=project,originalClip=project.tracks[0].clips[0],history=new ProjectHistory(project)
        const first=Math.floor(originalClip.offsetSeconds*sr),last=Math.ceil((originalClip.offsetSeconds+originalClip.durationSeconds)*sr),length=last-first
        const replacementOffset=originalClip.offsetSeconds-first/sr
        const selection=pcm.map(x=>x.slice(first,first+length))
        const result=await client.render(selection,sr,{semitones:2,sourceToken:`${project.id}:${project.revision}:phrase`})
        const candidate=native(result.channels,sr)
        // One native buffer is assigned to audition AND registered as accepted
        // media. A null/offline graph avoids pretending this is a listening test.
        const auditionContext=new OfflineAudioContext(2,length,sr),auditionSource=auditionContext.createBufferSource()
        auditionSource.buffer=candidate;auditionSource.connect(auditionContext.destination);auditionSource.start(0)
        const audition=await auditionContext.startRendering()
        const candidateBytes=await encodeGeneratedFloatWav(result.channels,sr)
        const candidateFile=new File([candidateBytes],'transposed-float.wav',{type:'audio/wav'})
        const stagedBuffers=new Map(buffers),stagedFiles=new Map(files)
        let staged=registerAudioBuffer(project,stagedBuffers,candidate,{id:'transposed',name:candidateFile.name,hash:await sha256Hex(candidateBytes),sourceSampleRate:sr,decodeBackend:'generated-float32-wav'}).project
        stagedFiles.set('transposed',candidateFile)
        // Single-clip fixture staging with current public commands. Shipping
        // integration should use the takes branch's atomic clip.replaceSource;
        // do not generalise remove/add to ordered multi-clip project mutation.
        staged=applyCommand(staged,{type:'clip.remove',trackId:'vocal',clipId:'phrase'})
        staged=applyCommand(staged,{type:'clip.add',trackId:'vocal',clip:{...originalClip,assetId:'transposed',offsetSeconds:replacementOffset}})
        const candidateMix=await renderProject(staged,stagedBuffers)
        history.push(staged)
        const accepted=history.current,acceptedBuffer=stagedBuffers.get('transposed')
        const undo=history.undo(),redo=history.redo()
        const zip=await exportProjectArchive(accepted,stagedFiles)
        // Crucially use the ordinary native browser decoder, not a fixture stub.
        const restored=await importProjectArchive(zip)
        const restoredMix=await renderProject(restored.project,restored.buffers)
        // A mismatched monitor context must still decode a WAV at native rate.
        const monitor=new OfflineAudioContext(2,1,sr===48000?44100:48000)
        const decoded=await decodeSourceAsset(candidateBytes.slice(0),monitor)
        records.push({sr,
          nativeInstance:candidate instanceof AudioBuffer,acceptedSameBuffer:acceptedBuffer===auditionSource.buffer,
          nativePCMExact:result.channels.every((x,c)=>bitEqual(x,candidate.getChannelData(c))),
          auditionPCMExact:result.channels.every((x,c)=>bitEqual(x,audition.getChannelData(c))),
          clipPreserved:JSON.stringify(accepted.tracks[0].clips[0])===JSON.stringify({...originalClip,assetId:'transposed',offsetSeconds:replacementOffset}),
          undoOriginal:JSON.stringify(undo)===JSON.stringify(originalProject),redoAccepted:JSON.stringify(redo)===JSON.stringify(accepted),
          zipPCMExact:result.channels.every((x,c)=>bitEqual(x,restored.buffers.get('transposed').getChannelData(c))),
          zipBlobExact:await sha256Hex(await restored.files.get('transposed').arrayBuffer())===await sha256Hex(candidateBytes),
          mixParity:[0,1].every(c=>bitEqual(candidateMix.buffer.getChannelData(c),restoredMix.buffer.getChannelData(c))),
          sourceRetained:restored.files.size===2&&await sha256Hex(await restored.files.get('source').arrayBuffer())===await sha256Hex(originalBytes),
          nativeDecodeRate:decoded.buffer.sampleRate,nativeDecodeLength:decoded.buffer.length,expectedFrames:length,
          freshHistoryHasUndo:new ProjectHistory(restored.project).canUndo,
        })
      }
      return records
    }finally{client.dispose()}
  })
  expect(records).toHaveLength(3)
  for(const r of records){
    for(const field of ['nativeInstance','acceptedSameBuffer','nativePCMExact','auditionPCMExact','clipPreserved','undoOriginal','redoAccepted','zipPCMExact','zipBlobExact','mixParity','sourceRetained'])expect(r[field],`${r.sr} Hz ${field}`).toBe(true)
    expect(r.nativeDecodeRate).toBe(r.sr);expect(r.nativeDecodeLength).toBe(r.expectedFrames);expect(r.freshHistoryHasUndo).toBe(false)
  }
})

test('generated float WAV native decode retains signed zero, finite headroom and channel layout',async({page})=>{
  await page.goto('/')
  const results=await page.evaluate(async()=>{
    const {encodeGeneratedFloatWav}=await import('/src/js/audio/generated-float-wav.js')
    const {decodeSourceAsset}=await import('/src/js/audio/asset-decode.js')
    const results=[]
    for(const sr of [44100,48000,96000]){
      const left=new Float32Array(128),right=new Float32Array(128)
      left.set([0,-0,1.25,-1.5,.123456789,1e-40]);right.set([-0,0,-.5,.75,-.23456789,-1e-40])
      const bytes=await encodeGeneratedFloatWav([left,right],sr)
      const context=new OfflineAudioContext(2,1,sr===48000?44100:48000)
      const decoded=(await decodeSourceAsset(bytes,context)).buffer
      const exact=[left,right].every((x,c)=>{const a=new Uint32Array(x.buffer),y=decoded.getChannelData(c),b=new Uint32Array(y.buffer,y.byteOffset,y.length);return a.length===b.length&&a.every((v,i)=>v===b[i])})
      results.push({sr,rate:decoded.sampleRate,channels:decoded.numberOfChannels,length:decoded.length,exact})
    }
    return results
  })
  for(const r of results){expect(r.rate).toBe(r.sr);expect(r.channels).toBe(2);expect(r.length).toBe(128);expect(r.exact,`Exact native float decode at ${r.sr} Hz`).toBe(true)}
})
