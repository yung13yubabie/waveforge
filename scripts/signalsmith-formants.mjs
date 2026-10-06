// Independent pitch/formant control observations on a synthetic harmonic source.
// Spectral envelope peaks are descriptive, not human-vocal formant gold.
import { renderSignalsmithPitch } from '../src/js/pitch/signalsmith-render.js'
import { fft, nextPow2 } from '../src/js/audio/fft.js'
import { periodicFrequency, centsError, peak } from '../tests/audio/pitch-shift-fixtures.js'
const sr=48000,baseHz=100
const harmonics=Array.from({length:70},(_,i)=>{const frequency=(i+1)*baseHz;return {frequency,amplitude:[[700,130,1],[1400,180,.7],[2800,250,.4]].reduce((sum,[center,width,gain])=>sum+gain*Math.exp(-.5*((frequency-center)/width)**2),0)}})
const input=Float32Array.from({length:sr*2},(_,i)=>harmonics.reduce((sum,h)=>sum+h.amplitude*Math.sin(2*Math.PI*h.frequency*i/sr),0))
const inputPeak=peak(input);for(let i=0;i<input.length;i++)input[i]*=.5/inputPeak
function envelopePeaks(x){
  const size=nextPow2(sr*.7),re=new Float64Array(size),im=new Float64Array(size),first=Math.floor((x.length-size)/2)
  for(let i=0;i<size;i++)re[i]=x[first+i]*(.5-.5*Math.cos(2*Math.PI*i/size));fft(re,im)
  const magnitude=Array.from({length:size/2},(_,i)=>Math.hypot(re[i],im[i]))
  const smoothed=(frequency)=>{let total=0;for(let b=Math.max(0,Math.floor((frequency-180)*size/sr));b<=Math.min(magnitude.length-1,Math.ceil((frequency+180)*size/sr));b++)total+=magnitude[b]*Math.exp(-.5*((b*sr/size-frequency)/60)**2);return total}
  return [[450,950],[1050,1750],[2200,3400]].map(([low,high])=>{let frequency=low,value=-1;for(let hz=low;hz<=high;hz+=2){const v=smoothed(hz);if(v>value){value=v;frequency=hz}}return frequency})
}
const inputFormants=envelopePeaks(input)
const cases=[{semitones:0,formantSemitones:0},{semitones:0,formantSemitones:-2},{semitones:0,formantSemitones:2},{semitones:2,formantSemitones:0},{semitones:2,formantSemitones:0,formantCompensation:true},{semitones:-2,formantSemitones:0,formantCompensation:true},{semitones:2,formantSemitones:-2,formantCompensation:true}]
const results=[]
for(const options of cases){const result=await renderSignalsmithPitch([input],sr,{...options,formantBaseHz:baseHz,yieldControl:async()=>{}}),output=result.channels[0],frequency=periodicFrequency(output,sr,1,baseHz*2**(options.semitones/12)).frequency,formants=envelopePeaks(output);results.push({options,samples:output.length,measuredHz:frequency,pitchErrorCents:centsError(frequency,baseHz*2**(options.semitones/12)),envelopePeaksHz:formants,formantShiftCents:formants.map((f,i)=>centsError(f,inputFormants[i])),outputPeak:peak(output)})}
console.log(JSON.stringify({source:'Generated 100 Hz harmonic source with Gaussian amplitude-envelope centers at700/1400/2800Hz',measurement:'Hann FFT and60Hz Gaussian smoothing; nearest maxima in bounded broad bands. Not real-vocal formant gold or perceptual acceptance.',inputFormants,results},null,2))
