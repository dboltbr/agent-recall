// Hidden frame for `/release [n]`: asks the service and attaches a chip with the status.
// Registered synchronously after connect: the host sends `resolve` right after `ready`.
import { connectHost } from "@openchamber/sdk";
import { describeServiceError, fetchCurrent, fetchRelease, type ServiceCall } from "../ui/feed.ts";
import { resolveChip } from "../ui/resolve.ts";

const host = connectHost();
const call: ServiceCall = (request) => host.serviceRequest(request);

host.onResolve(async ({ args }) => {
  try {
    return await resolveChip(args ?? "", {
      current: () => fetchCurrent(call),
      release: (number) => fetchRelease(call, number),
      now: () => new Date(),
    });
  } catch (error) {
    throw new Error((error as { code?: string }).code ? describeServiceError(error) : error instanceof Error ? error.message : String(error));
  }
});
