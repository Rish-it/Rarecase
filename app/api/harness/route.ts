import { readHarnessStatus } from "@/lib/trueforge";

export const dynamic = "force-dynamic";

export async function GET() {
  const status = await readHarnessStatus();
  return Response.json(status, { status: status.reachable ? 200 : 503 });
}
