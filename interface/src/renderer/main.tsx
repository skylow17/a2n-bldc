/** Point d'entrée du renderer. `#control` : la vue Control détachée, sinon l'application. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { ControlWindow } from './ControlWindow.js';
import './styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('#root introuvable');

const detached = window.location.hash === '#control';
if (detached) document.title = 'A2N BLDC — Control';

createRoot(root).render(<StrictMode>{detached ? <ControlWindow /> : <App />}</StrictMode>);
