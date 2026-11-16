import { readFileSync, writeFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  createTerminalLayout,
  getTerminalDividerHandles,
  getTerminalLayoutIds,
  getTerminalLayoutSurface,
  insertTerminalBeside,
  orientTerminalLayout,
  rearrangeTerminalLayout,
  resizeTerminalHandle,
  splitTerminalLayout,
  transposeTerminalCross,
  type TerminalDropZone,
  type TerminalLayout,
  type TerminalSplitDirection,
} from "./terminal-layout";
import {
  deleteTerminalGroup,
  nextTerminalGroupName,
  pruneTerminalGroups,
  renameTerminalGroup,
  terminalGroupForWorkspace,
  type TerminalGroup,
} from "./terminal-groups";
import {
  persistWorkspaceState,
  restoreWorkspaceState,
  type RestorableWorkspaceState,
} from "./workspace-persistence";
import { createLocalWorkspace, createRemoteWorkspace } from "./workspace-target";
import type {
  LocalShellProfile,
  PersistedWorkspaceState,
  SavedConnection,
  Workspace,
} from "../types";

const PROPERTY_SEED = 273;
const PROPERTY_RUNS = 300;
const CORPUS_SAMPLES = 60;
const CORPUS_PATH = "src-tauri/src/database/workspace_state_corpus.jsonl";
const WRITE_CORPUS_VARIABLE = "CONTROL_ROOM_WRITE_LAYOUT_CORPUS";
const REGENERATE_CORPUS_COMMAND = "npm run generate:layout-corpus";
const MAX_PERSISTED_WORKSPACES = 100;
const LEGACY_TERMINAL_GROUP_ID = "00000000-0000-4000-8000-000000000001";

const shell: LocalShellProfile = {
  id: "powershell-7",
  label: "PowerShell 7",
  kind: "powershell-7",
  elevated: false,
};

const host: SavedConnection = {
  id: "6c8d3c1e-2f4a-4b7e-9a51-0d2f6b3e8c71",
  displayName: "Linux host",
  destination: "linux-host",
  username: "user",
  port: null,
  identityFile: null,
  historyEnabled: false,
  sudoEnabled: false,
  groupId: null,
  tags: [],
  createdAt: "",
  updatedAt: "",
  lastConnectedAt: null,
};

type Edge = Exclude<TerminalDropZone, "center">;

type Operation =
  | { kind: "open"; id: string; remote: boolean }
  | {
      kind: "split";
      target: number;
      existing: number | null;
      id: string;
      remote: boolean;
      groupId: string;
      direction: TerminalSplitDirection;
    }
  | { kind: "insertBeside"; source: number; target: number; groupId: string; edge: Edge }
  | { kind: "rearrange"; group: number; source: number; target: number; zone: TerminalDropZone }
  | { kind: "orient"; group: number; split: number; direction: TerminalSplitDirection }
  | { kind: "transpose"; group: number; split: number }
  | {
      kind: "resize";
      group: number;
      handle: number;
      ratio: number;
      width: number;
      height: number;
    }
  | { kind: "close"; workspace: number }
  | { kind: "deleteGroup"; group: number }
  | { kind: "rename"; group: number; name: string };

interface Model {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  groups: TerminalGroup[];
}

const emptyModel: Model = { workspaces: [], activeWorkspaceId: null, groups: [] };

function workspace(id: string, remote: boolean): Workspace {
  return { ...(remote ? createRemoteWorkspace(host) : createLocalWorkspace(shell)), id };
}

function at<T>(items: T[], index: number): T | undefined {
  return items.length ? items[index % items.length] : undefined;
}

function splitPaths(layout: TerminalLayout, path = ""): string[] {
  if (layout.kind === "leaf") return [];
  const child = (name: string) => (path ? `${path}.${name}` : name);
  return [
    path,
    ...splitPaths(layout.first, child("first")),
    ...splitPaths(layout.second, child("second")),
  ];
}

function splitNodes(layout: TerminalLayout): Extract<TerminalLayout, { kind: "split" }>[] {
  if (layout.kind === "leaf") return [];
  return [layout, ...splitNodes(layout.first), ...splitNodes(layout.second)];
}

