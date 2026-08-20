/**
 * Permissions — the one screen where lasting access is reviewed and revoked.
 *
 * The screen is organised around a single question a person actually arrives
 * with: *what can act on my workspace without asking me first?* Everything else
 * — the catalogue, the per-agent matrix, the area pivot, the decision log — is a
 * different route to the same rows, so the same words and the same glyphs are
 * used throughout. A row means the same thing wherever it is met.
 *
 * Two disclosure rules hold everywhere:
 *
 *  - A closed row states the decision (who, what, still in force?). Opening it
 *    states the reasoning (why it exists, who approved it, what revoking does).
 *    Nothing that changes a decision is ever hidden behind a disclosure.
 *  - A 64-character effective version is the right key for a grant and the
 *    wrong thing to put in front of a person (§7.6.3). Parts are named by their
 *    path; exact versions live inside a disclosure, never on a headline.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertDialog,
  Badge,
  Box,
  Button,
  Callout,
  Card,
  DataList,
  Flex,
  Grid,
  Heading,
  IconButton,
  Separator,
  Spinner,
  Tabs,
  Text,
  TextField,
  Tooltip,
} from "@radix-ui/themes";
import {
  Activity,
  AppWindow,
  ArrowRight,
  Ban,
  Blocks,
  Bot,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleSlash,
  CircleX,
  Clock3,
  Eye,
  FolderOpen,
  Gavel,
  Globe,
  Hand,
  Handshake,
  Hourglass,
  KeyRound,
  Laptop,
  Layers,
  ListChecks,
  Lock,
  LockOpen,
  Monitor,
  Package,
  PanelsTopLeft,
  Pause,
  Play,
  Puzzle,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Server,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Trash2,
  TriangleAlert,
  UserMinus,
  UserPlus,
  Users,
  Wrench,
  Zap,
  type LucideIcon,
} from "@workspace/ui/icons";
import { EmptyState } from "@workspace/ui/feedback";
import { panel, rpc } from "@workspace/runtime";
import { AboutPage, AboutThemeRoot, Section } from "../../packages/about-shared/ui";

/* ------------------------------------------------------------------ types */

export interface SavedPermissionGrant {
  id: string;
  kind: "capability" | "credential-use" | "browser-site";
  callerLabel: string;
  scopeLabel: string;
  capability?: string;
  resource?: string;
  repoPath?: string;
  effectiveVersion?: string;
  grantedAt?: number;
  lastUsedAt?: number;
  expiresAt?: number;
  why: string;
  /**
   * Which decision this permission arrived with, in §7.7's words: `Part of
   * Vibestudio`, `Added with News`, `You allowed this`.
   *
   * Distinct from `why`, which says what the permission does. This screen is
   * where an install-time choice is revisited in both directions, and that is
   * only possible if a row minted by a review is distinguishable from one the
   * person answered a prompt for.
   */
  origin?: string;
  approvedBy: string;
  duration: string;
  revokeEffect: string;
}

type DomainId =
  | "files"
  | "sharing"
  | "accounts"
  | "web"
  | "automation"
  | "people"
  | "computer"
  | "safety";
type Verb = "see" | "act" | "manage";
type CellState = "asks-first" | "allowed" | "never" | "not-available";

type ProfileItem = {
  id: string;
  kind: "grant" | "lock";
  capability?: string;
  action: string;
  resource?: string;
  domain: DomainId;
  verb: Verb;
  state: "active" | "suspended" | "locked";
  decidedAt: number;
  lastUsedAt?: number;
  attemptCount?: number;
  lastAttemptAt?: number;
  why: string;
  approvedBy: string;
  duration: string;
  revokeEffect: string;
};
type AgentAuthorityCell = {
  domain: DomainId;
  verb: Verb;
  state: CellState;
  allowanceCount: number;
  items: ProfileItem[];
};
type AgentAuthorityProfile = {
  bindingId: string;
  name: string;
  summary: string;
  paused: boolean;
  cells: AgentAuthorityCell[];
};
type AuthoritySafetyStatus = {
  workspaceLocked: boolean;
  activeAgentCount: number;
  pendingAcquisitionCount: number;
  lockedAt?: number;
  lockedBy?: string;
};
/** One protected action paused on a human decision right now. */
type PendingAuthorityRequest = {
  acquisitionId: string;
  capability: string;
  action: string;
  resource?: string;
  domain?: DomainId;
  verb?: Verb;
  tier: "gated" | "critical";
  requestedAt: number;
  requesterLabel: string;
  agentBindingId?: string;
};
type AuthorityRow = {
  capability: string;
  domain: DomainId;
  verb: Verb;
  action: string;
  resource: string;
  tier: "gated" | "critical";
  statement: "declared" | "allowed" | "snapshot" | "prospective";
};
type BuildUnitCatalogEntry = {
  name: string;
  kind: "panel" | "worker" | "extension" | "app";
  target: "electron" | "react-native" | "terminal" | null;
  isAgent: boolean;
  source: string;
  displayName: string;
  status: "available" | "building" | "ready" | "approval-required" | "error";
  effectiveVersion: string | null;
  activeBuildKey: string | null;
  pendingApproval: { kind: string; submittedAt: number } | null;
  lastError: string | null;
  authorityRows: AuthorityRow[];
};
type ApprovalDecisionRecord = {
  approvalId: string;
  approvalKind: string;
  decision: string;
  granted: boolean;
  resolvedAt: number;
  resolvedBy: { handle: string; deviceLabel?: string };
  resolvedVia?: "shell" | "mobile-notification" | "app" | "server";
  requestedBy: { callerId: string; callerKind?: string; repoPath?: string };
  resource?: { capability?: string; value?: string; key?: string };
  grantScopeStored?: string | null;
};
type MembershipRecord = {
  kind: "membership";
  op: "invite-user" | "revoke-user" | "add-member" | "remove-member" | "role-change";
  actor: { userId: string; handle: string };
  target: { userId: string; handle?: string };
  role?: string;
  at: number;
};
type GovernanceRecord = ApprovalDecisionRecord | MembershipRecord;

type ViewId = "overview" | "catalog" | "saved" | "agents" | "areas" | "activity";

/* --------------------------------------------------------- vocabulary */

/**
 * One glyph and one accent per permission area, used by every view.
 *
 * The point is recognition rather than decoration: the same mark on an overview
 * tile, a saved row, and a catalogue line is what lets someone follow one area
 * across four different framings of the same data.
 */
const DOMAIN_META: Record<
  DomainId,
  { label: string; short: string; description: string; icon: LucideIcon; accent: string }
> = {
  files: {
    label: "Your files & work",
    short: "Files",
    description: "Documents, code, and project content in your workspace",
    icon: FolderOpen,
    accent: "indigo",
  },
  sharing: {
    label: "Publishing & sending",
    short: "Sending",
    description: "Anything that leaves your workspace: publishing, sending, posting",
    icon: Send,
    accent: "orange",
  },
  accounts: {
    label: "Accounts & sign-ins",
    short: "Accounts",
    description: "Connected accounts, passwords, and credentials",
    icon: KeyRound,
    accent: "amber",
  },
  web: {
    label: "The web",
    short: "Web",
    description: "Browsing data, websites, and downloads",
    icon: Globe,
    accent: "cyan",
  },
  automation: {
    label: "Apps & automation",
    short: "Automation",
    description: "Installing, running, and scheduling apps and agents",
    icon: Blocks,
    accent: "violet",
  },
  people: {
    label: "People & devices",
    short: "People",
    description: "Workspace members, presence, and paired devices",
    icon: Users,
    accent: "jade",
  },
  computer: {
    label: "This computer",
    short: "Computer",
    description: "The Vibestudio application and the machine it runs on",
    icon: Laptop,
    accent: "blue",
  },
  safety: {
    label: "Permissions & safety",
    short: "Safety",
    description: "Your permission choices and the controls that enforce them",
    icon: ShieldCheck,
    accent: "crimson",
  },
};
const DOMAIN_IDS = Object.keys(DOMAIN_META) as DomainId[];

const VERB_META: Record<Verb, { label: string; icon: LucideIcon; gloss: string }> = {
  see: { label: "See", icon: Eye, gloss: "read something in this area" },
  act: { label: "Do", icon: Zap, gloss: "change or use something in this area" },
  manage: { label: "Manage", icon: SlidersHorizontal, gloss: "change the rules for this area" },
};

const CELL_META: Record<
  CellState,
  { label: string; color: "green" | "red" | "gray" | "amber"; icon: LucideIcon }
> = {
  allowed: { label: "Allowed", color: "green", icon: CircleCheck },
  "asks-first": { label: "Asks first", color: "gray", icon: Hand },
  never: { label: "Never", color: "red", icon: Ban },
  "not-available": { label: "Not available", color: "gray", icon: CircleSlash },
};

const UNIT_KIND_META: Record<
  "agent" | "worker" | "panel" | "app" | "extension",
  { plural: string; singular: string; icon: LucideIcon; blurb: string }
> = {
  agent: {
    plural: "Agents",
    singular: "agent",
    icon: Bot,
    blurb: "Code that acts on your behalf and can ask for lasting access.",
  },
  worker: {
    plural: "Background workers",
    singular: "background worker",
    icon: Server,
    blurb: "Code that runs without a window, on a schedule or an event.",
  },
  panel: {
    plural: "Panels",
    singular: "panel",
    icon: PanelsTopLeft,
    blurb: "Screens you open. They act only while you are looking at them.",
  },
  app: {
    plural: "Apps",
    singular: "app",
    icon: AppWindow,
    blurb: "Whole applications installed into this workspace.",
  },
  extension: {
    plural: "Extensions",
    singular: "extension",
    icon: Puzzle,
    blurb: "Code that adds tools and abilities to everything else.",
  },
};

