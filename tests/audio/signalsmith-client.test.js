// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createSignalsmithPitchClient } from '../../src/js/pitch/signalsmith-client.js'
import { createSignalsmithWorkerHandler } from '../../src/js/pitch/signalsmith-worker.js'
import { renderSignalsmithPitch } from '../../src/js/pitch/signalsmith-render.js'
import { tone } from './pitch-shift-fixtures.js'
class ManualWorker {
  terminated = false
  messages = []
  postMessage(message, transfer) { this.messages.push(structuredClone(message, { transfer })) }
  terminate() { this.terminated = true }
  deliver(data) { this.onmessage?.({ data }) }
}
const clients=[]
const setup = (options = {}) => {
  const workers=[]
  const client=createSignalsmithPitchClient({ workerFactory:()=>{const worker=new ManualWorker();workers.push(worker);return worker},...options })
  clients.push(client);return {client,workers}
}
afterEach(()=>{clients.splice(0).forEach(x=>x.dispose());vi.useRealTimers()})
async function success(worker) {
  const m=worker.messages[0]
  const result=await renderSignalsmithPitch(m.channels,m.sampleRate,{...m.options,yieldControl:async()=>{}})
  worker.deliver({type:'result',id:m.id,result})
}

describe('Signalsmith worker client ownership and lifecycle',()=>{
  it('copies PCM before transfer and returns source identity; terminates after success',async()=>{
    const {client,workers}=setup(),x=tone(48000,.2),before=x.slice()
    const pending=client.render([x],48000,{semitones:1,sourceToken:'asset-a:revision-4'})
    expect(x.buffer.byteLength).toBe(before.byteLength)
    expect(x).toEqual(before)
    const transferred=workers[0].messages[0].channels[0]
    expect(transferred).not.toBe(x)
    await success(workers[0]);const r=await pending
    expect(r.sourceToken).toBe('asset-a:revision-4')
    expect(r.requestId).toBe(1)
    expect(workers[0].terminated).toBe(true)
    expect(x).toEqual(before)
  })
  it('newest valid request wins, ignores old messages and disposes old WASM worker',async()=>{
    const {client,workers}=setup(),x=tone(48000,.2)
    const a=client.render([x],48000,{semitones:1});const rejection=expect(a).rejects.toMatchObject({name:'AbortError'})
    const b=client.render([x],48000,{semitones:2});await rejection
    expect(workers[0].terminated).toBe(true)
    workers[0].deliver({type:'error',id:1,error:{message:'stale'}})
    await success(workers[1]);expect((await b).metadata.semitones).toBe(2)
  })
  it('invalid replacement leaves the current render running',async()=>{
    const {client,workers}=setup(),x=tone(48000,.2)
    const a=client.render([x],48000,{semitones:1})
    await expect(client.render([x],48000,{semitones:30})).rejects.toThrow()
    expect(workers[0].terminated).toBe(false);await success(workers[0]);await a
  })
  it('abort/cancel rejects immediately and ignores late result',async()=>{
    const {client,workers}=setup(),signal=new AbortController(),x=tone(48000,.2)
    const a=client.render([x],48000,{signal:signal.signal})
    signal.abort();await expect(a).rejects.toMatchObject({name:'AbortError'})
    expect(workers[0].terminated).toBe(true)
    await success(workers[0])
    const b=client.render([x],48000);client.cancel();await expect(b).rejects.toMatchObject({name:'AbortError'})
    expect(workers[1].terminated).toBe(true)
  })
  it('handles preabort without creating a worker',async()=>{
    const {client,workers}=setup(),c=new AbortController();c.abort()
    await expect(client.render([new Float32Array(0)],48000,{signal:c.signal})).rejects.toMatchObject({name:'AbortError'})
    expect(workers).toHaveLength(0)
  })
  it('rejects malformed signals before replacing active work or scheduling timers',async()=>{
    const {client,workers}=setup(),x=tone(48000,.2),pending=client.render([x],48000)
    for(const signal of [{},new AbortController(),{aborted:false,addEventListener(){}}]) await expect(client.render([x],48000,{signal})).rejects.toThrow('AbortSignal')
    expect(workers).toHaveLength(1);expect(workers[0].terminated).toBe(false)
    await success(workers[0]);await pending
    const throwing={aborted:false,addEventListener(){throw Error('attach failed')},removeEventListener(){throw Error('cleanup failed')}}
    await expect(client.render([x],48000,{signal:throwing})).rejects.toThrow('attach failed')
  })
  it('times out and discards its worker',async()=>{
    vi.useFakeTimers();const {client,workers}=setup({timeoutMs:10})
    const a=client.render([tone(48000,.2)],48000),rejection=expect(a).rejects.toMatchObject({name:'TimeoutError'})
    await vi.advanceTimersByTimeAsync(11);await rejection;expect(workers[0].terminated).toBe(true)
  })
  it('rejects malformed metadata instead of installing wrong audio/settings',async()=>{
    const {client,workers}=setup(),a=client.render([tone(48000,.2)],48000)
    workers[0].deliver({type:'result',id:1,result:{sampleRate:48000,channels:[new Float32Array(9600)],metadata:{}}})
    await expect(a).rejects.toThrow('metadata');expect(workers[0].terminated).toBe(true)
  })
  it.each(['onerror','onmessageerror'])('handles %s without leaving an active job',async event=>{
    const {client,workers}=setup(),a=client.render([tone(48000,.2)],48000)
    workers[0][event]({message:'failure',preventDefault(){}})
    await expect(a).rejects.toThrow();expect(workers[0].terminated).toBe(true)
  })
  it('validates progress ordering and tolerates observer exceptions',async()=>{
    const {client,workers}=setup(),a=client.render([tone(48000,.2)],48000,{onProgress:()=>{throw Error('observer')}})
    workers[0].deliver({type:'progress',id:1,progress:.4});workers[0].deliver({type:'progress',id:1,progress:.3})
    await expect(a).rejects.toThrow('progress')
  })
  it('dispose cancels and makes future requests explicit errors',async()=>{
    const {client,workers}=setup(),a=client.render([tone(48000,.2)],48000)
    client.dispose();await expect(a).rejects.toMatchObject({name:'AbortError'});expect(workers[0].terminated).toBe(true)
    await expect(client.render([tone(48000,.2)],48000)).rejects.toThrow('disposed')
  })
  it('rejects factory and postMessage errors without hanging',async()=>{
    for(const workerFactory of [()=>{throw new Error('factory')},()=>({terminate(){},postMessage(){throw new Error('send')}})]){
      const {client}=setup({workerFactory});await expect(client.render([tone(48000,.2)],48000)).rejects.toThrow()
    }
  })
})

