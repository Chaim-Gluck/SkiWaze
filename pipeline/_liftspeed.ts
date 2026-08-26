import fs from 'node:fs';
import { parseDurationSec } from './lib/normalize';
import { DEFAULT_SPEEDS } from '../src/config/defaults';
const R=6371000, rad=(d:number)=>d*Math.PI/180;
function hav(a:any,b:any){const dLat=rad(b.lat-a.lat),dLon=rad(b.lon-a.lon);
 const s=Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLon/2)**2;
 return 2*R*Math.asin(Math.sqrt(s));}
const byType=new Map<string,number[]>();
for (const f of fs.readdirSync('pipeline/.cache').filter(f=>f.startsWith('overpass-'))){
  const j=JSON.parse(fs.readFileSync('pipeline/.cache/'+f,'utf8'));
  const els=Array.isArray(j.data)?j.data:(j.data?.elements||j.elements||[]);
  for(const e of els){
    const t=e.tags?.aerialway; if(!t||!e.geometry||e.geometry.length<2) continue;
    const sec=parseDurationSec(e.tags['aerialway:duration']); if(!sec||sec<=0) continue;
    let len=0; for(let i=1;i<e.geometry.length;i++) len+=hav(e.geometry[i-1],e.geometry[i]);
    if(len<100) continue;
    if(!byType.has(t)) byType.set(t,[]);
    byType.get(t)!.push(len/sec);
  }
}
console.log('type              n   median      p25    p75   |  current');
// Read the live defaults rather than a copy: a hardcoded "current" column silently goes stale the
// moment someone tunes DEFAULT_SPEEDS, and then this probe quietly lies about what needs changing.
// OSM spells two of the types with a hyphen where our LiftType uses an underscore.
const OSM_TO_LIFT_TYPE: Record<string, string> = { 't-bar': 't_bar', 'j-bar': 't_bar' };
const current = (osmType: string): string => {
  const key = (OSM_TO_LIFT_TYPE[osmType] ?? osmType) as keyof typeof DEFAULT_SPEEDS.liftSpeedByType;
  return String(DEFAULT_SPEEDS.liftSpeedByType[key] ?? '-');
};
for(const [t,v] of [...byType].sort((a,b)=>b[1].length-a[1].length)){
  if(v.length<4) continue;
  const s=[...v].sort((a,b)=>a-b); const m=s[Math.floor(s.length/2)];
  console.log(t.padEnd(16), String(v.length).padStart(3),
    `${m.toFixed(2)} m/s ${(m*3.6).toFixed(1)} km/h`.padStart(20),
    s[Math.floor(s.length*0.25)].toFixed(2).padStart(6), s[Math.floor(s.length*0.75)].toFixed(2).padStart(6),
    '  | ', current(t));
}
