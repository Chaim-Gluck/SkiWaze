import type { ResortGraph } from '../../src/types/domain';

/**
 * Drop disconnected fragments that carry no usable terrain.
 *
 * A weakly-connected component that is not the main body, holds no lift, and holds no *rated*
 * piste is inert: there is no way to ski to it, no way to ski out of it, and nothing inside it
 * worth reaching. It exists only as noise in `check:trapped` / `check:resort`, where each stub
 * spends one line of a human's attention every review round forever.
 *
 * Two guards make this safe, and both are load-bearing:
 *
 *  - **A rated piste is never dropped.** Green/blue/red/black means a mapper asserted this is a
 *    marked run, so a disconnected one is a *defect to fix* (a missing junction, a clipped bbox),
 *    not litter to sweep up — deleting it would hide the very thing the audit exists to surface.
 *    This mirrors `removePistes`' bbox rule, which likewise only ever removes unrated edges.
 *    It is what spares the fleet's genuinely disconnected black runs: St. Anton's Hochkar (5.8 km)
 *    and Kuhtäli (6.7 km), Sella Ronda's Joel Couloir and Canale Berger, Tignes' Balme couloirs.
 *  - **A lift is never dropped.** A fragment with a lift is a satellite area you could ski if you
 *    got to it (typically reached by ski bus), which is a sign-off question for a human — see
 *    `acceptedBasins`. Monterosa's Antagnod is the precedent.
 *
 * `MAX_LEN_M` is a backstop rather than the real filter: the two guards above already do the
 * work, and every fragment this catches fleet-wide is under 250 m. The cap is there so that a
 * genuinely *large* unrated fragment appearing in some future resort still reaches a human
 * instead of vanishing silently.
 *
 * Fleet census when this was written: 14 lift-free disconnected fragments, of which this drops 6
 * — five pure-connector components (app-invented plumbing floating free of any piste, so it links
 * nothing by construction) and Portes du Soleil's 34 m unrated stub above Avoriaz.
 */
const MAX_LEN_M = 500;

const RATED = new Set(['green', 'blue', 'red', 'black']);

export function dropInertFragments(
  graph: ResortGraph,
): { graph: ResortGraph; dropped: { nodes: number; lengthM: number; label: string }[] } {
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
    (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push(e.from);
  }

  const seen = new Set<string>();
  const components: string[][] = [];
  for (const n of graph.nodes) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    const stack = [n.id];
    const comp: string[] = [];
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const next of adj.get(cur) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    components.push(comp);
  }
  if (components.length < 2) return { graph, dropped: [] };

  const biggest = components.reduce((a, b) => (b.length > a.length ? b : a));
  const kindById = new Map(graph.nodes.map((n) => [n.id, n.kind]));

  const doomed = new Set<string>();
  const dropped: { nodes: number; lengthM: number; label: string }[] = [];
  for (const comp of components) {
    if (comp === biggest) continue;
    const ids = new Set(comp);
    if (comp.some((id) => kindById.get(id) === 'lift_station')) continue;
    const edges = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    if (edges.some((e) => e.kind === 'lift')) continue;
    if (edges.some((e) => e.color != null && RATED.has(e.color))) continue;
    const lengthM = edges.reduce((a, e) => a + e.lengthM, 0);
    if (lengthM > MAX_LEN_M) continue;
    for (const id of comp) doomed.add(id);
    const named = edges.find((e) => e.pisteName)?.pisteName ?? graph.points?.find((p) => ids.has(p.nodeId))?.name;
    dropped.push({ nodes: comp.length, lengthM: Math.round(lengthM), label: named ?? comp[0] });
  }
  if (!doomed.size) return { graph, dropped: [] };

  return {
    graph: {
      ...graph,
      nodes: graph.nodes.filter((n) => !doomed.has(n.id)),
      edges: graph.edges.filter((e) => !doomed.has(e.from) && !doomed.has(e.to)),
      points: (graph.points ?? []).filter((p) => !doomed.has(p.nodeId)),
    },
    dropped,
  };
}