describe('Signalsmith real worker handler',()=>{
  it('returns owned transferable PCM and deterministic shared core output',async()=>{
    const messages=[],handler=createSignalsmithWorkerHandler((data,transfer)=>messages.push({data,transfer}))
    const channels=[tone(48000,.2)],options={semitones:2}
    await handler({data:{type:'render',id:1,channels,sampleRate:48000,options}})
    const result=messages.find(x=>x.data.type==='result')
    expect(result).toBeDefined();expect(result.transfer).toEqual(result.data.result.channels.map(x=>x.buffer))
    const direct=await renderSignalsmithPitch(channels,48000,{...options,yieldControl:async()=>{}})
    expect(result.data.result.channels[0]).toEqual(direct.channels[0])
  })
  it('newer requests suppress stale output; active cancel reports AbortError',async()=>{
    const messages=[],handler=createSignalsmithWorkerHandler(data=>messages.push(data))
    const a=handler({data:{type:'render',id:1,channels:[tone(48000,1)],sampleRate:48000,options:{semitones:2}}})
    const b=handler({data:{type:'render',id:2,channels:[tone(48000,.2)],sampleRate:48000,options:{semitones:-2}}})
    await Promise.all([a,b]);expect(messages.filter(x=>x.type==='result').map(x=>x.id)).toEqual([2])
    const c=handler({data:{type:'render',id:3,channels:[tone(48000,1)],sampleRate:48000,options:{semitones:2}}})
    await handler({data:{type:'cancel',id:3}});await c
    expect(messages.find(x=>x.type==='error'&&x.id===3).error.name).toBe('AbortError')
  })
})
