// Generic notification service — every notification in the app goes through notify(accountId,
// type, payload) rather than call sites constructing raw emails inline. Backed by the
// notification_events table (lib/db/schema.ts): every call inserts a row first, then renders +
// sends the matching React Email template via Resend, then sets sentAt on success only — never
// faked. Type -> template routing lives entirely inside this file (03_DATA_MODEL_AND_ARCHITECTURE.md
// section 2, 05_MASTER_BUILD_GUIDE.md Step 9.2).
import * as React from "react";
import { render as renderEmailHtml } from "@react-email/render";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accounts, notificationEvents, users } from "@/lib/db/schema";
import { sendMail } from "@/lib/email/client";
// import { resend, FROM } from "@/lib/email/client"; // Resend — see lib/email/client.ts's comment
import { VerificationEmail } from "@/lib/email/templates/VerificationEmail";
import { WelcomeEmail } from "@/lib/email/templates/WelcomeEmail";
import { DeviceActivatedEmail } from "@/lib/email/templates/DeviceActivatedEmail";
import { PerformanceSummaryEmail } from "@/lib/email/templates/PerformanceSummaryEmail";
import { BillingAlertEmail } from "@/lib/email/templates/BillingAlertEmail";
import { GracePeriodReminderEmail } from "@/lib/email/templates/GracePeriodReminderEmail";
import { SuspensionEmail } from "@/lib/email/templates/SuspensionEmail";
import { PaymentRecoveredEmail } from "@/lib/email/templates/PaymentRecoveredEmail";
import { ContactFormAdminEmail } from "@/lib/email/templates/ContactFormAdminEmail";
import { AgencyApprovedEmail } from "@/lib/email/templates/AgencyApprovedEmail";
import { AgencyRejectedEmail } from "@/lib/email/templates/AgencyRejectedEmail";
import { AgencyRequestSubmittedEmail } from "@/lib/email/templates/AgencyRequestSubmittedEmail";
import { LowRatingAlertEmail } from "@/lib/email/templates/LowRatingAlertEmail";

// The 11 triggers from 02_APPLICATION_FLOW.md section 8.
export type NotificationType =
  | "verification"
  | "welcome"
  | "device_activated"
  | "performance_summary"
  | "billing_alert"
  | "grace_period_reminder"
  | "suspension_notice"
  | "payment_recovered"
  | "contact_form_submitted"
  | "agency_request_approved"
  | "agency_request_rejected"
  | "agency_request_submitted"
  | "low_rating_feedback";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Payload = Record<string, any>;

type Rendered = { subject: string; react: React.ReactElement };

function render(type: NotificationType, payload: Payload): Rendered {
  switch (type) {
    case "verification":
      return {
        subject: "Verify your Taptapstar email",
        react: React.createElement(VerificationEmail, { verifyUrl: payload.verifyUrl }),
      };
    case "welcome":
      return {
        subject: "Welcome to Taptapstar",
        react: React.createElement(WelcomeEmail, {
          name: payload.name,
          dashboardUrl: payload.dashboardUrl,
        }),
      };
    case "device_activated":
      return {
        subject: `Device ${payload.deviceCode} activated`,
        react: React.createElement(DeviceActivatedEmail, {
          deviceCode: payload.deviceCode,
          locationName: payload.locationName,
          dashboardUrl: payload.dashboardUrl,
        }),
      };
    case "performance_summary":
      return {
        subject: `Your ${payload.periodLabel} performance summary`,
        react: React.createElement(PerformanceSummaryEmail, {
          accountName: payload.accountName,
          periodLabel: payload.periodLabel,
          totalScans: payload.totalScans,
          trendPercent: payload.trendPercent ?? null,
          topLocationName: payload.topLocationName ?? null,
          dashboardUrl: payload.dashboardUrl,
        }),
      };
    case "billing_alert":
      return {
        subject: "Your Taptapstar payment failed",
        react: React.createElement(BillingAlertEmail, { billingUrl: payload.billingUrl }),
      };
    case "grace_period_reminder":
      return {
        subject: "Your grace period is ending soon",
        react: React.createElement(GracePeriodReminderEmail, {
          daysRemaining: payload.daysRemaining,
          billingUrl: payload.billingUrl,
        }),
      };
    case "suspension_notice":
      return {
        subject: "Your Taptapstar account has been suspended",
        react: React.createElement(SuspensionEmail, { billingUrl: payload.billingUrl }),
      };
    case "payment_recovered":
      return {
        subject: "Your Taptapstar account is active again",
        react: React.createElement(PaymentRecoveredEmail, { dashboardUrl: payload.dashboardUrl }),
      };
    case "contact_form_submitted":
      return {
        subject: `New contact form submission from ${payload.name}`,
        react: React.createElement(ContactFormAdminEmail, {
          name: payload.name,
          email: payload.email,
          message: payload.message,
        }),
      };
    case "agency_request_approved":
      return {
        subject: "You're now a Taptapstar agency account",
        react: React.createElement(AgencyApprovedEmail, { dashboardUrl: payload.dashboardUrl }),
      };
    case "agency_request_rejected":
      return {
        subject: "Your agency request was not approved",
        react: React.createElement(AgencyRejectedEmail, { reason: payload.reason ?? null }),
      };
    case "agency_request_submitted":
      return {
        subject: `New agency request from ${payload.accountName}`,
        react: React.createElement(AgencyRequestSubmittedEmail, {
          accountName: payload.accountName,
          reviewUrl: payload.reviewUrl,
        }),
      };
    case "low_rating_feedback":
      return {
        subject: `New ${payload.rating}-star feedback at ${payload.locationName}`,
        react: React.createElement(LowRatingAlertEmail, {
          locationName: payload.locationName,
          rating: payload.rating,
          comment: payload.comment ?? null,
          feedbackUrl: payload.feedbackUrl,
        }),
      };
  }
}

