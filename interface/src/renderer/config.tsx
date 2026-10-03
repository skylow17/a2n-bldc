/**
 * Configuration de l'interface dans le renderer.
 *
 * Le processus principal en est la seule source (`config.json` du dossier de données),
 * comme pour l'état du device : on la lit au montage et on suit `config:changed`, diffusé à
 * **toutes** les fenêtres — un réglage changé dans la vue Control détachée s'applique à la
 * principale. Un seul abonnement par fenêtre, partagé par contexte.
 *
 * Le fournisseur applique aussi ce qui touche la fenêtre entière : le thème (un attribut sur
 * la racine, voir `styles.css`), le zoom, et l'opacité de la sélection de zoom des graphes.
 */

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

import { DEFAULT_CONFIG, type AppConfig, type ConfigPatch } from '../shared/config.js';
import { api } from './useDevice.js';

interface ConfigCtx {
  config: AppConfig;
  /** Vrai une fois la config du fichier reçue : avant, ce sont les défauts. */
  loaded: boolean;
  update: (patch: ConfigPatch) => void;
}

const Ctx = createContext<ConfigCtx>({ config: DEFAULT_CONFIG, loaded: false, update: () => undefined });

/**
 * Reprise, une seule fois, des réglages que l'interface rangeait en `localStorage` avant le
 * fichier de configuration. Sans elle, le premier lancement oublierait le thème choisi.
 */
const MIGRATED_KEY = 'a2n.config.migrated';
function legacyPatch(): ConfigPatch | null {
  try {
    if (localStorage.getItem(MIGRATED_KEY) !== null) return null;
    localStorage.setItem(MIGRATED_KEY, '1');
    const patch: ConfigPatch = {};
    if (localStorage.getItem('a2n.theme') === 'light') patch.ui = { theme: 'light' };
    const h = Number(localStorage.getItem('a2n.console.height'));
    if (Number.isFinite(h) && h > 0) patch.layout = { consoleH: Math.round(h) };
    return Object.keys(patch).length === 0 ? null : patch;
  } catch {
    return null;
  }
}

export function ConfigProvider({ children }: { children: ReactNode }): ReactNode {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void api()
      .getConfig()
      .then((c) => {
        if (!alive) return;
        setConfig(c);
        setLoaded(true);
        const legacy = legacyPatch();
        if (legacy !== null) void api().setConfig(legacy).catch(() => undefined);
      })
      .catch(() => setLoaded(true));
    const off = api().onConfig(setConfig);
    return () => {
      alive = false;
      off();
    };
  }, []);

  // Le sombre est la valeur de base des variables : pas d'attribut pour lui.
  useEffect(() => {
    if (config.ui.theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
  }, [config.ui.theme]);

  useEffect(() => {
    api().setZoom(config.ui.zoom);
  }, [config.ui.zoom]);

  useEffect(() => {
    document.documentElement.style.setProperty('--select-opacity', String(config.plots.selectionOpacity));
  }, [config.plots.selectionOpacity]);

  const update = useCallback((patch: ConfigPatch) => {
    // Optimiste : l'interface réagit tout de suite, la diffusion du main fait foi ensuite.
    setConfig((c) => {
      const next = { ...c } as Record<string, unknown>;
      for (const [k, v] of Object.entries(patch)) {
        next[k] = { ...(c as unknown as Record<string, Record<string, unknown>>)[k], ...(v as object) };
      }
      return next as unknown as AppConfig;
    });
    void api().setConfig(patch).catch(() => undefined);
  }, []);

  return <Ctx.Provider value={{ config, loaded, update }}>{children}</Ctx.Provider>;
}

export function useConfig(): ConfigCtx {
  return useContext(Ctx);
}
