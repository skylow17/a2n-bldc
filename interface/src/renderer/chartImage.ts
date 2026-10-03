/**
 * Image PNG d'une pile de graphes, telle qu'elle est affichée — zoom compris.
 *
 * uPlot dessine sur un canvas par graphe ; on les recopie l'un sous l'autre dans un canvas
 * hors écran, précédés d'un en-tête (titre, horodatage) et d'une légende. La légende de
 * uPlot est du HTML et ne passerait pas dans l'image : elle est redessinée ici, pastille et
 * nom, pour que l'image se lise seule dans un compte rendu.
 */

import { resolveColor } from './components/Chart.js';

function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v === '' ? fallback : v;
}

export function composeChartsPng(
  container: HTMLElement,
  title: string,
  subtitle: string,
  legend: Array<{ name: string; color: string; dash: boolean }>,
): string {
  const canvases = [...container.querySelectorAll('canvas')].filter((c) => c.width > 0 && c.height > 0);
  if (canvases.length === 0) throw new Error('nothing to export: no chart is drawn');
  const dpr = window.devicePixelRatio || 1;
  const pad = Math.round(12 * dpr);
  const headH = Math.round(44 * dpr);
  const legendH = Math.round(20 * dpr);
  const width = Math.max(...canvases.map((c) => c.width)) + pad * 2;
  const height = headH + legendH + canvases.reduce((s, c) => s + c.height + pad, 0) + pad;

  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const g = out.getContext('2d');
  if (g === null) throw new Error('canvas unavailable');

  g.fillStyle = token('--color-panel', '#14181e');
  g.fillRect(0, 0, width, height);
  g.fillStyle = token('--color-fg', '#e6eaf0');
  g.font = `600 ${Math.round(14 * dpr)}px Barlow, sans-serif`;
  g.fillText(title, pad, pad + Math.round(14 * dpr));
  g.fillStyle = token('--color-fg-3', '#636d7b');
  g.font = `${Math.round(11 * dpr)}px "IBM Plex Mono", monospace`;
  g.fillText(subtitle, pad, pad + Math.round(32 * dpr));

  let x = pad;
  const ly = headH + Math.round(10 * dpr);
  for (const l of legend) {
    g.strokeStyle = resolveColor(l.color);
    g.lineWidth = 2 * dpr;
    g.setLineDash(l.dash ? [5 * dpr, 3 * dpr] : []);
    g.beginPath();
    g.moveTo(x, ly);
    g.lineTo(x + 16 * dpr, ly);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = token('--color-fg-2', '#96a0af');
    g.fillText(l.name, x + 22 * dpr, ly + 4 * dpr);
    x += 22 * dpr + g.measureText(l.name).width + 18 * dpr;
  }

  let y = headH + legendH;
  for (const c of canvases) {
    g.drawImage(c, pad, y);
    y += c.height + pad;
  }
  return out.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}
