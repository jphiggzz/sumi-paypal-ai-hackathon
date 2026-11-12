import {CapabilityError} from './capability-contracts';
export type SourceReference={id:string;version:number};
/** Citation provenance is deterministic; it does not establish claim entailment. */
export function appendSourceCitations(text:string,refs:SourceReference[],maxCharacters:number){const allowed=new Set(refs.map(r=>`[source:${r.id}@${r.version}]`));for(const match of text.matchAll(/\[source:([^\]@\s]{1,100})@(\d+)\]/g))if(!allowed.has(match[0]))throw new CapabilityError('UNBOUND_SOURCE_CITATION',409);const missing=[...allowed].filter(c=>!text.includes(c));const result=missing.length?text+'\n\n'+missing.join('\n'):text;if(result.length>maxCharacters)throw new CapabilityError('OUTPUT_CITATION_LIMIT',413);return result;}
