/**
 * The Cowork surface, rendered — with a realistic catalogue, at a phone
 * width.
 *
 * Rendering goes through react-native-web, the shipped web target, the same
 * way `smoke.test.tsx` already proves the console does. Window width is pinned
 * through `rnw.ts`'s `useWindowDimensions` mock rather than `Dimensions.set`,
 * which RNW rejects once a DOM is present.
 */

import "./rnw.ts";
import { resetWindowSize, setWindowWidth } from "./rnw.ts";

import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
// Type-only, so it is erased before it can pull `react-native` in early.
import type { ConnectorSummary, SkillSummary, Task } from "../src/cowork/types.ts";

// Dynamic on purpose: bun loads a file's whole static import graph before any
// module body runs, so a static import here would pull the real `react-native`
// in before `./rnw.ts` could substitute it.
const { CoworkScreen } = await import("../src/screens/CoworkScreen.tsx");
const { ConnectorsView, PluginsView, SkillsView } = await import("../src/components/CoworkCatalogueViews.tsx");
const { reduceTasks, EMPTY_TASKS } = await import("../src/cowork/tasks.ts");

const NOW = Date.parse("2026-01-01T00:10:00.000Z");

afterEach(() => {
  resetWindowSize();
});

// ---------------------------------------------------------------------------
// A realistic catalogue: this machine has dozens of real skills and
// connectors, not three rows. Names are drawn from the actual plugin roster
// and MCP connector set this session has mounted.
// ---------------------------------------------------------------------------

const NATIVE_SKILLS = ["debug", "plan", "explain", "test", "optimize", "refactor"];

const MARKETPLACE_PLUGINS: Record<string, string[]> = {
  cld: ["ship", "review", "fix", "develop", "code-review", "commit-early-often"],
  "haiku-method": ["haiku-start", "haiku-pickup", "haiku-zap", "haiku-gate-review"],
  darkrun: ["darkrun-new", "darkrun-pickup", "darkrun-checkpoint"],
  "im-a-cto": ["writing-coach", "story-mine", "voice-builder"],
  phoneware: ["phoneware-billing", "phoneware-carrier", "phoneware-context"],
  xlsx: ["xlsx"],
  pdf: ["pdf"],
  docx: ["docx"],
  pptx: ["pptx"],
  "canvas-design": ["canvas-design"],
  "skill-creator": ["skill-creator"],
};

const LOCAL_SKILLS = ["scratch-workspace", "project-memory"];

const CONNECTED_CONNECTORS = [
  "advanced-gmail",
  "canva",
  "github",
  "notion",
  "fireflies",
  "home-assistant",
  "context7",
  "deepwiki",
  "reddit",
  "pubmed",
  "godaddy-domains",
  "twelvelabs-mcp",
];

const DOWN_CONNECTORS: Array<{ name: string; error: string }> = [
  { name: "netsapiens", error: "OAuth token expired 2026-01-01T00:00:00Z" },
  { name: "clerk-chat", error: "ECONNREFUSED 127.0.0.1:8443" },
  { name: "postiz", error: "" }, // no reason reported by the daemon
];

function skill(name: string, kind: "skill" | "command", providerName: string, pluginName?: string): SkillSummary {
  return {
    name,
    description: `Runs the ${name} workflow.`,
    kind,
    source: pluginName !== undefined ? "claude-plugins:project" : "native:native",
    providerName,
    level: pluginName !== undefined ? "project" : "native",
    pluginName,
  };
}

function buildSkills(): SkillSummary[] {
  const skills: SkillSummary[] = [];
  for (const name of NATIVE_SKILLS) skills.push(skill(name, "skill", "OMP"));
  for (const [pluginName, names] of Object.entries(MARKETPLACE_PLUGINS)) {
    for (const name of names) skills.push(skill(name, "skill", "Claude Code Marketplace", pluginName));
  }
  for (const name of LOCAL_SKILLS) skills.push(skill(name, "command", "Claude Code"));
  return skills;
}