function sorted(ids: string[]): string[] {
  return [...ids].sort();
}

function replaceLayout(model: Model, groupId: string, layout: TerminalLayout): Model {
  return {
    ...model,
    groups: model.groups.map((group) => (group.id === groupId ? { ...group, layout } : group)),
  };
}

function expectSameMembers(before: TerminalLayout, after: TerminalLayout, added?: string) {
  expect(sorted(getTerminalLayoutIds(after))).toEqual(
    sorted([...getTerminalLayoutIds(before), ...(added ? [added] : [])]),
  );
}

function groupIntoLayout(
  model: Model,
  target: string,
  groupId: string,
  build: (layout: TerminalLayout) => TerminalLayout,
): Model {
  const group = terminalGroupForWorkspace(model.groups, target);
  if (group) return replaceLayout(model, group.id, build(group.layout));
  if (model.groups.some((item) => item.id === groupId)) return model;
  const solo = createTerminalLayout(target);
  const layout = build(solo);
  if (layout === solo) return model;
  return {
    ...model,
    groups: [...model.groups, { id: groupId, name: nextTerminalGroupName(model.groups), layout }],
  };
}

function ungrouped(model: Model, except: string): Workspace[] {
  return model.workspaces.filter(
    (item) => item.id !== except && !terminalGroupForWorkspace(model.groups, item.id),
  );
}

function applyOperation(model: Model, operation: Operation): Model {
  const known = (id: string) => model.workspaces.some((item) => item.id === id);
  switch (operation.kind) {
    case "open": {
      if (known(operation.id) || model.workspaces.length >= MAX_PERSISTED_WORKSPACES) return model;
      return {
        ...model,
        workspaces: [...model.workspaces, workspace(operation.id, operation.remote)],
        activeWorkspaceId: operation.id,
      };
    }
    case "split": {
      const target = at(model.workspaces, operation.target);
      if (!target) return model;
      const existing =
        operation.existing === null
          ? null
          : (at(ungrouped(model, target.id), operation.existing) ?? null);
      if (operation.existing !== null && !existing) return model;
      if (!existing && (known(operation.id) || model.workspaces.length >= MAX_PERSISTED_WORKSPACES))
        return model;
      const source = existing ?? workspace(operation.id, operation.remote);
      const next = groupIntoLayout(model, target.id, operation.groupId, (layout) => {
        const result = splitTerminalLayout(layout, target.id, source.id, operation.direction);
        expectSameMembers(layout, result, source.id);
        return result;
      });
      if (next === model) return model;
      return {
        ...next,
        workspaces: existing ? next.workspaces : [...next.workspaces, source],
        activeWorkspaceId: source.id,
      };
    }
    case "insertBeside": {
      const target = at(model.workspaces, operation.target);
      const source = target && at(ungrouped(model, target.id), operation.source);
      if (!target || !source) return model;
      const next = groupIntoLayout(model, target.id, operation.groupId, (layout) => {
        const result = insertTerminalBeside(layout, source.id, target.id, operation.edge);
        expectSameMembers(layout, result, source.id);
        return result;
      });
      return next === model ? model : { ...next, activeWorkspaceId: source.id };
    }
    case "rearrange": {
      const group = at(model.groups, operation.group);
      if (!group) return model;
      const members = getTerminalLayoutIds(group.layout);
      const source = at(members, operation.source)!;
      const target = at(members, operation.target)!;
      const layout = rearrangeTerminalLayout(group.layout, source, target, operation.zone);
      expectSameMembers(group.layout, layout);
      return replaceLayout(model, group.id, layout);
    }
    case "orient": {
      const group = at(model.groups, operation.group);
      const path = group && at(splitPaths(group.layout), operation.split);
      if (!group || path === undefined) return model;
      const layout = orientTerminalLayout(group.layout, path, operation.direction);
      expectSameMembers(group.layout, layout);
      return replaceLayout(model, group.id, layout);
    }
    case "transpose": {
      const group = at(model.groups, operation.group);
      const path = group && at(splitPaths(group.layout), operation.split);
      if (!group || path === undefined) return model;
      const layout = transposeTerminalCross(group.layout, path);
      expectSameMembers(group.layout, layout);
      return replaceLayout(model, group.id, layout);
    }
    case "resize": {
      const group = at(model.groups, operation.group);
      if (!group) return model;
      const viewport = { width: operation.width, height: operation.height };
      const surface = getTerminalLayoutSurface(group.layout, viewport);
      const handle = at(
        getTerminalDividerHandles(group.layout, surface.dividers, viewport),
        operation.handle,
      );
      if (!handle) return model;
      const layout = resizeTerminalHandle(group.layout, handle, operation.ratio);
      expectSameMembers(group.layout, layout);
      return replaceLayout(model, group.id, layout);
    }
    case "close": {
      const closing = at(model.workspaces, operation.workspace);
      if (!closing) return model;
      const workspaces = model.workspaces.filter((item) => item.id !== closing.id);
      const groups = pruneTerminalGroups(model.groups, new Set(workspaces.map((item) => item.id)));
      for (const group of model.groups) {
        const remaining = getTerminalLayoutIds(group.layout).filter((id) => id !== closing.id);
        const pruned = groups.find((item) => item.id === group.id);
        if (remaining.length >= 2)
          expect(sorted(getTerminalLayoutIds(pruned!.layout))).toEqual(sorted(remaining));
        else expect(pruned).toBeUndefined();
      }
      return {
        workspaces,
        groups,
        activeWorkspaceId: model.activeWorkspaceId === closing.id ? null : model.activeWorkspaceId,
      };
    }
    case "deleteGroup": {
      const group = at(model.groups, operation.group);
      return group ? { ...model, groups: deleteTerminalGroup(model.groups, group.id) } : model;
    }
    case "rename": {
      const group = at(model.groups, operation.group);
      return group
        ? { ...model, groups: renameTerminalGroup(model.groups, group.id, operation.name) }
        : model;
    }
  }
}

