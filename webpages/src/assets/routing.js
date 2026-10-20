import { MIRROR_TEMPLATES } from './release.js';

/** Opaque responses and timeouts cannot prove a route healthy. */
export function rankBySpeed(results) {
  return results.filter(hit => !hit.unprobed && !hit.failed).slice().sort((x, y) => {
    const ax = x.ms > 0 ? x.ms : Number.POSITIVE_INFINITY;
    const ay = y.ms > 0 ? y.ms : Number.POSITIVE_INFINITY;
    return ax - ay;
  });
}

export function selectRoute(mode, current, results) {
  const pool = MIRROR_TEMPLATES.filter(route => mode === 'auto' || route.kind === mode);
  const best = rankBySpeed(results.filter(hit => pool.some(route => route.id === hit.id)))[0];
  // Manual selection fixes the source category; nodes within mirrors still route automatically.
  const candidates = pool.filter(route => !results.some(hit => hit.id === route.id && hit.failed));
  return pool.find(route => route.id === best?.id)
    || candidates.find(route => route.id === current?.id)
    || candidates[0]
    || pool[0];
}