const RESOLVED_VIA_META: Record<string, { label: string; icon: LucideIcon }> = {
  shell: { label: "in Vibestudio", icon: Monitor },
  "mobile-notification": { label: "from a phone notification", icon: Smartphone },
  app: { label: "in an app", icon: AppWindow },
  server: { label: "by the workspace server", icon: Server },
};

const MEMBERSHIP_META: Record<
  MembershipRecord["op"],
  { label: string; icon: LucideIcon; color: "green" | "red" | "blue" }
> = {
  "invite-user": { label: "invited", icon: UserPlus, color: "green" },
  "revoke-user": { label: "revoked access for", icon: UserMinus, color: "red" },
  "add-member": { label: "added", icon: UserPlus, color: "green" },
  "remove-member": { label: "removed", icon: UserMinus, color: "red" },
  "role-change": { label: "changed the role of", icon: Handshake, color: "blue" },
};

/* ----------------------------------------------------------- utilities */

function isMembership(record: GovernanceRecord): record is MembershipRecord {
  return (record as Partial<MembershipRecord>).kind === "membership";
}

function recordTimestamp(record: GovernanceRecord): number {
  return isMembership(record) ? record.at : record.resolvedAt;
}

const ABSOLUTE = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const DAY_HEADING = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});
const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const RELATIVE_STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 60 * 60 * 1000],
  ["month", 30 * 24 * 60 * 60 * 1000],
  ["week", 7 * 24 * 60 * 60 * 1000],
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
];

/** "3 days ago" / "in 2 months" — the form a person reads without arithmetic. */
function relativeLabel(value: number, now: number): string {
  const delta = value - now;
  for (const [unit, size] of RELATIVE_STEPS) {
    if (Math.abs(delta) >= size) return RELATIVE.format(Math.round(delta / size), unit);
  }
  return RELATIVE.format(Math.round(delta / 1000), "second");
}

function absoluteLabel(value?: number): string {
  return value === undefined ? "Date unavailable" : ABSOLUTE.format(value);
}

/**
 * A relative timestamp that keeps its exact value one hover away.
 *
 * "3 months ago" is what makes a stale grant visible at a glance; the exact
 * instant is what makes it checkable. Neither alone is enough.
 */
function TimeAgo({ value, now }: { value?: number; now: number }) {
  if (value === undefined) {
    return (
      <Text size="1" color="gray">
        date unavailable
      </Text>
    );
  }
  return (
    <Tooltip content={absoluteLabel(value)}>
      <Text size="1" color="gray" style={{ cursor: "help", textDecoration: "underline dotted" }}>
        {relativeLabel(value, now)}
      </Text>
    </Tooltip>
  );
}

function Glyph({
  icon: Icon,
  accent,
  size = 34,
  emphasis = "soft",
}: {
  icon: LucideIcon;
  accent: string;
  size?: number;
  emphasis?: "soft" | "solid";
}) {
  return (
    <Flex
      align="center"
      justify="center"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size / 3.4),
        flexShrink: 0,
        color: emphasis === "solid" ? "white" : `var(--${accent}-11)`,
        background: emphasis === "solid" ? `var(--${accent}-9)` : `var(--${accent}-a3)`,
        boxShadow: emphasis === "solid" ? `0 2px 10px var(--${accent}-a6)` : "none",
      }}
    >
      <Icon size={Math.round(size * 0.52)} strokeWidth={1.9} aria-hidden />
    </Flex>
  );
}

function DomainGlyph({ domain, size = 34 }: { domain: DomainId; size?: number }) {
  const meta = DOMAIN_META[domain];
  return <Glyph icon={meta.icon} accent={meta.accent} size={size} />;
}

/** A "gated" ability asks once and is remembered; a "critical" one asks every time. */
function TierChip({ tier }: { tier: "gated" | "critical" }) {
  return (
    <Tooltip
      content={
        tier === "critical"
          ? "Always asks before it happens, even when allowed"
          : "Can be remembered after you allow it once"
      }
    >
      <Badge color={tier === "critical" ? "amber" : "gray"} variant="soft" size="1">
        {tier === "critical" ? <TriangleAlert size={11} /> : <CircleCheck size={11} />}
        {tier === "critical" ? "Asks every time" : "Can be remembered"}
      </Badge>
    </Tooltip>
  );
}

function VerbChip({ verb }: { verb: Verb }) {
  const meta = VERB_META[verb];
  return (
    <Tooltip content={`Permission to ${meta.gloss}`}>
      <Badge variant="outline" color="gray" size="1">
        <meta.icon size={11} />
        {meta.label}
      </Badge>
    </Tooltip>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  accent,
  hint,
  onClick,
  urgent,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  accent: string;
  hint: string;
  onClick?: () => void;
  urgent?: boolean;
}) {
  const body = (
    <Flex align="center" gap="3">
      <Glyph icon={Icon} accent={accent} size={36} emphasis={urgent ? "solid" : "soft"} />
      <Box style={{ minWidth: 0 }}>
        <Text as="div" size="6" weight="bold" style={{ lineHeight: 1.1 }}>
          {value}
        </Text>
        <Text as="div" size="1" color="gray" style={{ whiteSpace: "nowrap" }}>
          {label}
        </Text>
      </Box>
    </Flex>
  );
  return (
    <Tooltip content={hint}>
      {onClick ? (
        <Card asChild variant="surface">
          <button
            type="button"
            onClick={onClick}
            aria-label={`${label}: ${value}`}
            style={{ cursor: "pointer", textAlign: "left", width: "100%" }}
          >
            {body}
          </button>
        </Card>
      ) : (
        <Card variant="surface">{body}</Card>
      )}
    </Tooltip>
  );
}

/**
 * The one disclosure primitive on this screen.
 *
 * Every collapsed row is a full button, so the whole line is the target — a
 * chevron alone is a small tap area on a screen someone reaches for when they
 * are already worried about something.
 */