function expectConsistentGroups(model: Model) {
  const workspaceIds = new Set(model.workspaces.map((item) => item.id));
  const grouped = new Set<string>();
  expect(new Set(model.groups.map((group) => group.id)).size).toBe(model.groups.length);
  for (const group of model.groups) {
    const members = getTerminalLayoutIds(group.layout);
    expect(members.length).toBeGreaterThanOrEqual(2);
    for (const id of members) {
      expect(workspaceIds.has(id)).toBe(true);
      expect(grouped.has(id)).toBe(false);
      grouped.add(id);
    }
    for (const split of splitNodes(group.layout)) {
      expect(["vertical", "horizontal"]).toContain(split.direction);
      if (split.ratio !== undefined) {
        expect(Number.isFinite(split.ratio)).toBe(true);
        expect(split.ratio).toBeGreaterThanOrEqual(0.05);
        expect(split.ratio).toBeLessThanOrEqual(0.95);
      }
    }
  }
}

function run(operations: Operation[], start: Model = emptyModel): Model {
  return operations.reduce((model, operation) => {
    const next = applyOperation(model, operation);
    expectConsistentGroups(next);
    return next;
  }, start);
}

function persist(model: Model): PersistedWorkspaceState {
  return JSON.parse(
    JSON.stringify(persistWorkspaceState(model.workspaces, model.activeWorkspaceId, model.groups)),
  ) as PersistedWorkspaceState;
}

const index = fc.nat({ max: 1_000 });
const direction = fc.constantFrom<TerminalSplitDirection>("vertical", "horizontal");
const edge = fc.constantFrom<Edge>("left", "right", "top", "bottom");
const zone = fc.constantFrom<TerminalDropZone>("center", "left", "right", "top", "bottom");
const groupName = fc.oneof(
  fc.string({ maxLength: 80 }),
  fc.string({ unit: "binary", maxLength: 80 }),
  fc.constantFrom("Deploy\tlogs", "\u0007", "  "),
);

