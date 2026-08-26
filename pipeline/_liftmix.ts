import fs from 'node:fs';
const idx = JSON.parse(fs.readFileSync('public/resorts/index.json','utf8'));
const ids = idx.map((r:any)=>r.id ?? r);
const rows:any[]=[];
for(const id of ids){
  const g = JSON.parse(fs.readFileSync(`public/resorts/${id}/graph.json`,'utf8'));
  const c=new Map<string,number>();
  for(const e of g.edges){
    if(e.kind!=='lift'||e.isDownload) continue;
    const t=e.liftType??'unknown'; c.set(t,(c.get(t)??0)+1);
  }
  rows.push({id, cable:c.get('cable_car')??0, gond:c.get('gondola')??0, chair:c.get('chair_lift')??0,
    surface:(c.get('t_bar')??0)+(c.get('drag_lift')??0)+(c.get('platter')??0)+(c.get('rope_tow')??0)+(c.get('magic_carpet')??0),
    fun:c.get('funicular')??0, mixed:c.get('mixed_lift')??0,
    total:[...c.values()].reduce((a,b)=>a+b,0)});
}
rows.sort((a,b)=>b.total-a.total);
console.log('resort                    cable  gondola  chair  surface  funic  mixed  total');
for(const r of rows) console.log(r.id.padEnd(24), String(r.cable).padStart(5), String(r.gond).padStart(8), String(r.chair).padStart(6), String(r.surface).padStart(8), String(r.fun).padStart(6), String(r.mixed).padStart(6), String(r.total).padStart(6));
const s=(k:string)=>rows.reduce((a,r)=>a+r[k],0);
console.log('TOTAL'.padEnd(24), String(s('cable')).padStart(5), String(s('gond')).padStart(8), String(s('chair')).padStart(6), String(s('surface')).padStart(8), String(s('fun')).padStart(6), String(s('mixed')).padStart(6), String(s('total')).padStart(6));
