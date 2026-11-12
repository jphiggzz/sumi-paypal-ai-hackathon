import { createHash } from 'node:crypto';
export function artifactDigest(title: string, markdown: string) {
  return createHash('sha256').update(JSON.stringify({ title, markdown })).digest('hex');
}
