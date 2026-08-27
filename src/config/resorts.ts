import type { Resort } from '../types/domain';

/**
 * The five initial resorts. Bounding boxes are approximate and used both for the
 * Overpass extraction (pipeline) and the map default view. Madonna di Campiglio is
 * the default fallback when no geolocation is available.
 */
export const RESORTS: Resort[] = [
  {
    id: 'madonna-di-campiglio',
    name: 'Madonna di Campiglio',
    country: 'Italy',
    center: { lon: 10.826, lat: 46.23 },
    bbox: { minLon: 10.72, minLat: 46.16, maxLon: 10.94, maxLat: 46.32 },
    defaultZoom: 12.5,
    timezone: 'Europe/Rome',
    infoUrl: 'https://www.campigliodolomiti.it/en/',
  },
  {
    id: 'cervinia-zermatt',
    name: 'Cervinia\u2013Zermatt',
    country: 'Italy / Switzerland',
    center: { lon: 7.71, lat: 45.958 },
    bbox: { minLon: 7.55, minLat: 45.87, maxLon: 7.82, maxLat: 46.05 },
    defaultZoom: 12,
    timezone: 'Europe/Zurich',
    infoUrl: 'https://www.cervinia.it/en/impianti-e-piste',
  },
  {
    id: 'sella-ronda',
    name: 'Sella Ronda (Canazei)',
    country: 'Italy',
    center: { lon: 11.808, lat: 46.518 },
    // Boundary survey (Overpass, Aug 2026). The old box (minLon 11.68, maxLat 46.58, maxLon 11.94)
    // cut straight through the Dolomiti Superski core, and the tell was the built graph spilling
    // west, north AND east of its own declared box. 32 lifts were missing:
    //   - Alpe di Siusi / Seiser Alm (19): Seiseralmbahn, Puflatsch, Spitzbuehl, Panorama, Bamby,
    //     Florian, Paradiso, Monte Piz, Goldknopf, Sanon, Mezdi ... all north-west of 11.68.
    //   - Ortisei / Seceda / Resciesa (9): Mont Seuc (the Ortisei<->Alpe di Siusi cable car),
    //     Ortisei-Furnes, Furnes-Seceda, Rasciesa funicular, Fermeda, Cisles.
    //   - La Crusc / Santa Croce (4), just past the old east edge.
    // maxLat 46.58 was the meanest cut of all: it sliced 80 m below the Ferata Gran Risa funicular
    // at La Villa (46.58071), which is how you get from the bottom of Gran Risa to the Piz la Ila
    // gondola - so that whole corner read as a trapped basin.
    // Plose falls out naturally past a 3.9 km empty band north of 46.615.
    bbox: { minLon: 11.55, minLat: 46.42, maxLon: 11.955, maxLat: 46.615 },
    // Reaching west to Ortisei also reaches south-west into Carezza / Nova Levante and Tiers am
    // Rosengarten - a separate ski area on a separate ticket, road-linked only - and north-west to
    // the Kastelruth village lifts (Marinzen, Dorflift), which are village drags with no link to
    // the Alpe di Siusi plateau above them. No rectangle separates either from Val Gardena.
    excludeBboxes: [
      { minLon: 11.55, minLat: 46.38, maxLon: 11.63, maxLat: 46.47 },
      { minLon: 11.55, minLat: 46.555, maxLon: 11.585, maxLat: 46.575 },
    ],
    defaultZoom: 12,
    timezone: 'Europe/Rome',
    infoUrl: 'https://www.dolomitisuperski.com/en/',
  },
  {
    id: 'val-thorens-3vallees',
    name: 'Val Thorens \u2013 Les 3 Vall\u00e9es',
    country: 'France',
    center: { lon: 6.58, lat: 45.36 },
    bbox: { minLon: 6.5, minLat: 45.19, maxLon: 6.68, maxLat: 45.44 },
    defaultZoom: 12,
    timezone: 'Europe/Paris',
    infoUrl: 'https://www.valthorens.com/en/',
  },
  {
    id: 'tignes-val-disere',
    name: "Tignes \u2013 Val d'Is\u00e8re (Espace Killy)",
    country: 'France',
    center: { lon: 6.93, lat: 45.46 },
    // East edge surveyed, not guessed. The Pissaillas glacier / Col de l'Iseran sector is entirely
    // beyond the old maxLon 7.02 (pistes Col Pers, Pays Desert, Moraine, Cascade, Roches, Pissaillas,
    // Aiguille Pers, Montet, Tunnel; lifts Signal 1/2, Cema, Pays Desert, Cascade, Montet). Clipped,
    // its lifts still arrived whole — Overpass returns a way in full — so the Leissieres east station
    // and the Vallon de l'Iseran top compiled with NO piste or connector at all, and the entire Le
    // Fornet sector became a 29-node trapped basin. The sector ends at lon 7.067 and the next
    // features start at 7.08, so 7.07 lands in the gap; Bonneval-sur-Arc is south of minLat 45.40.
    bbox: { minLon: 6.83, minLat: 45.4, maxLon: 7.07, maxLat: 45.52 },
    defaultZoom: 12,
    timezone: 'Europe/Paris',
    infoUrl: 'https://www.tignes.net/en/',
  },
  {
    id: 'paradiski',
    name: 'Paradiski (Les Arcs \u2013 La Plagne)',
    country: 'France',
    center: { lon: 6.72, lat: 45.55 },
    // Deliberately tight on three sides, cut from a survey of the boundary strip rather than guessed.
    // North of 45.62 is La Rosiere/Espace San Bernardo (Roches Noires, Manessier, Ecudets), which read
    // as a 222-node trapped basin when the box reached 45.66. East: Villaroger/Aiguille Rouge ends at
    // 6.8683 and Sainte-Foy-Tarentaise begins at 6.8935, so 6.876 lands in the gap — 6.86 sliced the
    // Villaroger sector in half and stranded it, 6.89 swallowed Sainte-Foy and part of Tignes.
    // South stops at 45.44 for Les 3 Vallees; Tignes (from 6.83/45.40) is the one unavoidable overlap.
    bbox: { minLon: 6.58, minLat: 45.44, maxLon: 6.876, maxLat: 45.62 },
    // Tignes' Col du Palet / Grattalu sector sits inside the south-east corner and shares a col with
    // Peisey-Vallandry, so the router can ski in but never out: a 3-lift trapped basin. No rectangle
    // separates it (shrinking the south edge loses Champagny, shrinking the east edge loses
    // Villaroger), so subtract it. Peisey/Vallandry itself is well north of 45.50.
    excludeBboxes: [{ minLon: 6.85, minLat: 45.4, maxLon: 6.9, maxLat: 45.475 }],
    defaultZoom: 11.5,
    timezone: 'Europe/Paris',
    infoUrl: 'https://www.paradiski.com/',
  },
  {
    id: 'st-anton-arlberg',
    name: 'St. Anton am Arlberg',
    country: 'Austria',
    center: { lon: 10.2, lat: 47.16 },
    // Boundary survey (Overpass, Aug 2026). The old box (maxLat 47.21, minLon 10.13) cut
    // straight through the resort: Lech village sits at 47.208 and Oberlech at 47.216, so
    // Kriegerhorn, Petersboden, Schlosskopf, Hasensprung, Steinmähder, Rotschrofen and
    // Weibermahd were all clipped, and with them the ski-out that makes the Schafalp /
    // Langer Zug sector reachable. Ski Arlberg is one lift pass and one lift-linked area:
    // Lech/Zürs joins Warth-Schröcken over the Auenfeldjet gondola (47.2362).
    //   north: dense to 47.270, then ~4.8 km empty until 47.315 = Kleinwalsertal /
    //          Diedamskopf, a different resort. -> maxLat 47.28.
    //   west:  dense to 10.085 (Schröcken / Nesslegg), nothing beyond in this band. -> 10.08.
    //   east:  clean gap 10.195 -> 10.335; the 10.335+ ways are Lechtal (Gföllberg,
    //          Jöchelspitze). -> maxLon stays 10.33.
    bbox: { minLon: 10.08, minLat: 47.09, maxLon: 10.33, maxLat: 47.28 },
    // Widening west to reach Schröcken also reaches down into the Klostertal, where
    // Sonnenkopf/Klösterle (Riedkopf, Sonnenkopfbahn, Obermuri, Glattingrat) and the
    // Fuchslochlift are a separate resort on a separate ticket, road-linked only.
    // A rectangle can't separate them from Lech, so cut them out explicitly.
    excludeBboxes: [{ minLon: 10.03, minLat: 47.085, maxLon: 10.1, maxLat: 47.16 }],
    defaultZoom: 11.5,
    timezone: 'Europe/Vienna',
    infoUrl: 'https://www.stantonamarlberg.com/en/',
  },
  {
    id: 'mount-hermon',
    name: 'Mount Hermon',
    country: 'Israel',
    center: { lon: 35.785, lat: 33.302 },
    bbox: { minLon: 35.75, minLat: 33.28, maxLon: 35.81, maxLat: 33.32 },
    defaultZoom: 13.5,
    timezone: 'Asia/Jerusalem',
    infoUrl: 'https://www.skihermon.co.il/',
  },
  {
    id: 'gudauri',
    name: 'Gudauri',
    country: 'Georgia',
    center: { lon: 44.49, lat: 42.485 },
    bbox: { minLon: 44.42, minLat: 42.43, maxLon: 44.51, maxLat: 42.53 },
    defaultZoom: 12.5,
    timezone: 'Asia/Tbilisi',
    infoUrl: 'https://gudauri.com/',
  },
  {
    id: 'mayrhofen',
    name: 'Mayrhofen',
    country: 'Austria',
    center: { lon: 11.81, lat: 47.16 },
    // minLon was 11.72, which sliced through the Eggalm sector (Tux side): the Eggalm Nord chair
    // arrived whole — Overpass returns a way in full when any node touches the bbox — with its top
    // station at lon 11.7036, but the pistes it feeds were never fetched, so it sat there with no
    // ski-out and trapped a 10-node basin. Boundary survey (Overpass, 47.13–47.21 / 11.58–11.73):
    // the Eggalm lifts span 11.7010 (Beilspitzlift bottom) .. 11.7285 (Eggalmbahn) and downhill
    // pistes bottom out at 11.70, then there is a ~4 km empty gap before Klammjochlift (11.6362)
    // and Mölstallift (11.6386) on the Rastkogel/Hintertux side. 11.695 therefore takes Eggalm
    // whole and stops well short of the next ski area.
    bbox: { minLon: 11.695, minLat: 47.12, maxLon: 11.9, maxLat: 47.205 },
    defaultZoom: 11.5,
    timezone: 'Europe/Vienna',
    infoUrl: 'https://www.mayrhofner-bergbahnen.com/en/',
  },
  {
    id: 'soelden',
    name: 'S\u00f6lden',
    country: 'Austria',
    center: { lon: 10.96, lat: 46.95 },
    bbox: { minLon: 10.912, minLat: 46.9, maxLon: 11.02, maxLat: 46.99 },
    defaultZoom: 12,
    timezone: 'Europe/Vienna',
    infoUrl: 'https://www.soelden.com/en/',
  },
  {
    id: 'ischgl-samnaun',
    name: 'Ischgl \u2013 Samnaun (Silvretta Arena)',
    country: 'Austria / Switzerland',
    center: { lon: 10.34, lat: 46.97 },
    bbox: { minLon: 10.27, minLat: 46.91, maxLon: 10.42, maxLat: 47.03 },
    defaultZoom: 12,
    timezone: 'Europe/Vienna',
    infoUrl: 'https://www.ischgl.com/en/',
  },
  {
    id: 'alpe-dhuez',
    name: "Alpe d'Huez",
    country: 'France',
    center: { lon: 6.08, lat: 45.1 },
    bbox: { minLon: 6.03, minLat: 45.04, maxLon: 6.14, maxLat: 45.17 },
    defaultZoom: 11.5,
    timezone: 'Europe/Paris',
    infoUrl: 'https://www.alpedhuez.com/en/',
  },
  {
    id: 'les-deux-alpes',
    name: 'Les 2 Alpes',
    country: 'France',
    center: { lon: 6.16, lat: 45.0 },
    bbox: { minLon: 6.09, minLat: 44.96, maxLon: 6.23, maxLat: 45.04 },
    defaultZoom: 12,
    timezone: 'Europe/Paris',
    infoUrl: 'https://www.les2alpes.com/en/',
  },
  {
    id: 'monterosa-ski',
    name: 'Monterosa Ski',
    country: 'Italy',
    // Three lift-linked valleys: Champoluc (Ayas) in the west, Gressoney-La-Trinite in the
    // middle, Alagna Valsesia in the east. The bbox is drawn tight around the lift-linked
    // network (which spans lon 7.731-7.936, lat 45.829-45.891) on purpose: Antagnod/Brusson
    // to the west and the small valley lifts to the south share the Monterosa lift pass but
    // have no lift link to it, so a looser box imports terrain a skier can never reach.
    center: { lon: 7.83, lat: 45.845 },
    bbox: { minLon: 7.72, minLat: 45.822, maxLon: 7.95, maxLat: 45.895 },
    defaultZoom: 12,
    timezone: 'Europe/Rome',
    infoUrl: 'https://www.visitmonterosa.com/en/',
  },
];

/** Fallback resort when geolocation is unavailable. */
export const DEFAULT_RESORT_ID = 'madonna-di-campiglio';

export function getResort(id: string): Resort | undefined {
  return RESORTS.find((r) => r.id === id);
}
