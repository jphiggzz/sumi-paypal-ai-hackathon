import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CapabilityError } from './capability-contracts';
export const actionInput=z.object({
 id:z.uuid(),conversationId:z.uuid(),connectionId:z.uuid(),connectionVersion:z.number().int().positive(),
 resourceId:z.enum(['doc-alpha','doc-beta']),note:z.string().trim().min(1).max(500).refine(value=>!/[\u0000-\u001f\u007f]/.test(value),'Control characters are not supported.'),
 expectedTargetVersion:z.number().int().nonnegative().default(0),expiresAt:z.iso.datetime({offset:true}).optional(),recoveryTest:z.boolean().default(false),
}).strict();
export const actionDecision=z.object({decision:z.enum(['approve','reject']),digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type ActionInput=z.infer<typeof actionInput>;
export type ActionDecision=z.infer<typeof actionDecision>;
export type ActionPayload=Omit<ActionInput,'expiresAt'>&{expiresAt:string;ownerId:string;sequence:number;kind:'fixture.record_note'};
export type ActionState='pending'|'approved'|'rejected'|'executed'|'blocked'|'expired'|'needs_review';
export type ActionReceipt={proposalId:string;kind:'fixture.record_note';fixture:true;resourceId:string;targetVersion:number;note:string;committedAt:string};
export type ActionProposal={id:string;payload:ActionPayload;digest:string;state:ActionState;attempts:number;decidedAt:string|null;error:string|null;receipt:ActionReceipt|null};
function canonical(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
 return JSON.stringify(value);
}
export function actionDigest(payload:ActionPayload){return createHash('sha256').update(canonical(payload)).digest('hex');}
export function assertActionExpiry(expiresAt:string,now=Date.now()) {
 const expiry=Date.parse(expiresAt);
 if(!Number.isFinite(expiry)||expiry<=now||expiry>now+86400_000)throw new CapabilityError('ACTION_EXPIRY_INVALID',400);
}
export function assertActionBinding(payload:ActionPayload,digest:string,ownerId:string,sequence:number,now=Date.now()) {
 if(payload.ownerId!==ownerId)throw new CapabilityError('ACTION_NOT_FOUND',404);
 if(actionDigest(payload)!==digest)throw new CapabilityError('ACTION_DIGEST_CONFLICT',409);
 if(payload.sequence!==sequence)throw new CapabilityError('ACTION_SUPERSEDED',409);
 if(Date.parse(payload.expiresAt)<=now)throw new CapabilityError('ACTION_EXPIRED',409);
}