const operation: fc.Arbitrary<Operation> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({ kind: fc.constant("open"), id: fc.uuid(), remote: fc.boolean() }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("split"),
      target: index,
      existing: fc.option(index, { nil: null }),
      id: fc.uuid(),
      remote: fc.boolean(),
      groupId: fc.uuid(),
      direction,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("insertBeside"),
      source: index,
      target: index,
      groupId: fc.uuid(),
      edge,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("rearrange"),
      group: index,
      source: index,
      target: index,
      zone,
    }),
  },
  fc.record({ kind: fc.constant("orient"), group: index, split: index, direction }),
  fc.record({ kind: fc.constant("transpose"), group: index, split: index }),
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("resize"),
      group: index,
      handle: index,
      ratio: fc.oneof(fc.double(), fc.double({ min: 0, max: 1, noNaN: true })),
      width: fc.integer({ min: 200, max: 4_000 }),
      height: fc.integer({ min: 150, max: 2_500 }),
    }),
  },
  fc.record({ kind: fc.constant("close"), workspace: index }),
  fc.record({ kind: fc.constant("deleteGroup"), group: index }),
  fc.record({ kind: fc.constant("rename"), group: index, name: groupName }),
);

const operations = fc.array(operation, { minLength: 8, maxLength: 60, size: "max" });

const ratio = fc.double({ min: 0.05, max: 0.95, noNaN: true });

function layoutOver(ids: string[]): fc.Arbitrary<TerminalLayout> {
  if (ids.length === 1) return fc.constant(createTerminalLayout(ids[0]));
  return fc
    .record({
      cut: fc.integer({ min: 1, max: ids.length - 1 }),
      direction,
      ratio: fc.option(ratio, { nil: undefined }),
    })
    .chain(({ cut, direction, ratio }) =>
      fc
        .tuple(layoutOver(ids.slice(0, cut)), layoutOver(ids.slice(cut)))
        .map(([first, second]): TerminalLayout => ({
          kind: "split",
          direction,
          ...(ratio === undefined ? {} : { ratio }),
          first,
          second,
        })),
    );
}

const anyLayout = (ids: string[]) =>
  fc.letrec<{ layout: TerminalLayout }>((tie) => ({
    layout: fc.oneof(
      { depthSize: "small", withCrossShrink: true },
      fc.constantFrom(...ids).map(createTerminalLayout),
      fc.record(
        {
          kind: fc.constant("split"),
          direction,
          ratio: fc.double(),
          first: tie("layout"),
          second: tie("layout"),
        },
        { requiredKeys: ["kind", "direction", "first", "second"] },
      ),
    ),
  })).layout;

function menuSplitChain(count: number): Model {
  return run(
    Array.from({ length: count }, (_, position): Operation =>
      position === 0
        ? { kind: "open", id: chainId(position), remote: false }
        : {
            kind: "split",
            target: position - 1,
            existing: null,
            id: chainId(position),
            remote: position % 2 === 1,
            groupId: "3f5b2a9e-7c41-4d8a-b6e0-1a2b3c4d5e6f",
            direction: position % 2 === 1 ? "vertical" : "horizontal",
          },
    ),
  );
}

function chainId(position: number): string {
  return `00000000-0000-4000-8000-${position.toString(16).padStart(12, "0")}`;
}

function maxDepth(layout: TerminalLayout): number {
  return layout.kind === "leaf" ? 0 : 1 + Math.max(maxDepth(layout.first), maxDepth(layout.second));
}

