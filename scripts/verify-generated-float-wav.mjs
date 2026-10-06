// Independent parser/decoder check with installed ffmpeg only; no downloads.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { encodeGeneratedFloatWav } from '../src/js/audio/generated-float-wav.js'
const folder=mkdtempSync(join(tmpdir(),'waveforge-float-wav-'))
const channels=[new Float32Array([0,-0,1.25,-1.5,.123456789,1e-40]),new Float32Array([-0,0,-.5,.75,-.23456789,-1e-40])]
const results=[]
try{
  for(const sampleRate of [44100,48000,96000]){
    const bytes=await encodeGeneratedFloatWav(channels,sampleRate,{yieldControl:async()=>{}})
    const path=join(folder,`${sampleRate}.wav`);writeFileSync(path,new Uint8Array(bytes))
    const probe=spawnSync('ffprobe',['-v','error','-show_entries','stream=codec_name,sample_fmt,sample_rate,channels,duration_ts','-of','json',path],{encoding:'utf8'})
    if(probe.status!==0)throw Error(probe.stderr||String(probe.error))
    const decode=spawnSync('ffmpeg',['-v','error','-i',path,'-f','f32le','-acodec','pcm_f32le','pipe:1'])
    if(decode.status!==0)throw Error(decode.stderr?.toString()||String(decode.error))
    const floatPayloadBitExact=decode.stdout.equals(Buffer.from(bytes,58))
    if(!floatPayloadBitExact)throw Error('Float bytes changed in ffmpeg round-trip')
    results.push({sampleRate,...JSON.parse(probe.stdout),floatPayloadBitExact})
  }
  const version=spawnSync('ffmpeg',['-version'],{encoding:'utf8'}).stdout?.split('\n')[0]
  console.log(JSON.stringify({environment:'Installed ffmpeg/ffprobe; local files only',version,browserVerification:'pending',results},null,2))
}finally{rmSync(folder,{recursive:true,force:true})}
