import { z } from "zod";
import { checkCode } from "../../../lib/access";
import { scenarios } from "../../../lib/policy";
import { startApprovedCampaign } from "../../../lib/campaign-api";
const input = z.object({
  code: z.string().max(128),
  id: z.uuid(),
  scenario: z.enum(scenarios),
  approved: z.literal(true),
  recoveryTest: z.boolean().default(false),
});

export async function POST(request: Request) {
  const result = input.safeParse(await request.json().catch(() => null));
  if (!result.success)
    return Response.json(
      { error: "Campaign approval required." },
      { status: 400 },
    );
  const { code, id, scenario, recoveryTest } = result.data;
  if (!checkCode(code))
    return Response.json({ error: "Invalid demo code." }, { status: 403 });

  return startApprovedCampaign({ id, scenario, recoveryTest });
}