function buildConnectors(): ConnectorSummary[] {
  const connectors: ConnectorSummary[] = CONNECTED_CONNECTORS.map((name) => ({
    name,
    connected: true,
    status: "connected" as const,
    providerName: "OMP Extension Packages",
    pluginName: name,
  }));
  for (const { name, error } of DOWN_CONNECTORS) {
    connectors.push({
      name,
      connected: false,
      status: "disconnected" as const,
      providerName: "OMP Extension Packages",
      pluginName: name,
      ...(error.length > 0 ? { error } : {}),
    });
  }
  return connectors;
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `task ${id}`,
    prompt: "do the thing",
    agentId: `agt_${id}`,
    state: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    labels: {},
    ...overrides,
  };
}

const SKILLS = buildSkills();
const CONNECTORS = buildConnectors();
const TASKS = reduceTasks(EMPTY_TASKS, {
  t: "load",
  tasks: [
    task("t1", { title: "Ship the Cowork surface", state: "running", updatedAt: "2026-01-01T00:09:00.000Z" }),
    task("t2", { title: "Waiting on approval", state: "waiting", updatedAt: "2026-01-01T00:08:00.000Z" }),
    task("t3", { title: "Fix the login bug", state: "done", updatedAt: "2026-01-01T00:07:00.000Z" }),
    task("t4", { title: "Failed deploy", state: "failed", updatedAt: "2026-01-01T00:06:00.000Z" }),
  ],
});

function renderAt(width: number): string {
  setWindowWidth(width);
  return renderToStaticMarkup(
    <CoworkScreen
      tasks={TASKS}
      skills={SKILLS}
      connectors={CONNECTORS}
      onStartTask={() => {}}
      onInvokeSkill={() => {}}
      onOpenSession={() => {}}
      now={NOW}
    />,
  );
}

// ---------------------------------------------------------------------------
// Realistic corpus sanity
// ---------------------------------------------------------------------------

test("the fixture corpus is realistic, not three rows", () => {
  expect(SKILLS.length).toBeGreaterThan(30);
  expect(new Set(SKILLS.map((s) => s.pluginName ?? s.providerName)).size).toBeGreaterThan(6);
  expect(CONNECTORS.length).toBeGreaterThan(10);
  expect(CONNECTORS.filter((c) => c.status !== "connected").length).toBeGreaterThanOrEqual(3);
});

// ---------------------------------------------------------------------------
// 390px: the task sidebar becomes the phone's own screen, not a squeezed rail
// ---------------------------------------------------------------------------

