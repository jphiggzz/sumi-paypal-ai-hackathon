import type { Answer, Brief } from "./policy";

type Profile = { id: string; evidence: readonly string[] };

export function requireRequestedEvidence(
  brief: Brief,
  candidates: Answer["candidates"],
  catalog: readonly Profile[],
  explicitAudienceDetail = false,
): Answer["candidates"] {
  const request = [brief.goal, brief.audienceDetail, ...brief.topics].filter(Boolean).join(" ");
  const apiTesting = /\b(?:api\s+test(?:s|ing)?|test(?:ing)?\s+(?:(?:my|our|the|an?)\s+)?apis?)\b/i.test(request);
  const productSearch = /\b(?:product search|shopping agents?|ecommerce (?:product )?search)\b/i.test(request);
  const sdk = /\b(?:generated sdks?|sdk generation|generat(?:e|ed|ing)\s+(?:an?\s+)?sdks?)\b/i.test(request);
  const qualifier = explicitAudienceDetail
    ? brief.audienceDetail?.match(/^\s*([a-z0-9]{3,})\s+(?:students|developers|engineers|businesses|consumers|merchants)\s*$/i)?.[1]
    : undefined;
  const niche = qualifier && !/^(?:all|more|new|our|the|some|many|potential)$/i.test(qualifier)
    ? new RegExp(`\\b${qualifier}\\b`, "i") : null;
  if (!apiTesting && !niche && !productSearch && !sdk) {
    return candidates;
  }
  return candidates.flatMap((candidate) => {
    const profile = catalog.find((item) => item.id === candidate.id);
    if (!profile) return [];
    const testingIndexes = profile.evidence
      .map((evidence, index) => /\b(?:api tests?|api testing|testing (?:an? )?api|request assertions?|test (?:an? )?api)\b/i.test(evidence) ? index : -1)
      .filter((index) => index >= 0 && index <= 1);
    const nicheIndexes = profile.evidence
      .map((evidence, index) => niche?.test(evidence) ? index : -1)
      .filter((index) => index >= 0 && index <= 1);
    const searchIndexes = profile.evidence.map((evidence, index) => /\b(?:product search|search (?:results|ranking)|retrieval|shopping agents?|ecommerce agents?)\b/i.test(evidence) ? index : -1).filter(index => index >= 0 && index <= 1);
    const sdkIndexes = profile.evidence.map((evidence, index) => /\bgenerat(?:e|ed|ing|ion)\b[^.!?]{0,30}\bsdks?\b|\bsdks?\b[^.!?]{0,30}\bgenerat(?:e|ed|ing|ion)\b/i.test(evidence) ? index : -1).filter(index => index >= 0 && index <= 1);
    if ((apiTesting && !testingIndexes.length) || (niche && !nicheIndexes.length) || (productSearch && !searchIndexes.length) || (sdk && !sdkIndexes.length)) return [];
    const evidenceIndexes = [...new Set([
      ...(apiTesting ? testingIndexes : []),
      ...(niche ? nicheIndexes : []),
      ...(productSearch ? searchIndexes : []),
      ...(sdk ? sdkIndexes : []),
    ])].slice(0, 2);
    return [{ ...candidate, reason: evidenceIndexes.map(index => profile.evidence[index]).join(" "), evidenceIndexes }];
  });
}
