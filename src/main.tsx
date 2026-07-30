/**
 * Entry point. Load whatever the player left, resolve however long they were away, then run.
 */

import { createRoot } from 'react-dom/client';
import { load } from './app/persistence';
import { App } from './ui/App';

const container = document.getElementById('root');
if (container === null) throw new Error('missing #root');

const { state, offline, loadError } = load();

createRoot(container).render(
  <App state={state} arrival={offline} loadError={loadError} />,
);
