/**
 * Thème de l'interface.
 *
 * La bascule pose un attribut sur la racine, et rien d'autre : toutes les couleurs sont des
 * variables CSS redéfinies sous `:root[data-theme='light']`. Aucun composant ne connaît le
 * thème, aucune classe n'est reconstruite.
 *
 * Sombre par défaut, comme la maquette validée le demande. Le choix est retenu d'une session
 * à l'autre : régler un banc se fait dans une pièce dont l'éclairage ne change pas toutes
 * les cinq minutes.
 */

import { useCallback, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'a2n.theme';

function stored(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    // Stockage indisponible : le thème par défaut reste correct, ce n'est pas une erreur
    // qui mérite de remonter jusqu'à l'utilisateur.
    return 'dark';
  }
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(stored);

  useEffect(() => {
    // Le sombre est la valeur de base des variables : il n'a pas besoin d'attribut, et ne
    // pas en poser évite un état intermédiaire visible au premier rendu.
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');

    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* sans persistance, la bascule vaut pour la session courante */
    }
  }, [theme]);

  return {
    theme,
    toggle: useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []),
  };
}