function Disclosure({
  open,
  onToggle,
  summary,
  trailing,
  children,
}: {
  open: boolean;
  onToggle(): void;
  summary: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Box>
      <Flex align="center" gap="2">
        <Box asChild flexGrow="1" style={{ minWidth: 0 }}>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            style={{
              display: "block",
              width: "100%",
              border: 0,
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
              padding: 0,
              textAlign: "left",
            }}
          >
            <Flex align="center" gap="2" style={{ minWidth: 0 }}>
              <Box style={{ color: "var(--gray-9)", flexShrink: 0 }}>
                {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              </Box>
              <Box style={{ minWidth: 0, flexGrow: 1 }}>{summary}</Box>
            </Flex>
          </button>
        </Box>
        {trailing}
      </Flex>
      {open ? (
        <Box pl="5" pt="3">
          {children}
        </Box>
      ) : null}
    </Box>
  );
}

/** A destructive control that states its consequence before it runs. */
function ConfirmAction({
  trigger,
  title,
  description,
  confirmLabel,
  onConfirm,
  tone = "red",
}: {
  trigger: ReactNode;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm(): void;
  tone?: "red" | "gray";
}) {
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger>{trigger}</AlertDialog.Trigger>
      <AlertDialog.Content maxWidth="460px">
        <AlertDialog.Title>{title}</AlertDialog.Title>
        <AlertDialog.Description size="2">{description}</AlertDialog.Description>
        <Flex gap="3" mt="4" justify="end">
          <AlertDialog.Cancel>
            <Button variant="soft" color="gray">
              Keep it
            </Button>
          </AlertDialog.Cancel>
          <AlertDialog.Action>
            <Button variant="solid" color={tone} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </AlertDialog.Action>
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

function SectionHeading({
  icon: Icon,
  accent,
  title,
  description,
  actions,
}: {
  icon: LucideIcon;
  accent: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <Flex align="start" justify="between" gap="3" wrap="wrap">
      <Flex align="center" gap="3" style={{ minWidth: 0 }}>
        <Glyph icon={Icon} accent={accent} size={30} />
        <Box style={{ minWidth: 0 }}>
          <Heading size="3">{title}</Heading>
          {description ? (
            <Text as="div" size="1" color="gray">
              {description}
            </Text>
          ) : null}
        </Box>
      </Flex>
      {actions}
    </Flex>
  );
}

/* ---------------------------------------------------------- lock banner */

function SafetyBanner({
  safety,
  busy,
  onSetLock,
  now,
}: {
  safety: AuthoritySafetyStatus;
  busy: boolean;
  onSetLock(locked: boolean): void;
  now: number;
}) {
  const locked = safety.workspaceLocked;
  const accent = locked ? "red" : "grass";
  return (
    <Card
      size="3"
      style={{
        background: `var(--${accent}-a2)`,
        boxShadow: `inset 0 0 0 1px var(--${accent}-a6)`,
      }}
    >
      <Flex align="start" justify="between" gap="4" wrap="wrap">
        <Flex align="start" gap="3" style={{ minWidth: 0 }}>
          <Glyph
            icon={locked ? ShieldAlert : ShieldCheck}
            accent={accent}
            size={44}
            emphasis="solid"
          />
          <Box style={{ minWidth: 0 }}>
            <Flex align="center" gap="2" wrap="wrap">
              <Heading size="4">
                {locked ? "Agent authority is locked" : "Agent authority is live"}
              </Heading>
              <Badge color={locked ? "red" : "grass"} variant="solid" size="1">
                {locked ? "Locked" : "Ready"}
              </Badge>
            </Flex>
            <Text as="div" size="2" color="gray" mt="1">
              {locked
                ? "Every agent is blocked from protected workspace actions. Your own permission controls stay available."
                : "Agents may do protected work when you ask them to, within the permissions below."}
            </Text>
            <Flex align="center" gap="3" mt="2" wrap="wrap">
              {locked && safety.lockedBy ? (
                <Flex align="center" gap="1">
                  <Lock size={12} aria-hidden />
                  <Text size="1" color="gray">
                    Locked by {safety.lockedBy}
                  </Text>
                  <TimeAgo value={safety.lockedAt} now={now} />
                </Flex>
              ) : (
                <Flex align="center" gap="1">
                  <Bot size={12} aria-hidden />
                  <Text size="1" color="gray">
                    {safety.activeAgentCount} active agent
                    {safety.activeAgentCount === 1 ? "" : "s"}
                  </Text>
                </Flex>
              )}
              <Flex align="center" gap="1">
                <Hourglass size={12} aria-hidden />
                <Text size="1" color={safety.pendingAcquisitionCount > 0 ? "amber" : "gray"}>
                  {safety.pendingAcquisitionCount} waiting on you
                </Text>
              </Flex>
            </Flex>
          </Box>
        </Flex>
        {locked ? (
          <Button variant="solid" color="grass" disabled={busy} onClick={() => onSetLock(false)}>
            {busy ? <Spinner size="1" /> : <LockOpen size={15} />} Unlock agent authority
          </Button>
        ) : (
          <ConfirmAction
            trigger={
              <Button variant="soft" color="red" disabled={busy}>
                {busy ? <Spinner size="1" /> : <Lock size={15} />} Lock all agent authority
              </Button>
            }
            title="Lock all agent authority?"
            description={
              <>
                This stops work in progress. It cancels{" "}
                <strong>{safety.pendingAcquisitionCount}</strong> waiting permission request
                {safety.pendingAcquisitionCount === 1 ? "" : "s"}, interrupts{" "}
                <strong>{safety.activeAgentCount}</strong> active agent
                {safety.activeAgentCount === 1 ? "" : "s"}, and blocks new protected work until you
                unlock it. Your saved permissions are not deleted, and your own controls keep
                working.
              </>
            }
            confirmLabel="Lock everything"
            onConfirm={() => onSetLock(true)}
          />
        )}
      </Flex>
    </Card>
  );
}

/* ------------------------------------------------------ pending requests */

function PendingRequestCard({ request, now }: { request: PendingAuthorityRequest; now: number }) {
  const meta = request.domain ? DOMAIN_META[request.domain] : null;
  return (
    <Card
      size="2"
      style={{
        background: "var(--amber-a2)",
        boxShadow: "inset 0 0 0 1px var(--amber-a6)",
      }}
    >
      <Flex align="start" gap="3">
        {meta ? (
          <DomainGlyph domain={request.domain as DomainId} size={30} />
        ) : (
          <Glyph icon={Hourglass} accent="amber" size={30} />
        )}
        <Box style={{ minWidth: 0, flexGrow: 1 }}>
          <Text as="div" size="2" weight="medium" style={{ wordBreak: "break-word" }}>
            {request.action}
          </Text>
          {request.resource ? (
            <Text as="div" size="1" color="gray" style={{ wordBreak: "break-word" }}>
              {request.resource}
            </Text>
          ) : null}
          <Flex align="center" gap="2" mt="2" wrap="wrap">
            <Badge variant="soft" color="amber" size="1">
              <Bot size={11} />
              {request.requesterLabel}
            </Badge>
            <TierChip tier={request.tier} />
            {request.verb ? <VerbChip verb={request.verb} /> : null}
            <Flex align="center" gap="1">
              <Clock3 size={11} aria-hidden />
              <TimeAgo value={request.requestedAt} now={now} />
            </Flex>
          </Flex>
        </Box>
      </Flex>
      <Text as="div" size="1" color="gray" mt="2">
        Decide this where it was asked — in the approval bar, or on your phone. It stays paused
        until you do.
      </Text>
    </Card>
  );
}

/* -------------------------------------------------------- saved grants */

const GRANT_KIND_META: Record<
  SavedPermissionGrant["kind"],
  { label: string; color: "blue" | "green" | "purple"; icon: LucideIcon }
> = {
  capability: { label: "System capability", color: "blue", icon: Wrench },
  "browser-site": { label: "Website permission", color: "green", icon: Globe },
  "credential-use": { label: "Account use", color: "purple", icon: KeyRound },
};

function GrantCard({
  grant,
  open,
  onToggle,
  revoking,
  onRevoke,
  now,
}: {
  grant: SavedPermissionGrant;
  open: boolean;
  onToggle(): void;
  revoking: boolean;
  onRevoke(): void;
  now: number;
}) {
  const kind = GRANT_KIND_META[grant.kind];
  const expired = grant.expiresAt !== undefined && grant.expiresAt <= now;
  const stale =
    grant.lastUsedAt === undefined &&
    grant.grantedAt !== undefined &&
    now - grant.grantedAt > 60 * 24 * 60 * 60 * 1000;
  return (
    <Card size="2">
      <Disclosure
        open={open}
        onToggle={onToggle}
        summary={
          <Flex align="center" gap="3" style={{ minWidth: 0 }}>
            <Glyph
              icon={kind.icon}
              accent={kind.color === "blue" ? "blue" : kind.color === "green" ? "grass" : "purple"}
              size={28}
            />
            <Box style={{ minWidth: 0 }}>
              <Flex align="center" gap="2" wrap="wrap">
                <Text size="2" weight="medium" style={{ wordBreak: "break-word" }}>
                  {grant.capability ?? grant.scopeLabel}
                </Text>
                {expired ? (
                  <Badge color="red" variant="soft" size="1">
                    <CircleX size={11} /> Expired
                  </Badge>
                ) : null}
                {stale ? (
                  <Tooltip content="Granted a while ago and never used since">
                    <Badge color="gray" variant="soft" size="1">
                      <Clock3 size={11} /> Never used
                    </Badge>
                  </Tooltip>
                ) : null}
              </Flex>
              <Text as="div" size="1" color="gray" style={{ wordBreak: "break-word" }}>
                {grant.resource ?? grant.scopeLabel}
              </Text>
              <Flex align="center" gap="2" mt="1" wrap="wrap">
                <Badge color={kind.color} variant="soft" size="1">
                  {kind.label}
                </Badge>
                <Flex align="center" gap="1">
                  <Text size="1" color="gray">
                    granted
                  </Text>
                  <TimeAgo value={grant.grantedAt} now={now} />
                </Flex>
                {grant.lastUsedAt ? (
                  <Flex align="center" gap="1">
                    <Text size="1" color="gray">
                      · used
                    </Text>
                    <TimeAgo value={grant.lastUsedAt} now={now} />
                  </Flex>
                ) : null}
              </Flex>
            </Box>
          </Flex>
        }
        trailing={
          <ConfirmAction
            trigger={
              <Button size="1" color="red" variant="soft" disabled={revoking}>
                {revoking ? <Spinner size="1" /> : <Trash2 size={13} />}
                {revoking ? "Revoking…" : "Revoke"}
              </Button>
            }
            title="Revoke this permission?"
            description={grant.revokeEffect}
            confirmLabel="Revoke"
            onConfirm={onRevoke}
          />
        }
      >
        <DataList.Root size="1" orientation={{ initial: "vertical", sm: "horizontal" }}>
          <DataList.Item>
            <DataList.Label minWidth="120px">What it allows</DataList.Label>
            <DataList.Value>
              {[grant.capability, grant.resource].filter(Boolean).join(" · ") || grant.scopeLabel}
            </DataList.Value>
          </DataList.Item>
          <DataList.Item>
            <DataList.Label minWidth="120px">Why it exists</DataList.Label>
            <DataList.Value>{grant.why}</DataList.Value>
          </DataList.Item>
          {/* §7.7: which decision this arrived with. Without it a permission
              minted by a review is indistinguishable from one the person
              answered a prompt for, and this screen is where an install-time
              choice is meant to be revisited in both directions. */}
          {grant.origin ? (
            <DataList.Item>
              <DataList.Label minWidth="120px">Where it came from</DataList.Label>
              <DataList.Value>{grant.origin}</DataList.Value>
            </DataList.Item>
          ) : null}
          <DataList.Item>
            <DataList.Label minWidth="120px">Approved by</DataList.Label>
            <DataList.Value>{grant.approvedBy}</DataList.Value>
          </DataList.Item>
          <DataList.Item>
            <DataList.Label minWidth="120px">How long</DataList.Label>
            <DataList.Value>{grant.duration}</DataList.Value>
          </DataList.Item>
          <DataList.Item>
            <DataList.Label minWidth="120px">If you revoke it</DataList.Label>
            <DataList.Value>{grant.revokeEffect}</DataList.Value>
          </DataList.Item>
          {grant.expiresAt ? (
            <DataList.Item>
              <DataList.Label minWidth="120px">Expires</DataList.Label>
              <DataList.Value>{absoluteLabel(grant.expiresAt)}</DataList.Value>
            </DataList.Item>
          ) : null}
          {/* The part, never its effective version. That value is a 64-character
              content hash: it is the right key for the grant and the wrong thing
              to put in front of a person, who cannot compare two of them and
              gains nothing from either (§7.6.3). */}
          {grant.repoPath ? (
            <DataList.Item>
              <DataList.Label minWidth="120px">Part</DataList.Label>
              <DataList.Value>
                <Text size="1" style={{ fontFamily: "var(--code-font-family)" }}>
                  {grant.repoPath}
                </Text>
              </DataList.Value>
            </DataList.Item>
          ) : null}
        </DataList.Root>
      </Disclosure>
    </Card>
  );
}

/* ----------------------------------------------------------- agent view */

function ProfileItemRow({
  item,
  open,
  onToggle,
  busy,
  onChange,
  now,
}: {
  item: ProfileItem;
  open: boolean;
  onToggle(): void;
  busy: boolean;
  onChange(request: Record<string, unknown>): void;
  now: number;
}) {
  const action =
    item.kind === "lock" ? "unlock" : item.state === "suspended" ? "restore-grant" : "revoke-grant";
  const label =
    item.kind === "lock" ? "Allow asking" : item.state === "suspended" ? "Restore" : "Remove";
  return (
    <Disclosure
      open={open}
      onToggle={onToggle}
      summary={
        <Flex align="center" gap="2" wrap="wrap" style={{ minWidth: 0 }}>
          {item.kind === "lock" ? (
            <Ban size={13} color="var(--red-11)" aria-hidden />
          ) : item.state === "suspended" ? (
            <Clock3 size={13} color="var(--gray-11)" aria-hidden />
          ) : (
            <CircleCheck size={13} color="var(--grass-11)" aria-hidden />
          )}
          <Text size="2" style={{ wordBreak: "break-word" }}>
            {item.action}
            {item.resource ? <Text color="gray"> — {item.resource}</Text> : null}
          </Text>
          {item.state === "suspended" ? (
            <Badge color="gray" variant="soft" size="1">
              Paused after 3 months unused
            </Badge>
          ) : null}
          {item.kind === "lock" && item.attemptCount ? (
            <Badge color="red" variant="soft" size="1">
              {item.attemptCount} blocked attempt{item.attemptCount === 1 ? "" : "s"}
            </Badge>
          ) : null}
        </Flex>
      }
      trailing={
        <ConfirmAction
          trigger={
            <Button
              size="1"
              variant="soft"
              color={item.kind === "lock" ? "gray" : "red"}
              disabled={busy}
            >
              {busy ? (
                <Spinner size="1" />
              ) : item.kind === "lock" ? (
                <LockOpen size={13} />
              ) : item.state === "suspended" ? (
                <RotateCcw size={13} />
              ) : (
                <Trash2 size={13} />
              )}
              {label}
            </Button>
          }
          title={
            item.kind === "lock"
              ? "Let this be asked again?"
              : item.state === "suspended"
                ? "Restore this permission?"
                : "Remove this permission?"
          }
          description={item.revokeEffect}
          confirmLabel={label}
          tone={item.kind === "lock" ? "gray" : "red"}
          onConfirm={() => onChange({ action, id: item.id })}
        />
      }
    >
      <DataList.Root size="1" orientation={{ initial: "vertical", sm: "horizontal" }}>
        <DataList.Item>
          <DataList.Label minWidth="120px">Why it exists</DataList.Label>
          <DataList.Value>{item.why}</DataList.Value>
        </DataList.Item>
        <DataList.Item>
          <DataList.Label minWidth="120px">Approved by</DataList.Label>
          <DataList.Value>{item.approvedBy}</DataList.Value>
        </DataList.Item>
        <DataList.Item>
          <DataList.Label minWidth="120px">How long</DataList.Label>
          <DataList.Value>{item.duration}</DataList.Value>
        </DataList.Item>
        <DataList.Item>
          <DataList.Label minWidth="120px">If you change it</DataList.Label>
          <DataList.Value>{item.revokeEffect}</DataList.Value>
        </DataList.Item>
        <DataList.Item>
          <DataList.Label minWidth="120px">Decided</DataList.Label>
          <DataList.Value>
            <TimeAgo value={item.decidedAt} now={now} />
          </DataList.Value>
        </DataList.Item>
        {item.lastUsedAt ? (
          <DataList.Item>
            <DataList.Label minWidth="120px">Last used</DataList.Label>
            <DataList.Value>
              <TimeAgo value={item.lastUsedAt} now={now} />
            </DataList.Value>
          </DataList.Item>
        ) : null}
        {item.lastAttemptAt ? (
          <DataList.Item>
            <DataList.Label minWidth="120px">Last blocked</DataList.Label>
            <DataList.Value>
              <TimeAgo value={item.lastAttemptAt} now={now} />
            </DataList.Value>
          </DataList.Item>
        ) : null}
      </DataList.Root>
    </Disclosure>
  );
}

/**
 * The domain × verb matrix for one agent.
 *
 * Areas with nothing saved collapse into a single "asks first everywhere else"
 * line rather than eight empty rows: the interesting thing about an agent is
 * where it has standing access, and eight rows of "Asks first" bury it.
 */
function ProfileCard({
  profile,
  changingId,
  onChange,
  openItems,
  onToggleItem,
  now,
}: {
  profile: AgentAuthorityProfile;
  changingId: string | null;
  onChange(request: Record<string, unknown>): void;
  openItems: Set<string>;
  onToggleItem(id: string): void;
  now: number;
}) {
  const byDomain = useMemo(
    () =>
      DOMAIN_IDS.map((domain) => {
        const cells = profile.cells.filter((cell) => cell.domain === domain);
        const items = cells.flatMap((cell) => cell.items);
        const notable = cells.some(
          (cell) => cell.state === "allowed" || cell.state === "never" || cell.items.length > 0
        );
        return { domain, cells, items, notable };
      }),
    [profile]
  );
  const quiet = byDomain.filter((entry) => !entry.notable);
  const busy = changingId === profile.bindingId;
  return (
    <Card size="3">
      <Flex direction="column" gap="4">
        <Flex align="start" justify="between" gap="3" wrap="wrap">
          <Flex align="start" gap="3" style={{ minWidth: 0 }}>
            <Glyph
              icon={Bot}
              accent={profile.paused ? "gray" : "violet"}
              size={40}
              emphasis={profile.paused ? "soft" : "solid"}
            />
            <Box style={{ minWidth: 0 }}>
              <Flex align="center" gap="2" wrap="wrap">
                <Heading size="4">{profile.name}</Heading>
                {profile.paused ? (
                  <Badge color="red" variant="solid" size="1">
                    <Pause size={11} /> Paused
                  </Badge>
                ) : null}
              </Flex>
              <Text as="div" size="2" color="gray">
                {profile.summary}
              </Text>
            </Box>
          </Flex>
          <Flex gap="2" wrap="wrap">
            {profile.paused ? (
              <Button
                variant="soft"
                color="grass"
                disabled={busy}
                onClick={() => onChange({ action: "resume-agent", bindingId: profile.bindingId })}
              >
                {busy ? <Spinner size="1" /> : <Play size={14} />} Resume
              </Button>
            ) : (
              <ConfirmAction
                trigger={
                  <Button variant="soft" disabled={busy}>
                    {busy ? <Spinner size="1" /> : <Pause size={14} />} Pause agent
                  </Button>
                }
                title={`Pause ${profile.name}?`}
                description="Pausing stops work in progress and blocks new protected actions. Saved permissions stay; the agent simply cannot use them until you resume it."
                confirmLabel="Pause agent"
                tone="gray"
                onConfirm={() => onChange({ action: "pause-agent", bindingId: profile.bindingId })}
              />
            )}
            <ConfirmAction
              trigger={
                <Button color="red" variant="soft" disabled={busy}>
                  <RotateCcw size={14} /> Revoke all
                </Button>
              }
              title={`Revoke everything ${profile.name} was allowed?`}
              description="Every lasting permission you granted this agent is removed and its active protected work is stopped. Your “never” choices stay in place. Its installed code still cannot exceed the abilities you reviewed."
              confirmLabel="Revoke all authority"
              onConfirm={() =>
                onChange({ action: "revoke-all-agent", bindingId: profile.bindingId })
              }
            />
          </Flex>
        </Flex>

        <Flex direction="column" gap="3">
          {byDomain
            .filter((entry) => entry.notable)
            .map(({ domain, cells, items }) => (
              <Card key={domain} variant="surface">
                <Flex direction="column" gap="2">
                  <Flex align="center" justify="between" gap="3" wrap="wrap">
                    <Flex align="center" gap="2" style={{ minWidth: 0 }}>
                      <DomainGlyph domain={domain} size={26} />
                      <Text size="2" weight="medium">
                        {DOMAIN_META[domain].label}
                      </Text>
                    </Flex>
                    <Flex gap="1" wrap="wrap">
                      {cells.map((cell) => {
                        const state = CELL_META[cell.state];
                        return (
                          <Tooltip
                            key={cell.verb}
                            content={`${VERB_META[cell.verb].label}: permission to ${VERB_META[cell.verb].gloss} — ${state.label.toLowerCase()}`}
                          >
                            <Badge
                              color={state.color}
                              variant={cell.state === "asks-first" ? "outline" : "soft"}
                              size="1"
                            >
                              <state.icon size={11} />
                              {VERB_META[cell.verb].label}
                              {cell.state === "allowed" ? ` · ${cell.allowanceCount}` : ""}
                            </Badge>
                          </Tooltip>
                        );
                      })}
                    </Flex>
                  </Flex>
                  {items.length > 0 ? (
                    <Flex direction="column" gap="2" mt="1">
                      {items.map((item) => (
                        <ProfileItemRow
                          key={`${item.kind}:${item.id}`}
                          item={item}
                          open={openItems.has(item.id)}
                          onToggle={() => onToggleItem(item.id)}
                          busy={changingId === item.id}
                          onChange={onChange}
                          now={now}
                        />
                      ))}
                    </Flex>
                  ) : null}
                </Flex>
              </Card>
            ))}
          {quiet.length > 0 ? (
            <Flex align="center" gap="2">
              <Hand size={13} color="var(--gray-9)" aria-hidden />
              <Text size="1" color="gray">
                Asks first in {quiet.map((entry) => DOMAIN_META[entry.domain].short).join(", ")}.
              </Text>
            </Flex>
          ) : null}
        </Flex>
      </Flex>
    </Card>
  );
}

/* ------------------------------------------------------------ catalogue */

function unitGroup(unit: BuildUnitCatalogEntry): keyof typeof UNIT_KIND_META {
  if (unit.kind === "worker") return unit.isAgent ? "agent" : "worker";
  return unit.kind;
}

const UNIT_STATUS_META: Record<
  BuildUnitCatalogEntry["status"],
  { label: string; color: "green" | "amber" | "red" | "gray" | "blue" }
> = {
  ready: { label: "Ready", color: "green" },
  available: { label: "Available", color: "gray" },
  building: { label: "Building", color: "blue" },
  "approval-required": { label: "Needs your review", color: "amber" },
  error: { label: "Error", color: "red" },
};

function UnitCard({
  unit,
  profile,
  open,
  onToggle,
  now,
}: {
  unit: BuildUnitCatalogEntry;
  profile?: AgentAuthorityProfile;
  open: boolean;
  onToggle(): void;
  now: number;
}) {
  const group = UNIT_KIND_META[unitGroup(unit)];
  const status = UNIT_STATUS_META[unit.status];
  const criticalCount = unit.authorityRows.filter((row) => row.tier === "critical").length;
  const domains = useMemo(
    () => [...new Set(unit.authorityRows.map((row) => row.domain))],
    [unit.authorityRows]
  );
  return (
    <Card size="2">
      <Disclosure
        open={open}
        onToggle={onToggle}
        summary={
          <Flex align="center" gap="3" style={{ minWidth: 0 }}>
            <Glyph icon={group.icon} accent={unit.isAgent ? "violet" : "gray"} size={30} />
            <Box style={{ minWidth: 0 }}>
              <Flex align="center" gap="2" wrap="wrap">
                <Text size="2" weight="medium">
                  {unit.displayName || unit.name}
                </Text>
                <Badge color={status.color} variant="soft" size="1">
                  {status.label}
                </Badge>
                {unit.pendingApproval ? (
                  <Badge color="amber" variant="solid" size="1">
                    <Hourglass size={11} /> Review pending
                  </Badge>
                ) : null}
              </Flex>
              <Flex align="center" gap="2" mt="1" wrap="wrap">
                {domains.length > 0 ? (
                  domains.map((domain) => (
                    <Tooltip key={domain} content={DOMAIN_META[domain].label}>
                      <Badge variant="soft" color="gray" size="1">
                        <DomainGlyph domain={domain} size={13} />
                        {DOMAIN_META[domain].short}
                      </Badge>
                    </Tooltip>
                  ))
                ) : (
                  <Text size="1" color="gray">
                    No protected access
                  </Text>
                )}
                {criticalCount > 0 ? (
                  <Badge color="amber" variant="outline" size="1">
                    <TriangleAlert size={11} /> {criticalCount} always asks
                  </Badge>
                ) : null}
              </Flex>
            </Box>
          </Flex>
        }
      >
        <Flex direction="column" gap="3">
          <Text size="1" color="gray">
            {group.blurb}
          </Text>
          {unit.lastError ? (
            <Callout.Root color="red" size="1">
              <Callout.Icon>
                <TriangleAlert size={15} />
              </Callout.Icon>
              <Callout.Text>{unit.lastError}</Callout.Text>
            </Callout.Root>
          ) : null}
          <DataList.Root size="1" orientation={{ initial: "vertical", sm: "horizontal" }}>
            <DataList.Item>
              <DataList.Label minWidth="120px">Kind</DataList.Label>
              <DataList.Value>
                {group.singular}
                {unit.target ? ` · runs on ${unit.target}` : ""}
              </DataList.Value>
            </DataList.Item>
            <DataList.Item>
              <DataList.Label minWidth="120px">Source</DataList.Label>
              <DataList.Value>
                <Text
                  size="1"
                  style={{ fontFamily: "var(--code-font-family)", wordBreak: "break-all" }}
                >
                  {unit.source}
                </Text>
              </DataList.Value>
            </DataList.Item>
            {unit.pendingApproval ? (
              <DataList.Item>
                <DataList.Label minWidth="120px">Waiting since</DataList.Label>
                <DataList.Value>
                  <TimeAgo value={unit.pendingApproval.submittedAt} now={now} />
                </DataList.Value>
              </DataList.Item>
            ) : null}
            {unit.effectiveVersion ? (
              <DataList.Item>
                <DataList.Label minWidth="120px">Exact version</DataList.Label>
                <DataList.Value>
                  <Text
                    size="1"
                    color="gray"
                    style={{ fontFamily: "var(--code-font-family)", wordBreak: "break-all" }}
                  >
                    {unit.effectiveVersion}
                  </Text>
                </DataList.Value>
              </DataList.Item>
            ) : null}
          </DataList.Root>

          <Separator size="4" />
          <Text as="div" size="1" weight="bold" color="gray">
            What this {group.singular} declares it can do
          </Text>
          {unit.authorityRows.length === 0 ? (
            <Text size="2" color="gray">
              This version declares no protected host access.
            </Text>
          ) : (
            <Flex direction="column" gap="3">
              {DOMAIN_IDS.map((domain) => {
                const rows = unit.authorityRows.filter((row) => row.domain === domain);
                if (rows.length === 0) return null;
                return (
                  <Box key={domain}>
                    <Flex align="center" gap="2" mb="1">
                      <DomainGlyph domain={domain} size={22} />
                      <Text size="1" weight="bold">
                        {DOMAIN_META[domain].label}
                      </Text>
                    </Flex>
                    <Flex direction="column" gap="1" pl="1">
                      {rows.map((row) => (
                        <Flex
                          key={`${row.capability}:${row.resource}`}
                          align="center"
                          gap="2"
                          wrap="wrap"
                        >
                          <Text size="2">
                            {row.action}
                            {row.resource ? <Text color="gray"> — {row.resource}</Text> : null}
                          </Text>
                          <VerbChip verb={row.verb} />
                          {row.tier === "critical" ? <TierChip tier="critical" /> : null}
                        </Flex>
                      ))}
                    </Flex>
                  </Box>
                );
              })}
            </Flex>
          )}
          {unit.isAgent && profile ? (
            <>
              <Separator size="4" />
              <Box>
                <Text as="div" size="1" weight="bold" color="gray">
                  Permissions you chose for this agent
                </Text>
                <Text as="div" size="2" color="gray" mt="1">
                  {profile.summary}
                </Text>
              </Box>
            </>
          ) : null}
        </Flex>
      </Disclosure>
    </Card>
  );
}

/* ------------------------------------------------------------ area view */

function AreaView({
  domain,
  profiles,
  units,
  changingId,
  onChange,
  openItems,
  onToggleItem,
  now,
}: {
  domain: DomainId;
  profiles: AgentAuthorityProfile[];
  units: BuildUnitCatalogEntry[];
  changingId: string | null;
  onChange(request: Record<string, unknown>): void;
  openItems: Set<string>;
  onToggleItem(id: string): void;
  now: number;
}) {
  const meta = DOMAIN_META[domain];
  const visible = profiles
    .map((profile) => ({
      profile,
      cells: profile.cells.filter(
        (cell) =>
          cell.domain === domain &&
          (cell.state !== "asks-first" || cell.items.length > 0 || domain === "safety")
      ),
    }))
    .filter(({ cells }) => cells.length > 0);
  const declaring = units.filter((unit) => unit.authorityRows.some((row) => row.domain === domain));
  return (
    <Flex direction="column" gap="3">
      <Card size="3" style={{ background: `var(--${meta.accent}-a2)` }}>
        <Flex align="start" gap="3">
          <DomainGlyph domain={domain} size={40} />
          <Box>
            <Heading size="4">{meta.label}</Heading>
            <Text as="p" size="2" color="gray" mt="1">
              {meta.description}
            </Text>
            <Text as="p" size="1" color="gray" mt="2">
              “Asks first” means nothing lasting is stored — you are asked each time. “Never” stops
              the request without asking you at all.
            </Text>
          </Box>
        </Flex>
      </Card>

      <SectionHeading
        icon={Bot}
        accent="violet"
        title="Agents with a saved choice here"
        description="Standing permissions and lasting “never” answers"
      />
      {visible.length === 0 ? (
        <Card size="2">
          <EmptyState
            icon={<Hand size={26} />}
            title="Everyone asks first"
            description="No agent has a lasting permission or “never” choice in this area."
          />
        </Card>
      ) : (
        visible.map(({ profile, cells }) => (
          <Card key={profile.bindingId} size="2">
            <Flex direction="column" gap="3">
              <Flex align="center" justify="between" gap="3" wrap="wrap">
                <Flex align="center" gap="2">
                  <Glyph icon={Bot} accent="violet" size={26} />
                  <Heading size="3">{profile.name}</Heading>
                </Flex>
                <Flex gap="1" wrap="wrap">
                  {cells.map((cell) => {
                    const state = CELL_META[cell.state];
                    return (
                      <Badge
                        key={cell.verb}
                        color={state.color}
                        variant={cell.state === "asks-first" ? "outline" : "soft"}
                        size="1"
                      >
                        <state.icon size={11} />
                        {VERB_META[cell.verb].label} · {state.label}
                        {cell.state === "allowed" ? ` (${cell.allowanceCount})` : ""}
                      </Badge>
                    );
                  })}
                </Flex>
              </Flex>
              {cells.flatMap((cell) => cell.items).length > 0 ? (
                <Flex direction="column" gap="2">
                  {cells
                    .flatMap((cell) => cell.items)
                    .map((item) => (
                      <ProfileItemRow
                        key={`${item.kind}:${item.id}`}
                        item={item}
                        open={openItems.has(item.id)}
                        onToggle={() => onToggleItem(item.id)}
                        busy={changingId === item.id}
                        onChange={onChange}
                        now={now}
                      />
                    ))}
                </Flex>
              ) : null}
            </Flex>
          </Card>
        ))
      )}

      {declaring.length > 0 ? (
        <>
          <SectionHeading
            icon={Package}
            accent="gray"
            title="Built-in access declared here"
            description="Abilities a part's developer declared and you reviewed when it was installed"
          />
          {declaring.map((unit) => (
            <Card key={`${unit.kind}:${unit.name}`} size="2">
              <Flex align="start" gap="3">
                <Glyph icon={UNIT_KIND_META[unitGroup(unit)].icon} accent="gray" size={26} />
                <Box style={{ minWidth: 0 }}>
                  <Text as="div" size="2" weight="medium">
                    {unit.displayName || unit.name}
                  </Text>
                  <Flex direction="column" gap="1" mt="1">
                    {unit.authorityRows
                      .filter((row) => row.domain === domain)
                      .map((row) => (
                        <Flex
                          key={`${row.capability}:${row.resource}`}
                          align="center"
                          gap="2"
                          wrap="wrap"
                        >
                          <Text size="2">
                            {row.action}
                            {row.resource ? <Text color="gray"> — {row.resource}</Text> : null}
                          </Text>
                          {row.tier === "critical" ? <TierChip tier="critical" /> : null}
                        </Flex>
                      ))}
                  </Flex>
                </Box>
              </Flex>
            </Card>
          ))}
        </>
      ) : null}
    </Flex>
  );
}

/* -------------------------------------------------------------- activity */

function ApprovalRow({ record, now }: { record: ApprovalDecisionRecord; now: number }) {
  const target =
    record.resource?.value ??
    record.resource?.key ??
    record.resource?.capability ??
    record.requestedBy.callerId;
  const via = record.resolvedVia ? RESOLVED_VIA_META[record.resolvedVia] : undefined;
  return (
    <Flex align="start" gap="3">
      <Glyph
        icon={record.granted ? CircleCheck : CircleX}
        accent={record.granted ? "grass" : "red"}
        size={28}
      />
      <Box style={{ minWidth: 0, flexGrow: 1 }}>
        <Flex align="center" gap="2" wrap="wrap">
          <Text size="2" weight="medium">
            {record.granted ? "Allowed" : "Did not allow"}
          </Text>
          <Text size="2" color="gray" style={{ wordBreak: "break-word" }}>
            {target}
          </Text>
          <Badge variant="soft" color="gray" size="1">
            {record.approvalKind}
          </Badge>
          {record.grantScopeStored ? (
            <Tooltip content="How long this answer was saved for">
              <Badge variant="outline" color="gray" size="1">
                saved for {record.grantScopeStored}
              </Badge>
            </Tooltip>
          ) : null}
        </Flex>
        <Flex align="center" gap="2" mt="1" wrap="wrap">
          <Text size="1" color="gray">
            asked by {record.requestedBy.repoPath ?? record.requestedBy.callerId}
          </Text>
          <Text size="1" color="gray">
            · answered by {record.resolvedBy.handle}
          </Text>
          {via ? (
            <Flex align="center" gap="1">
              <via.icon size={11} aria-hidden />
              <Text size="1" color="gray">
                {via.label}
              </Text>
            </Flex>
          ) : null}
          <TimeAgo value={record.resolvedAt} now={now} />
        </Flex>
      </Box>
    </Flex>
  );
}

function MembershipRow({ record, now }: { record: MembershipRecord; now: number }) {
  const meta = MEMBERSHIP_META[record.op];
  return (
    <Flex align="start" gap="3">
      <Glyph icon={meta.icon} accent={meta.color === "green" ? "grass" : meta.color} size={28} />
      <Box style={{ minWidth: 0, flexGrow: 1 }}>
        <Text as="div" size="2">
          <strong>{record.actor.handle}</strong> {meta.label}{" "}
          <strong>{record.target.handle ?? record.target.userId}</strong>
          {record.role ? ` (${record.role})` : ""}
        </Text>
        <Flex align="center" gap="2" mt="1">
          <Badge variant="soft" color="gray" size="1">
            <Users size={11} /> Membership
          </Badge>
          <TimeAgo value={record.at} now={now} />
        </Flex>
      </Box>
    </Flex>
  );
}

/** A day-grouped timeline. Grouping is what makes a long log skimmable. */
function ActivityTimeline({ records, now }: { records: GovernanceRecord[]; now: number }) {
  const days = useMemo(() => {
    const groups = new Map<string, GovernanceRecord[]>();
    for (const record of records) {
      const key = DAY_HEADING.format(recordTimestamp(record));
      const existing = groups.get(key);
      if (existing) existing.push(record);
      else groups.set(key, [record]);
    }
    return [...groups.entries()];
  }, [records]);
  return (
    <Flex direction="column" gap="4">
      {days.map(([day, entries]) => (
        <Box key={day}>
          <Flex align="center" gap="2" mb="2">
            <Clock3 size={13} color="var(--gray-9)" aria-hidden />
            <Text size="1" weight="bold" color="gray">
              {day}
            </Text>
            <Box flexGrow="1">
              <Separator size="4" />
            </Box>
          </Flex>
          <Card size="2">
            <Flex direction="column" gap="3">
              {entries.map((record, index) => (
                <Box key={isMembership(record) ? `m:${record.at}:${index}` : record.approvalId}>
                  {index > 0 ? (
                    <Box mb="3">
                      <Separator size="4" />
                    </Box>
                  ) : null}
                  {isMembership(record) ? (
                    <MembershipRow record={record} now={now} />
                  ) : (
                    <ApprovalRow record={record} now={now} />
                  )}
                </Box>
              ))}
            </Flex>
          </Card>
        </Box>
      ))}
    </Flex>
  );
}

/* -------------------------------------------------------------- overview */

function OverviewView({
  pending,
  needsReview,
  suspended,
  locks,
  domainTotals,
  onGoTo,
  now,
}: {
  pending: PendingAuthorityRequest[];
  needsReview: BuildUnitCatalogEntry[];
  suspended: ProfileItem[];
  locks: ProfileItem[];
  domainTotals: Array<{ domain: DomainId; grants: number; agents: number; never: number }>;
  onGoTo(view: ViewId, domain?: DomainId): void;
  now: number;
}) {
  const quiet =
    pending.length === 0 &&
    needsReview.length === 0 &&
    suspended.length === 0 &&
    locks.length === 0;
  return (
    <Flex direction="column" gap="4">
      <Section>
        <Flex direction="column" gap="3">
          <SectionHeading
            icon={ListChecks}
            accent={quiet ? "grass" : "amber"}
            title="Needs your attention"
            description={
              quiet
                ? "Nothing is waiting and nothing is stuck."
                : "Decisions that are paused, stale, or blocking something."
            }
          />
          {quiet ? (
            <EmptyState
              icon={<ShieldCheck size={28} />}
              title="All clear"
              description="No requests are waiting, no part is unreviewed, and nothing has been blocked."
            />
          ) : (
            <Flex direction="column" gap="3">
              {pending.map((request) => (
                <PendingRequestCard key={request.acquisitionId} request={request} now={now} />
              ))}
              {needsReview.map((unit) => (
                <Card key={`review:${unit.kind}:${unit.name}`} size="2">
                  <Flex align="center" justify="between" gap="3" wrap="wrap">
                    <Flex align="center" gap="3" style={{ minWidth: 0 }}>
                      <Glyph icon={Hourglass} accent="amber" size={28} />
                      <Box style={{ minWidth: 0 }}>
                        <Text as="div" size="2" weight="medium">
                          {unit.displayName || unit.name} is waiting to be reviewed
                        </Text>
                        <Text as="div" size="1" color="gray">
                          It cannot run until you look at what it asks for.
                        </Text>
                      </Box>
                    </Flex>
                    <Button size="1" variant="soft" onClick={() => onGoTo("catalog")}>
                      See what it asks for <ArrowRight size={13} />
                    </Button>
                  </Flex>
                </Card>
              ))}
              {suspended.length > 0 ? (
                <Card size="2">
                  <Flex align="center" justify="between" gap="3" wrap="wrap">
                    <Flex align="center" gap="3" style={{ minWidth: 0 }}>
                      <Glyph icon={Clock3} accent="gray" size={28} />
                      <Box style={{ minWidth: 0 }}>
                        <Text as="div" size="2" weight="medium">
                          {suspended.length} permission{suspended.length === 1 ? " was" : "s were"}{" "}
                          paused for going unused
                        </Text>
                        <Text as="div" size="1" color="gray">
                          Nothing was lost — restore one if it is still wanted, or leave it paused.
                        </Text>
                      </Box>
                    </Flex>
                    <Button size="1" variant="soft" onClick={() => onGoTo("agents")}>
                      Review them <ArrowRight size={13} />
                    </Button>
                  </Flex>
                </Card>
              ) : null}
              {locks.filter((lock) => (lock.attemptCount ?? 0) > 0).length > 0 ? (
                <Card size="2">
                  <Flex align="center" justify="between" gap="3" wrap="wrap">
                    <Flex align="center" gap="3" style={{ minWidth: 0 }}>
                      <Glyph icon={Ban} accent="red" size={28} />
                      <Box style={{ minWidth: 0 }}>
                        <Text as="div" size="2" weight="medium">
                          Something kept trying an action you answered “never”
                        </Text>
                        <Text as="div" size="1" color="gray">
                          {locks
                            .filter((lock) => (lock.attemptCount ?? 0) > 0)
                            .map((lock) => `${lock.action} (${lock.attemptCount})`)
                            .join(", ")}
                        </Text>
                      </Box>
                    </Flex>
                    <Button size="1" variant="soft" onClick={() => onGoTo("agents")}>
                      Review “never” rules <ArrowRight size={13} />
                    </Button>
                  </Flex>
                </Card>
              ) : null}
            </Flex>
          )}
        </Flex>
      </Section>

      <Section>
        <Flex direction="column" gap="3">
          <SectionHeading
            icon={Layers}
            accent="indigo"
            title="Where access has been granted"
            description="Eight areas of your workspace. Open one to see every saved choice in it."
          />
          <Grid columns={{ initial: "1", xs: "2", md: "4" }} gap="3">
            {domainTotals.map(({ domain, grants, agents, never }) => {
              const meta = DOMAIN_META[domain];
              const quietArea = grants === 0 && agents === 0 && never === 0;
              return (
                <Card key={domain} asChild variant="surface">
                  <button
                    type="button"
                    onClick={() => onGoTo("areas", domain)}
                    aria-label={`${meta.label}: ${grants} saved, ${never} never`}
                    style={{ cursor: "pointer", textAlign: "left", width: "100%" }}
                  >
                    <Flex direction="column" gap="2">
                      <Flex align="center" gap="2">
                        <DomainGlyph domain={domain} size={28} />
                        <Text size="2" weight="medium">
                          {meta.short}
                        </Text>
                      </Flex>
                      <Text size="1" color="gray" style={{ minHeight: "2.4em" }}>
                        {meta.description}
                      </Text>
                      <Flex gap="1" wrap="wrap">
                        {quietArea ? (
                          <Badge variant="outline" color="gray" size="1">
                            <Hand size={11} /> Asks first
                          </Badge>
                        ) : (
                          <>
                            {grants > 0 ? (
                              <Badge color="green" variant="soft" size="1">
                                {grants} allowed
                              </Badge>
                            ) : null}
                            {never > 0 ? (
                              <Badge color="red" variant="soft" size="1">
                                {never} never
                              </Badge>
                            ) : null}
                            {agents > 0 ? (
                              <Badge color="violet" variant="soft" size="1">
                                {agents} agent{agents === 1 ? "" : "s"}
                              </Badge>
                            ) : null}
                          </>
                        )}
                      </Flex>
                    </Flex>
                  </button>
                </Card>
              );
            })}
          </Grid>
        </Flex>
      </Section>
    </Flex>
  );
}

/* ------------------------------------------------------------ the screen */

function matches(query: string, ...values: Array<string | undefined>): boolean {
  if (!query) return true;
  return values.some((value) => value?.toLowerCase().includes(query));
}

function PermissionsPage() {
  const [grants, setGrants] = useState<SavedPermissionGrant[]>([]);
  const [profiles, setProfiles] = useState<AgentAuthorityProfile[]>([]);
  const [units, setUnits] = useState<BuildUnitCatalogEntry[]>([]);
  const [records, setRecords] = useState<GovernanceRecord[]>([]);
  const [pending, setPending] = useState<PendingAuthorityRequest[]>([]);
  const [view, setView] = useState<ViewId>("overview");
  const [domain, setDomain] = useState<DomainId>("sharing");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const [safety, setSafety] = useState<AuthoritySafetyStatus>({
    workspaceLocked: false,
    activeAgentCount: 0,
    pendingAcquisitionCount: 0,
  });
  const [statusMessage, setStatusMessage] = useState("");
  // One clock per load, so every relative label on a render agrees with the
  // others. Recomputing per component would let two rows disagree by a tick.
  const [now, setNow] = useState(() => Date.now());

  const toggleOpen = useCallback((id: string) => {
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextGrants, nextProfiles, nextSafety, nextUnits, nextRecords, nextPending] =
        await Promise.all([
          rpc.call<SavedPermissionGrant[]>("main", "permissions.list", []),
          rpc.call<AgentAuthorityProfile[]>("main", "permissions.listAgentProfiles", []),
          rpc.call<AuthoritySafetyStatus>("main", "permissions.safetyStatus", []),
          rpc.call<BuildUnitCatalogEntry[]>("main", "build.listUnits", []),
          rpc.call<GovernanceRecord[]>("main", "governance.list", [{ limit: 200 }]),
          rpc.call<PendingAuthorityRequest[]>("main", "permissions.listPendingRequests", []),
        ]);
      setGrants(nextGrants);
      setProfiles(nextProfiles);
      setSafety(nextSafety);
      setUnits(nextUnits);
      setRecords(nextRecords);
      setPending(nextPending);
      setNow(Date.now());
      setInitialized(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const updateProfile = useCallback(async (request: Record<string, unknown>) => {
    const id = String(request["id"] ?? request["bindingId"] ?? "profile");
    setRevokingId(id);
    setError(null);
    try {
      await rpc.call("main", "permissions.updateAgentProfile", [request]);
      setProfiles(
        await rpc.call<AgentAuthorityProfile[]>("main", "permissions.listAgentProfiles", [])
      );
      setGrants(await rpc.call<SavedPermissionGrant[]>("main", "permissions.list", []));
      setSafety(await rpc.call<AuthoritySafetyStatus>("main", "permissions.safetyStatus", []));
      setPending(
        await rpc.call<PendingAuthorityRequest[]>("main", "permissions.listPendingRequests", [])
      );
      setNow(Date.now());
      setStatusMessage("Agent authority settings updated.");
    } catch (err) {
      setError(`Couldn't change this setting: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRevokingId(null);
    }
  }, []);

  const setWorkspaceLock = useCallback(
    async (locked: boolean) => {
      setRevokingId("workspace-authority-lock");
      setError(null);
      try {
        const next = await rpc.call<AuthoritySafetyStatus>(
          "main",
          "permissions.setWorkspaceAuthorityLock",
          [{ locked }]
        );
        setSafety(next);
        setStatusMessage(
          locked
            ? "Workspace authority locked. Active agent work was stopped."
            : "Workspace authority unlocked. Agents may work when asked."
        );
        await load();
      } catch (err) {
        setError(
          `Couldn't ${locked ? "lock" : "unlock"} workspace authority: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      } finally {
        setRevokingId(null);
      }
    },
    [load]
  );

  useEffect(() => {
    void load();
    return panel.onFocus(() => void load());
  }, [load]);

  const revoke = useCallback(async (grant: SavedPermissionGrant) => {
    setRevokingId(grant.id);
    setError(null);
    try {
      await rpc.call("main", "permissions.revoke", [{ kind: grant.kind, id: grant.id }]);
      setGrants((current) => current.filter((item) => item.id !== grant.id));
      setStatusMessage(`Revoked ${grant.capability ?? grant.scopeLabel}.`);
    } catch (err) {
      setError(
        `Couldn't revoke the permission: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setRevokingId(null);
    }
  }, []);

  const normalized = query.trim().toLowerCase();

  const profileItems = useMemo(
    () => profiles.flatMap((profile) => profile.cells.flatMap((cell) => cell.items)),
    [profiles]
  );
  const suspended = useMemo(
    () => profileItems.filter((item) => item.state === "suspended"),
    [profileItems]
  );
  const locks = useMemo(() => profileItems.filter((item) => item.kind === "lock"), [profileItems]);
  const needsReview = useMemo(
    () =>
      units.filter((unit) => unit.pendingApproval !== null || unit.status === "approval-required"),
    [units]
  );

  const domainTotals = useMemo(
    () =>
      DOMAIN_IDS.map((id) => {
        const cells = profiles.flatMap((profile) =>
          profile.cells.filter((cell) => cell.domain === id)
        );
        return {
          domain: id,
          grants: cells.reduce((total, cell) => total + cell.allowanceCount, 0),
          agents: profiles.filter((profile) =>
            profile.cells.some((cell) => cell.domain === id && cell.state === "allowed")
          ).length,
          never: cells.filter((cell) => cell.state === "never").length,
        };
      }),
    [profiles]
  );

  const visibleGrants = useMemo(
    () =>
      grants.filter((grant) =>
        matches(
          normalized,
          grant.callerLabel,
          grant.capability,
          grant.resource,
          grant.scopeLabel,
          grant.repoPath,
          grant.origin
        )
      ),
    [grants, normalized]
  );
  const grantsByCaller = useMemo(() => {
    const groups = new Map<string, SavedPermissionGrant[]>();
    for (const grant of visibleGrants) {
      const existing = groups.get(grant.callerLabel);
      if (existing) existing.push(grant);
      else groups.set(grant.callerLabel, [grant]);
    }
    return [...groups.entries()];
  }, [visibleGrants]);

  const visibleUnits = useMemo(
    () =>
      units.filter((unit) =>
        matches(
          normalized,
          unit.displayName,
          unit.name,
          unit.source,
          ...unit.authorityRows.map((row) => `${row.action} ${row.resource}`)
        )
      ),
    [units, normalized]
  );
  const visibleProfiles = useMemo(
    () =>
      profiles.filter((profile) =>
        matches(
          normalized,
          profile.name,
          profile.summary,
          ...profile.cells.flatMap((cell) =>
            cell.items.map((item) => `${item.action} ${item.resource ?? ""}`)
          )
        )
      ),
    [profiles, normalized]
  );
  const visibleRecords = useMemo(
    () =>
      records.filter((record) =>
        isMembership(record)
          ? matches(normalized, record.actor.handle, record.target.handle, record.op)
          : matches(
              normalized,
              record.approvalKind,
              record.decision,
              record.requestedBy.callerId,
              record.requestedBy.repoPath,
              record.resolvedBy.handle,
              record.resource?.value,
              record.resource?.key,
              record.resource?.capability
            )
      ),
    [records, normalized]
  );

  const goTo = useCallback((next: ViewId, nextDomain?: DomainId) => {
    if (nextDomain) setDomain(nextDomain);
    setView(next);
  }, []);

  const attentionCount =
    pending.length +
    needsReview.length +
    locks.filter((lock) => (lock.attemptCount ?? 0) > 0).length;

  return (
    <AboutPage
      icon={<ShieldCheck width={20} height={20} />}
      title="Permissions"
      // Deliberately stable: the counts live in the tiles below, and a subtitle
      // that changes on load is a readiness signal that races its own screen.
      subtitle="Lasting access you granted to apps and agents"
      maxWidth={980}
      actions={
        <Tooltip content="Refresh">
          <IconButton
            variant="soft"
            onClick={() => void load()}
            disabled={loading}
            aria-label="Refresh"
          >
            {loading ? <Spinner /> : <RefreshCw size={16} />}
          </IconButton>
        </Tooltip>
      }
    >
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clipPath: "inset(50%)",
        }}
      >
        {statusMessage}
      </div>

      <SafetyBanner
        safety={safety}
        busy={revokingId === "workspace-authority-lock"}
        onSetLock={(locked) => void setWorkspaceLock(locked)}
        now={now}
      />

      <Grid columns={{ initial: "2", sm: "3", md: "5" }} gap="3">
        <Metric
          icon={Lock}
          label="Lasting permissions"
          value={grants.length}
          accent="blue"
          hint="Access that has been saved, so it is not asked for again"
          onClick={() => goTo("saved")}
        />
        <Metric
          icon={Bot}
          label="Agents with choices"
          value={profiles.length}
          accent="violet"
          hint="Agents that have a standing permission or a lasting “never”"
          onClick={() => goTo("agents")}
        />
        <Metric
          icon={Ban}
          label="“Never” rules"
          value={locks.length}
          accent="red"
          hint="Requests that are stopped without asking you"
          onClick={() => goTo("agents")}
        />
        <Metric
          icon={Hourglass}
          label="Waiting on you"
          value={pending.length}
          accent="amber"
          urgent={pending.length > 0}
          hint="Protected actions paused until you decide"
          onClick={() => goTo("overview")}
        />
        <Metric
          icon={Package}
          label="Apps & agents"
          value={units.length}
          accent="gray"
          hint="Everything installed here that can declare protected access"
          onClick={() => goTo("catalog")}
        />
      </Grid>

      {error ? (
        <Callout.Root color="red" role="alert">
          <Callout.Icon>
            <TriangleAlert size={16} />
          </Callout.Icon>
          <Callout.Text>
            <Flex direction="column" gap="2" align="start">
              <Text>{error}</Text>
              <Button size="1" color="red" variant="soft" onClick={() => void load()}>
                Retry
              </Button>
            </Flex>
          </Callout.Text>
        </Callout.Root>
      ) : null}

      {loading && !initialized ? (
        <Flex
          justify="center"
          align="center"
          gap="2"
          py="6"
          role="status"
          aria-label="Loading permissions"
        >
          <Spinner />
          <Text color="gray">Loading saved permissions…</Text>
        </Flex>
      ) : (
        <Tabs.Root value={view} onValueChange={(value) => setView(value as ViewId)}>
          <Box style={{ maxWidth: "100%", overflowX: "auto" }}>
            <Tabs.List aria-label="Permission view">
              <Tabs.Trigger value="overview">
                <Flex align="center" gap="2">
                  <Sparkles size={14} /> Overview
                  {attentionCount > 0 ? (
                    <Badge color="amber" variant="solid" size="1">
                      {attentionCount}
                    </Badge>
                  ) : null}
                </Flex>
              </Tabs.Trigger>
              <Tabs.Trigger value="catalog">
                <Flex align="center" gap="2">
                  <Package size={14} /> Apps &amp; agents
                </Flex>
              </Tabs.Trigger>
              <Tabs.Trigger value="saved">
                <Flex align="center" gap="2">
                  <Lock size={14} /> Saved
                </Flex>
              </Tabs.Trigger>
              <Tabs.Trigger value="agents">
                <Flex align="center" gap="2">
                  <Bot size={14} /> Agents
                </Flex>
              </Tabs.Trigger>
              <Tabs.Trigger value="areas">
                <Flex align="center" gap="2">
                  <Layers size={14} /> By area
                </Flex>
              </Tabs.Trigger>
              <Tabs.Trigger value="activity">
                <Flex align="center" gap="2">
                  <Activity size={14} /> Activity
                </Flex>
              </Tabs.Trigger>
            </Tabs.List>
          </Box>

          {view === "overview" ? null : (
            <Box mt="3">
              <TextField.Root
                size="2"
                placeholder="Filter by app, agent, ability, or website…"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                aria-label="Filter permissions"
              >
                <TextField.Slot>
                  <Search size={14} />
                </TextField.Slot>
                {query ? (
                  <TextField.Slot>
                    <IconButton
                      size="1"
                      variant="ghost"
                      aria-label="Clear filter"
                      onClick={() => setQuery("")}
                    >
                      <CircleX size={14} />
                    </IconButton>
                  </TextField.Slot>
                ) : null}
              </TextField.Root>
            </Box>
          )}

          <Box mt="4">
            <Tabs.Content value="overview">
              <OverviewView
                pending={pending}
                needsReview={needsReview}
                suspended={suspended}
                locks={locks}
                domainTotals={domainTotals}
                onGoTo={goTo}
                now={now}
              />
            </Tabs.Content>

            <Tabs.Content value="catalog">
              <Flex direction="column" gap="4">
                {(["agent", "worker", "panel", "app", "extension"] as const).map((group) => {
                  const matching = visibleUnits.filter((unit) => unitGroup(unit) === group);
                  if (matching.length === 0) return null;
                  const meta = UNIT_KIND_META[group];
                  return (
                    <Flex key={group} direction="column" gap="2">
                      <SectionHeading
                        icon={meta.icon}
                        accent={group === "agent" ? "violet" : "gray"}
                        title={`${meta.plural} · ${matching.length}`}
                        description={meta.blurb}
                      />
                      {matching.map((unit) => (
                        <UnitCard
                          key={`${unit.kind}:${unit.name}`}
                          unit={unit}
                          profile={profiles.find(
                            (profile) =>
                              profile.name.toLowerCase() ===
                              (unit.displayName || unit.name).toLowerCase()
                          )}
                          open={openIds.has(`unit:${unit.kind}:${unit.name}`)}
                          onToggle={() => toggleOpen(`unit:${unit.kind}:${unit.name}`)}
                          now={now}
                        />
                      ))}
                    </Flex>
                  );
                })}
                {visibleUnits.length === 0 ? (
                  <Card size="2">
                    <EmptyState
                      icon={<Package size={26} />}
                      title={units.length === 0 ? "Nothing is installed yet" : "Nothing matches"}
                      description={
                        units.length === 0
                          ? "Apps, panels, and agents appear here as they are added to this workspace."
                          : "Try a different word, or clear the filter."
                      }
                    />
                  </Card>
                ) : null}
              </Flex>
            </Tabs.Content>

            <Tabs.Content value="saved">
              <Flex direction="column" gap="4">
                {grantsByCaller.map(([caller, callerGrants]) => (
                  <Flex key={caller} direction="column" gap="2">
                    <SectionHeading
                      icon={Gavel}
                      accent="blue"
                      title={caller}
                      description={`${callerGrants.length} lasting permission${callerGrants.length === 1 ? "" : "s"}`}
                    />
                    {callerGrants.map((grant) => (
                      <GrantCard
                        key={grant.id}
                        grant={grant}
                        open={openIds.has(`grant:${grant.id}`)}
                        onToggle={() => toggleOpen(`grant:${grant.id}`)}
                        revoking={revokingId === grant.id}
                        onRevoke={() => void revoke(grant)}
                        now={now}
                      />
                    ))}
                  </Flex>
                ))}
                {grantsByCaller.length === 0 ? (
                  <Card size="2">
                    <EmptyState
                      icon={<Hand size={26} />}
                      title={grants.length === 0 ? "Nothing has lasting access" : "Nothing matches"}
                      description={
                        grants.length === 0
                          ? "Every protected action is asked for each time. Answers you save will appear here."
                          : "Try a different word, or clear the filter."
                      }
                    />
                  </Card>
                ) : null}
              </Flex>
            </Tabs.Content>

            <Tabs.Content value="agents">
              <Flex direction="column" gap="3">
                {visibleProfiles.map((profile) => (
                  <ProfileCard
                    key={profile.bindingId}
                    profile={profile}
                    changingId={revokingId}
                    onChange={(request) => void updateProfile(request)}
                    openItems={openIds}
                    onToggleItem={toggleOpen}
                    now={now}
                  />
                ))}
                {visibleProfiles.length === 0 ? (
                  <Card size="2">
                    <EmptyState
                      icon={<Hand size={26} />}
                      title={profiles.length === 0 ? "Every agent asks first" : "No agent matches"}
                      description={
                        profiles.length === 0
                          ? "No agent has lasting permissions or “never” choices yet. Profiles appear here as you make those decisions."
                          : "Try a different word, or clear the filter."
                      }
                    />
                  </Card>
                ) : null}
              </Flex>
            </Tabs.Content>

            <Tabs.Content value="areas">
              <Flex direction="column" gap="4">
                <Grid columns={{ initial: "2", sm: "4", md: "8" }} gap="2">
                  {DOMAIN_IDS.map((id) => {
                    const meta = DOMAIN_META[id];
                    const selected = id === domain;
                    return (
                      <Card key={id} asChild variant={selected ? "classic" : "surface"}>
                        <button
                          type="button"
                          onClick={() => setDomain(id)}
                          aria-pressed={selected}
                          aria-label={meta.label}
                          style={{
                            cursor: "pointer",
                            width: "100%",
                            boxShadow: selected
                              ? `inset 0 0 0 2px var(--${meta.accent}-8)`
                              : undefined,
                          }}
                        >
                          <Flex direction="column" align="center" gap="1">
                            <DomainGlyph domain={id} size={30} />
                            <Text size="1" align="center">
                              {meta.short}
                            </Text>
                          </Flex>
                        </button>
                      </Card>
                    );
                  })}
                </Grid>
                <AreaView
                  domain={domain}
                  profiles={visibleProfiles}
                  units={visibleUnits}
                  changingId={revokingId}
                  onChange={(request) => void updateProfile(request)}
                  openItems={openIds}
                  onToggleItem={toggleOpen}
                  now={now}
                />
              </Flex>
            </Tabs.Content>

            <Tabs.Content value="activity">
              {visibleRecords.length > 0 ? (
                <ActivityTimeline records={visibleRecords} now={now} />
              ) : (
                <Card size="2">
                  <EmptyState
                    icon={<Activity size={26} />}
                    title={records.length === 0 ? "No decisions recorded yet" : "Nothing matches"}
                    description={
                      records.length === 0
                        ? "Every permission you answer, and every membership change, is recorded here."
                        : "Try a different word, or clear the filter."
                    }
                  />
                </Card>
              )}
            </Tabs.Content>
          </Box>
        </Tabs.Root>
      )}
    </AboutPage>
  );
}

export default function AboutPanelRoot() {
  return (
    <AboutThemeRoot>
      <PermissionsPage />
    </AboutThemeRoot>
  );
}
