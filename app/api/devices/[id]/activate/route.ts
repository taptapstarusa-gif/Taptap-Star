import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { withDbRetry } from "@/lib/db/retry";
import { devices, locations, employees, accounts } from "@/lib/db/schema";
import { requireSession, requireActiveAccount, authErrorResponse, AuthError } from "@/lib/auth/rbac";
import { activateDeviceSchema } from "@/lib/validation";
import { notify } from "@/lib/email/notify";
import { getPricingPlanByKey } from "@/lib/stripe/pricing";

// POST /api/devices/:id/activate — flips a device from `unassigned` to `active`, backing the
// claim wizard's final "Activate Device" step. Verifies the device is currently `unassigned`
// and the target location (and optional employee) belong to the session's account before
// mutating anything — never trust the client's locationId/employeeId.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireSession();
    await requireActiveAccount(session);
    const { id } = await params;

    const body = await request.json().catch(() => null);
    const parsed = activateDeviceSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { message: parsed.error.issues[0]?.message ?? "Invalid input" },
        { status: 400 }
      );
    }

    // Client reported (Sept 2026): activation failed with a generic server error on an Android
    // phone, worked fine moments later from a computer — the classic signature of Neon's
    // serverless compute failing a cold first request (`fetch failed`) on a slower/higher-latency
    // mobile connection. This whole route previously had zero retry protection, unlike
    // GET /api/locations's own read (lib/db/retry.ts's doc comment). withDbRetry wraps only the
    // read-only lookups below — never the mutating UPDATE further down, which has its own
    // deliberately-safe-to-retry reasoning at its own call site instead.
    const device = await withDbRetry("POST /api/devices/[id]/activate device lookup", () =>
      db.query.devices.findFirst({ where: eq(devices.id, id) })
    );
    if (!device) {
      return NextResponse.json({ message: "Device not found" }, { status: 404 });
    }
    if (device.status !== "unassigned") {
      return NextResponse.json(
        { message: "This device has already been activated." },
        { status: 409 }
      );
    }

    const location = await withDbRetry("POST /api/devices/[id]/activate location lookup", () =>
      db.query.locations.findFirst({ where: eq(locations.id, parsed.data.locationId) })
    );
    if (!location || location.accountId !== session.user.accountId) {
      throw new AuthError("Forbidden — location does not belong to your account", 403);
    }

    // Device cap for the Free tier (client-confirmed: same 1-device reasoning as Free's existing
    // 1-location cap). Premium/Network are unlimited (deviceLimit: null), and so is the legacy
    // "default" plan (deviceLimit: null from this column's additive migration) — a genuine no-op
    // for every pre-existing account, mirroring app/api/locations/route.ts's exact pattern.
    // Enforced here at ACTIVATION, not at batch-create time — an unassigned device belongs to no
    // account yet and shouldn't count against anything.
    const account = await withDbRetry("POST /api/devices/[id]/activate account lookup", () =>
      db.query.accounts.findFirst({ where: eq(accounts.id, session.user.accountId) })
    );
    if (!account) {
      return NextResponse.json({ message: "Account not found" }, { status: 404 });
    }
    const plan = await getPricingPlanByKey(account.planKey);
    if (plan.deviceLimit !== null) {
      const [{ count }] = await withDbRetry("POST /api/devices/[id]/activate device count", () =>
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(devices)
          .where(and(eq(devices.accountId, account.id), eq(devices.status, "active")))
      );
      if (count >= plan.deviceLimit) {
        return NextResponse.json(
          {
            message: `Your ${plan.name} plan allows up to ${plan.deviceLimit} active device${
              plan.deviceLimit === 1 ? "" : "s"
            }. Upgrade to Premium or Network for more.`,
          },
          { status: 403 }
        );
      }
    }

    if (parsed.data.employeeId) {
      const employeeId = parsed.data.employeeId;
      const employee = await withDbRetry("POST /api/devices/[id]/activate employee lookup", () =>
        db.query.employees.findFirst({ where: eq(employees.id, employeeId) })
      );
      // Employees are scoped to the location chosen in this same step — never account-wide
      // (architecture doc section 2's data-integrity rule).
      if (!employee || employee.locationId !== parsed.data.locationId) {
        throw new AuthError("Forbidden — employee does not belong to the chosen location", 403);
      }
    }

    // The status !== "unassigned" check above is a fast-path for the common single-request case
    // (nice error message without doing the location/employee validation work first) — it is NOT
    // what actually prevents a double-activation. Two near-simultaneous requests (a double-click
    // before the button's disabled state lands, or two open tabs) could both pass that read-only
    // check. The real guard is this UPDATE's WHERE also requiring status = 'unassigned': only one
    // concurrent request can match a row and get one back from `.returning()` — the other gets an
    // empty array and is treated as "already activated" below, exactly like the fast-path case.
    //
    // withDbRetry is safe here specifically because of that same WHERE guard: if the first
    // attempt's network round-trip genuinely failed before reaching the DB, retrying just
    // performs the real update. If the first attempt actually succeeded server-side but the
    // response never made it back (the exact mobile-network failure mode this route is being
    // hardened against), the retry's WHERE no longer matches (status is already 'active') and it
    // safely falls through to the same "already activated" 409 below — never a double-activation
    // or a duplicate notify() call.
    const [updated] = await withDbRetry("POST /api/devices/[id]/activate update", () =>
      db
        .update(devices)
        .set({
          status: "active",
          accountId: session.user.accountId,
          locationId: parsed.data.locationId,
          employeeId: parsed.data.employeeId ?? null,
          activatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(devices.id, id), eq(devices.status, "unassigned")))
        .returning()
    );

    if (!updated) {
      return NextResponse.json(
        { message: "This device has already been activated." },
        { status: 409 }
      );
    }

    // Trigger #3 (02_APPLICATION_FLOW.md §8): device activation confirmation, to the business
    // owner. Uses the live request origin for the dashboard link, per the Step 4
    // regression-watchlist rule against NEXT_PUBLIC_APP_URL for same-app URLs.
    const appUrl = new URL(request.url).origin;
    await notify(session.user.accountId, "device_activated", {
      deviceCode: device.code,
      locationName: location.name,
      dashboardUrl: `${appUrl}/dashboard/devices/${updated.id}`,
    });

    return NextResponse.json({ device: updated });
  } catch (err) {
    const { message, status } = authErrorResponse(err);
    return NextResponse.json({ message }, { status });
  }
}