describe("at 390px", () => {
  const html = renderAt(390);

  test("renders without throwing and carries the task sidebar's own content", () => {
    expect(html).toContain('data-testid="task-sidebar"');
    expect(html).toContain("Ship the Cowork surface");
  });

  test("the sidebar is the whole screen, not a column split with a content pane beside it", () => {
    // `task-detail-empty` only exists in the split layout's content pane; a
    // narrow screen showing the sidebar never renders it alongside the list.
    expect(html).not.toContain('data-testid="task-detail-empty"');
  });

  test("navigation is a bottom tab bar with all four destinations reachable", () => {
    expect(html).toContain('data-testid="cowork-nav"');
    for (const id of ["tasks", "skills", "connectors", "plugins"]) {
      expect(html).toContain(`data-testid="cowork-nav-${id}"`);
    }
  });

  test("touch targets are real buttons, not decoration", () => {
    expect(html).toContain('role="button"');
  });

  test("nothing renders an emoji where an icon belongs", () => {
    expect(html).toContain("<svg");
    expect(html).toContain("<path");
    expect(/\p{Extended_Pictographic}/u.test(html)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wide: the sidebar and a content pane sit side by side
// ---------------------------------------------------------------------------

describe("at desktop width", () => {
  const html = renderAt(1200);

  test("the sidebar and the content pane render together", () => {
    expect(html).toContain('data-testid="task-sidebar"');
    // No task selected by default, so the content pane shows its own prompt.
    expect(html).toContain('data-testid="task-detail-empty"');
  });
});

// ---------------------------------------------------------------------------
// Skill grouping by owning plugin, and origin (native/marketplace/local)
// visually distinct — checked through the same render this app ships.
// ---------------------------------------------------------------------------

describe("skills and plugins, rendered", () => {
  test("a realistic multi-plugin skill catalogue groups and labels every origin tier", () => {
    const html = renderToStaticMarkup(<PluginsView skills={SKILLS} connectors={CONNECTORS} />);

    // One group per marketplace plugin, keyed by its own name.
    for (const pluginName of Object.keys(MARKETPLACE_PLUGINS)) {
      expect(html).toContain(`data-testid="plugin-group-${pluginName}"`);
    }
    // All three origin tiers are labeled, distinctly, in one render.
    expect(html).toContain("Built-in");
    expect(html).toContain(">Plugin<");
    expect(html).toContain("Local");
  });

  test("the skills view surfaces every skill, invocable as a slash command", () => {
    const html = renderToStaticMarkup(<SkillsView skills={SKILLS} onInvoke={() => {}} />);
    expect(html).toContain("/ship");
    expect(html).toContain("/haiku-start");
    expect(html).toContain(`${SKILLS.length} skills`);
  });
});

// ---------------------------------------------------------------------------
// A down connector surfaces its reason, prominently
// ---------------------------------------------------------------------------

describe("connectors, rendered", () => {
  test("a down connector's reason is on the row, not hidden behind the status word", () => {
    const html = renderToStaticMarkup(<ConnectorsView connectors={CONNECTORS} />);
    expect(html).toContain("OAuth token expired 2026-01-01T00:00:00Z");
    expect(html).toContain("ECONNREFUSED 127.0.0.1:8443");
    // The connector with no reported reason still says so, never blank.
    expect(html).toContain("No reason reported.");
  });

  test("down connectors are grouped ahead of connected ones under 'Needs attention'", () => {
    const html = renderToStaticMarkup(<ConnectorsView connectors={CONNECTORS} />);
    const attentionIndex = html.indexOf("Needs attention");
    const connectedIndex = html.indexOf("Connected (");
    expect(attentionIndex).toBeGreaterThan(-1);
    expect(connectedIndex).toBeGreaterThan(attentionIndex);
  });
});

// ---------------------------------------------------------------------------
// Never render a credential — proven at the render layer, not just the
// pure-function layer already covered in cowork-catalog.test.ts.
// ---------------------------------------------------------------------------

describe("credential safety at render time", () => {
  test("a connector error shaped like a live credential never reaches the DOM", () => {
    const leaking: ConnectorSummary = {
      name: "compromised-connector",
      connected: false,
      status: "disconnected",
      providerName: "OMP Extension Packages",
      error: "auth failed: Authorization: Bearer sk-live-4242424242424242424242424242",
    };
    const html = renderToStaticMarkup(<ConnectorsView connectors={[...CONNECTORS, leaking]} />);

    expect(html).not.toContain("sk-live-4242424242424242424242424242");
    expect(html).not.toContain("Bearer");
    // The row still renders and still says something, just not the secret.
    expect(html).toContain('data-testid="connector-compromised-connector-reason"');
    expect(html).toContain("withheld");
  });

  test("nothing in the skill catalogue renders a config-shaped field even when present on the wire object", () => {
    // A malformed payload smuggling extra fields must not surface them: the
    // components only ever read the named fields off `SkillSummary`, so an
    // extra property is inert even if it were credential-shaped.
    const tainted = {
      ...SKILLS[0],
      apiKey: "sk-should-never-render-1234567890",
      headers: { Authorization: "Bearer should-never-render-abcdefghij" },
    } as unknown as SkillSummary;
    const html = renderToStaticMarkup(<SkillsView skills={[tainted]} onInvoke={() => {}} />);

    expect(html).not.toContain("sk-should-never-render-1234567890");
    expect(html).not.toContain("should-never-render-abcdefghij");
  });
});
