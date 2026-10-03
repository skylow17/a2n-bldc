/**
 * Thème de l'interface.
 *
 * La bascule pose un attribut sur la racine, et rien d'autre : toutes les couleurs sont des
 * variables CSS redéfinies sous `:root[data-theme='light']`. Aucun composant ne connaît le
 * thème, aucune classe n'est reconstruite.
 *
 * Sombre par défaut, comme la maquette validée le demande. Le choix vit dans `config.json`
 * (`ui.theme`) : c'est `ConfigProvider` qui l'applique, et la diffusion de la config le fait
 * passer d'une fenêtre à l'autre.
 */

import { useCallback } from 'react';

import { useConfig } from './config.js';

export type Theme = 'dark' | 'light';

export function useTheme(): { theme: Theme; toggle: () => void } {
  const { config, update } = useConfig();
  const theme = config.ui.theme;
  return {
    theme,
    toggle: useCallback(() => update({ ui: { theme: theme === 'dark' ? 'light' : 'dark' } }), [theme, update]),
  };
}
