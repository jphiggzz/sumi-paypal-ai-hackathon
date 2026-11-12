export function providerBackoff(error: unknown, attempt: number) {
  const description = String(error);
  if (
    !/rate.?limit|429|timed? ?out|timeout|temporar|\b50[234]\b/i.test(
      description,
    )
  )
    return null;
  if (/rate.?limit|429/i.test(description)) return 65_000;
  return Math.min(30_000, 5000 * (attempt + 1));
}
