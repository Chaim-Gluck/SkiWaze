import { useState } from 'react';

interface Row {
  label: string;
  swatch: 'green' | 'blue' | 'red' | 'black' | 'lift' | 'connector' | 'synthetic' | 'custom' | 'route';
}

const ROWS: Row[] = [
  { label: 'Easy / Intermediate / Hard piste', swatch: 'blue' },
  { label: 'Lift (up; gondolas also down)', swatch: 'lift' },
  { label: 'Flat link / cat-track (real)', swatch: 'connector' },
  { label: 'App-added bridge (verify)', swatch: 'synthetic' },
  { label: 'Your custom link', swatch: 'custom' },
  { label: 'Selected route (glows)', swatch: 'route' },
];

export function Legend() {
  const [open, setOpen] = useState(true);
  return (
    <div className={`legend ${open ? 'open' : ''}`}>
      <button type="button" className="legend-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? '\u2715 Legend' : 'Legend'}
      </button>
      {open && (
        <ul>
          <li>
            <span className="lg piste-multi" /> Piste: blue / red / black
          </li>
          {ROWS.slice(1).map((r) => (
            <li key={r.swatch}>
              <span className={`lg ${r.swatch}`} /> {r.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
