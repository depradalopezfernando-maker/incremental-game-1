/**
 * UI.md § Resource bar. Six columns, always visible: stockpile with net rate beneath.
 *
 * The stockpile figure is the network-wide sum of every star's buffer for that resource —
 * material always lives somewhere, and a purchase debits stars nearest the thing being bought.
 */

import { useUi } from '../app/store';
import styles from './app.module.css';
import { amount, clock, rate, resourceLabel } from './format';

export function ResourceBar(): JSX.Element {
  const snapshot = useUi((ui) => ui.snapshot);

  return (
    <div className={styles.resources}>
      {snapshot.resources.map((reading) => (
        <div key={reading.resource} className={styles.resource}>
          <span className={styles.resourceName}>{resourceLabel(reading.resource)}</span>
          <span className={styles.resourceAmount}>{amount(reading.amount)}</span>
          {/*
            Rate is warm when negative, never red. Consuming faster than you produce is often
            exactly right, and shouldn't alarm — red is reserved for material loss.
          */}
          <span
            className={
              reading.rate < -0.005
                ? `${styles.resourceRate} ${styles.rateNegative}`
                : styles.resourceRate
            }
          >
            {rate(reading.rate)}
          </span>
        </div>
      ))}
      <span className={styles.clock}>{clock(snapshot.elapsed)}</span>
    </div>
  );
}
