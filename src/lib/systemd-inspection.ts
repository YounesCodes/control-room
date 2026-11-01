import { useEffect, useState } from "react";
import { api, errorMessage } from "./api";
import { isCacheFresh } from "./workspace-cache";
import type { CachedValue, SystemdInspection, SystemdReadSection } from "../types";

const reads = new Map<string, CachedValue<SystemdInspection>>();
const pending = new Map<string, Promise<CachedValue<SystemdInspection>>>();
const generations = new Map<string, number>();
const scopes = new Map<string, string>();
const EMPTY: CachedValue<SystemdInspection> = {
  value: null,
  fetchedAt: null,
  loading: false,
  error: null,
};
const keyFor = (connection: string, unit: string, section: SystemdReadSection, scope: string) =>
  JSON.stringify([connection, scope, unit, section]);

export function invalidateSystemdReads(connection: string) {
  generations.set(connection, (generations.get(connection) ?? 0) + 1);
  for (const [key, value] of reads)
    if (JSON.parse(key)[0] === connection) reads.set(key, { ...value, fetchedAt: null });
  for (const key of pending.keys()) if (JSON.parse(key)[0] === connection) pending.delete(key);
}

async function read(connection: string, unit: string, section: SystemdReadSection, scope: string) {
  const key = keyFor(connection, unit, section, scope);
  const current = reads.get(key) ?? EMPTY;
  if (isCacheFresh(current)) return current;
  if (pending.has(key)) return pending.get(key)!;
  const generation = generations.get(connection) ?? 0;
  const promise = (async () => {
    let next: CachedValue<SystemdInspection>;
    try {
      const value = await api.inspectSystemdUnit(connection, unit, section);
      next = { value, fetchedAt: Date.now(), loading: false, error: null };
    } catch (caught) {
      next = { ...current, loading: false, error: errorMessage(caught) };
    }
    if ((generations.get(connection) ?? 0) === generation) {
      reads.delete(key);
      reads.set(key, next);
      while (reads.size > 128) reads.delete(reads.keys().next().value!);
    }
    return next;
  })();
  pending.set(key, promise);
  void promise.finally(() => {
    if (pending.get(key) === promise) pending.delete(key);
  });
  return promise;
}

/** Only explicitly selected or expanded units are read, with at most two reads in flight. */
export function useSystemdReads(
  connection: string,
  units: string[],
  revision: number,
  section: SystemdReadSection = "properties",
  scope: string = connection,
) {
  const ids = [...new Set(units)].slice(0, 26).join("\n");
  const [snapshot, setSnapshot] = useState<{
    connection: string;
    section: SystemdReadSection;
    scope: string;
    values: Record<string, CachedValue<SystemdInspection>>;
  }>({ connection, section, scope, values: {} });
  useEffect(() => {
    let cancelled = false;
    // Retire in-flight reads as well as cached values when a Saved Connection
    // changes target, including when it changes back during a queued SSH read.
    if (scopes.has(connection) && scopes.get(connection) !== scope)
      invalidateSystemdReads(connection);
    scopes.set(connection, scope);
    const requested = ids ? ids.split("\n") : [];
    setSnapshot({
      connection,
      section,
      scope,
      values: Object.fromEntries(
        requested.map((id) => [
          id,
          {
            ...(reads.get(keyFor(connection, id, section, scope)) ?? EMPTY),
            loading: !isCacheFresh(reads.get(keyFor(connection, id, section, scope)) ?? EMPTY),
          },
        ]),
      ),
    });
    void (async () => {
      for (let i = 0; i < requested.length && !cancelled; i += 2) {
        await Promise.all(
          requested.slice(i, i + 2).map(async (id) => {
            const result = await read(connection, id, section, scope);
            if (!cancelled)
              setSnapshot((previous) => ({
                connection,
                section,
                scope,
                values: { ...previous.values, [id]: result },
              }));
          }),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, ids, revision, section, scope]);
  return snapshot.connection === connection &&
    snapshot.section === section &&
    snapshot.scope === scope
    ? snapshot.values
    : {};
}
