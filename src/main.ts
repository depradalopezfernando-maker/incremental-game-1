/**
 * Entry point. Phase 1 is headless by design — the simulation is proven in tests before
 * anything is drawn, because the single biggest risk to this project is building a
 * beautiful map before the flow model is correct.
 *
 * The canvas map and HUD arrive in Phase 3. See ROADMAP.md.
 */

import { newGame } from './sim/generate';
import { tick } from './sim/tick';
import { networkTotals } from './sim/audit';
import { SIM_STEP_SECONDS } from './sim/constants';

const state = newGame(Date.now() >>> 0);
for (let i = 0; i < 600; i++) tick(state, SIM_STEP_SECONDS);

const root = document.getElementById('root');
if (root !== null) {
  root.textContent = `Lightlace — simulation core only. ${state.run.stars.length} stars generated, 60s simulated, ${networkTotals(state.run).metals.toFixed(0)} metals held. No interface until phase 3.`;
}