/**
 * Resolves the recipient email for an account-scoped notification: an explicit
 * payload.recipientEmail always wins (used when the caller already has the exact user, e.g. a
 * freshly-created signup); otherwise falls back to the account's owner user, then any user on
 * the account, then the account's billing_email.
 */
async function resolveRecipient(accountId: string, payload: Payload): Promise<string | null> {
  if (payload.recipientEmail) return payload.recipientEmail as string;

  const owner = await db.query.users.findFirst({
    where: eq(users.accountId, accountId),
    orderBy: (u, { asc }) => [asc(u.createdAt)],
  });
  if (owner?.email) return owner.email;

  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
  return account?.billingEmail ?? null;
}

export type NotifyResult = { id: string; sent: boolean };

/**
 * Send a notification. Always inserts a notification_events row first; sets sentAt only on a
 * confirmed successful Resend send. Never throws for a send failure — the row's null sentAt is
 * the source of truth for "did this actually go out," per Step 9's explicit "don't fake success"
 * requirement. Returns `{ id, sent }` — `sent` is false on any failure (no recipient, Resend
 * error, or thrown exception). Every existing call site was already fire-and-forget (`await
 * notify(...)` with the return value discarded), so this is safe to add without touching them;
 * only signup/resend-verification need `sent` to avoid showing a false "email sent" message.
 *
 * The leading insert() below used to sit OUTSIDE this function's own try/catch — a real bug
 * (client report, Sept 2026): a device activation on a mobile connection threw a generic server
 * error because this insert failed (most likely a Neon cold-start `fetch failed`, same root
 * cause as app/api/devices/[id]/activate/route.ts's own withDbRetry hardening added alongside
 * this fix), even though the activation UPDATE itself had already succeeded. That directly
 * contradicted this function's own "never throws" contract above. Now covered by the same
 * try/catch as everything else, so a logging failure can never take down the real action that
 * triggered the notification.
 */
export async function notify(
  accountId: string,
  type: NotificationType,
  payload: Payload = {}
): Promise<NotifyResult> {
  let eventId: string;
  try {
    const [event] = await db
      .insert(notificationEvents)
      .values({ accountId, type, payloadJson: payload })
      .returning();
    eventId = event.id;
  } catch (err) {
    // No event row exists to reference — this is the one case with no real id to return. Logged
    // loudly since it means notification_events (the audit trail Step 9 relies on) missed a real
    // event entirely, but the caller's own action must proceed regardless.
    console.error(`[notify] failed to record event for type ${type}, account ${accountId}:`, err);
    return { id: "", sent: false };
  }

  try {
    const to = await resolveRecipient(accountId, payload);
    if (!to) {
      console.error(`[notify] no recipient resolved for account ${accountId}, type ${type}`);
      return { id: eventId, sent: false };
    }

    const { subject, react } = render(type, payload);
    // Resend accepted a React element directly (`react: react`); Nodemailer needs rendered
    // HTML/text, so the React Email template is rendered here instead of inside the client.
    const [html, text] = await Promise.all([
      renderEmailHtml(react),
      renderEmailHtml(react, { plainText: true }),
    ]);
    const { error } = await sendMail({ to, subject, html, text });
    // const { error } = await resend.emails.send({ from: FROM, to, subject, react }); // Resend

    if (error) {
      console.error(`[notify] send failed for type ${type}:`, error);
      return { id: eventId, sent: false };
    }

    await db
      .update(notificationEvents)
      .set({ sentAt: new Date() })
      .where(eq(notificationEvents.id, eventId));
  } catch (err) {
    console.error(`[notify] unexpected error sending type ${type}:`, err);
    return { id: eventId, sent: false };
  }

  return { id: eventId, sent: true };
}
