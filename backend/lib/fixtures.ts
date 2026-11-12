import { z } from 'zod';

export const fixtureNames = ['counteroffer', 'acceptance', 'delivery'] as const;
export const fixtureSchema = z.enum(fixtureNames);
export type Fixture = z.infer<typeof fixtureSchema>;

export function eventKey(id: string, event: Fixture) {
  return id + ':' + event;
}