describe("terminal layout properties", () => {
  it("keeps every user operation sequence consistent and restorable", () => {
    fc.assert(
      fc.property(operations, (sequence) => {
        const model = run(sequence);
        const persisted = persist(model);
        expect(persisted.terminalGroups).toEqual(model.groups);
        const restored = restoreWorkspaceState([host], persisted, [shell]);
        expect(restored.workspaces.map((item) => item.id)).toEqual(
          model.workspaces.map((item) => item.id),
        );
        expect(restored.terminalGroups).toEqual(model.groups);
        expect(
          persistWorkspaceState(
            restored.workspaces,
            restored.activeWorkspaceId,
            restored.terminalGroups,
          ),
        ).toEqual({
          ...persisted,
          activeWorkspaceId: persisted.activeWorkspaceId ?? model.workspaces[0]?.id ?? null,
        });
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    );
  });

  it("prunes any group list into unique groups of at least two unclaimed Workspaces", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.oneof(fc.constantFrom("", " ", "g", "g-2"), fc.uuid()),
            name: fc.string({ maxLength: 8 }),
            layout: anyLayout(ids),
          }),
          { maxLength: 6 },
        ),
        fc.subarray(ids),
        (groups, available) => {
          const workspaceIds = new Set(available);
          const pruned = pruneTerminalGroups(groups, workspaceIds);
          expect(new Set(pruned.map((group) => group.id)).size).toBe(pruned.length);
          const members = pruned.flatMap((group) => getTerminalLayoutIds(group.layout));
          expect(new Set(members).size).toBe(members.length);
          expect(members.every((id) => workspaceIds.has(id))).toBe(true);
          expect(pruned.every((group) => getTerminalLayoutIds(group.layout).length >= 2)).toBe(
            true,
          );
          expect(pruned.every((group) => group.name.trim() === group.name && group.name)).toBe(
            true,
          );
          expect(pruneTerminalGroups(pruned, workspaceIds)).toEqual(pruned);
        },
      ),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    );
  });

  it("migrates any legacy split layout into one group with the same layout", () => {
    fc.assert(
      fc.property(
        fc
          .uniqueArray(fc.uuid(), { minLength: 2, maxLength: 12 })
          .chain((ids) => fc.tuple(fc.constant(ids), layoutOver(ids))),
        ([ids, layout]) => {
          const legacy: RestorableWorkspaceState = {
            workspaces: persist({
              workspaces: ids.map((id, position) => workspace(id, position % 2 === 0)),
              activeWorkspaceId: ids[0],
              groups: [],
            }).workspaces,
            activeWorkspaceId: ids[0],
            terminalLayout: layout,
          };
          expect(restoreWorkspaceState([host], legacy, [shell]).terminalGroups).toEqual([
            { id: LEGACY_TERMINAL_GROUP_ID, name: "Terminal group", layout },
          ]);
        },
      ),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    );
  });

  it("keeps a group of the maximum Workspace count savable after repeated menu splits", () => {
    const model = menuSplitChain(MAX_PERSISTED_WORKSPACES);
    expect(model.groups).toHaveLength(1);
    expect(maxDepth(model.groups[0].layout)).toBe(MAX_PERSISTED_WORKSPACES - 1);
    expect(restoreWorkspaceState([host], persist(model), [shell]).terminalGroups).toEqual(
      model.groups,
    );
  });

  it("writes group names that the Rust validator accepts", () => {
    const model = menuSplitChain(2);
    const groupId = model.groups[0].id;
    for (const [name, expected] of [
      ["Deploy\tlogs", "Deploy logs"],
      ["\u0007Build\u0000", "Build"],
      ["\u0007", "Group 1"],
    ]) {
      expect(renameTerminalGroup(model.groups, groupId, name)[0].name).toBe(expected);
    }
  });

  it("matches the persisted state corpus that the Rust validator checks", () => {
    const corpus = [
      persist(menuSplitChain(18)),
      persist(menuSplitChain(MAX_PERSISTED_WORKSPACES)),
      persist(run([{ kind: "rename", group: 0, name: "Deploy\tlogs" }], menuSplitChain(2))),
      ...fc.sample(operations.map(run).map(persist), {
        seed: PROPERTY_SEED,
        numRuns: CORPUS_SAMPLES,
      }),
    ]
      .map((state) => JSON.stringify(state))
      .join("\n")
      .concat("\n");
    if (process.env[WRITE_CORPUS_VARIABLE] === "1") writeFileSync(CORPUS_PATH, corpus);
    expect(
      readFileSync(CORPUS_PATH, "utf8").replace(/\r\n/g, "\n"),
      `${CORPUS_PATH} is stale. Run ${REGENERATE_CORPUS_COMMAND}.`,
    ).toBe(corpus);
  });
});
