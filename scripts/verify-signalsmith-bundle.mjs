// Build-only worker/ESM smoke test. Does not start a server/browser or publish.
import { build } from 'vite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const result=await build({configFile:false,publicDir:false,logLevel:'error',build:{write:false,minify:true,rollupOptions:{input:fileURLToPath(new URL('../src/js/pitch/signalsmith-client.js',import.meta.url)),preserveEntrySignatures:'strict'}},worker:{format:'es'}})
const chunks=result.output
const worker=chunks.find(x=>x.type==='asset'&&x.fileName.includes('signalsmith-worker'))
if(!worker)throw Error('Bundled module worker missing')
if(chunks.some(x=>x.fileName.includes('upstream')))throw Error('Unmodified upstream reference should not ship as a second runtime')
const license=readFileSync(new URL('../public/licenses/signalsmith-stretch.txt',import.meta.url),'utf8')
if(!license.includes('MIT License')||!license.includes('2022 Geraint Luff')||!license.includes('2025 Signalsmith Audio'))throw Error('Public third-party license artifact missing')
console.log(JSON.stringify({status:'bundle-only-pass',browserExecution:'not performed',publicNotice:'/licenses/signalsmith-stretch.txt',artifacts:chunks.map(x=>({name:x.fileName,bytes:Buffer.byteLength(x.type==='chunk'?x.code:x.source)}))},null,2))
