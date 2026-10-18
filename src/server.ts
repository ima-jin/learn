import { createDatabase } from './db/client';
import { installDatabase } from './db';

/** Application server initialization; imported only after required vault keys load. */
export function initializeServer(): void {
  installDatabase(createDatabase());
}
