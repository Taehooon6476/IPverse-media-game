import { useCallback, useEffect, useRef, useState } from 'react';
import { agentInbox, listAgents, type Agent, type AgentNote, type Proposal } from './api';
import { local } from './storage';

export const INBOX_SEEN_KEY = 'ipverse.inboxSeen';
/** A GPU trial is running: the inbox follows its phase every 10 s; otherwise a new note is picked up within a minute. */
export const TRIAL_POLL_MS = 10_000;
export const INBOX_POLL_MS = 60_000;

export interface AgentsState {
  /** null until the first load (or while the server has no agents API yet). */
  agents: Agent[] | null;
  notes: AgentNote[] | null;
  /** Notes newer than the newest one shown in the inbox. */
  unread: number;
  loadAgents: () => Promise<void>;
  loadInbox: () => Promise<void>;
  /** Replace one agent (after PATCH / POST) or drop it (null). */
  putAgent: (agentId: string, agent: Agent | null) => void;
  putProposal: (proposal: Proposal) => void;
  markSeen: () => void;
}

/** Agents and their inbox for the signed-in user. Background loads stay quiet; the buttons report their own
 * errors. onPromoted runs when a proposal turns promoted, so the model catalog (GET /connections) can be read again. */
export function useAgents(enabled: boolean, onPromoted?: () => void): AgentsState {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [notes, setNotes] = useState<AgentNote[] | null>(null);
  const [seen, setSeen] = useState(() => local.get(INBOX_SEEN_KEY) ?? '');
  const promoted = useRef<Set<string> | null>(null);
  const promotedCb = useRef(onPromoted);
  promotedCb.current = onPromoted;

  const loadAgents = useCallback(async () => {
    try { setAgents((await listAgents()).agents); } catch { /* the sidebar shows the list as not loaded */ }
  }, []);
  const loadInbox = useCallback(async () => {
    try {
      const list = [...(await agentInbox()).notes].sort((a, z) => z.createdAt.localeCompare(a.createdAt));
      setNotes(list);
    } catch { /* keep the last list */ }
  }, []);

  useEffect(() => {
    if (!enabled) { setAgents(null); setNotes(null); promoted.current = null; return; }
    void loadAgents();
    void loadInbox();
  }, [enabled, loadAgents, loadInbox]);

  const testing = notes?.some((n) => n.proposal?.status === 'testing') ?? false;
  useEffect(() => {
    if (!enabled) return;
    const t = window.setInterval(() => void loadInbox(), testing ? TRIAL_POLL_MS : INBOX_POLL_MS);
    return () => window.clearInterval(t);
  }, [enabled, testing, loadInbox]);

  useEffect(() => {
    if (!notes) return;
    const now = new Set(notes.filter((n) => n.proposal?.status === 'promoted').map((n) => n.proposal!.proposalId));
    if (promoted.current && [...now].some((id) => !promoted.current!.has(id))) promotedCb.current?.();
    promoted.current = now;
  }, [notes]);

  const putAgent = useCallback((agentId: string, agent: Agent | null) => setAgents((list) => {
    const rest = (list ?? []).filter((a) => a.agentId !== agentId);
    if (!agent) return rest;
    const i = (list ?? []).findIndex((a) => a.agentId === agentId);
    return i < 0 ? [...rest, agent] : (list ?? []).map((a) => (a.agentId === agentId ? agent : a));
  }), []);
  const putProposal = useCallback((p: Proposal) => setNotes((list) => list?.map((n) => (
    n.proposal?.proposalId === p.proposalId ? { ...n, proposal: p } : n)) ?? null), []);

  const newest = notes?.[0]?.createdAt ?? '';
  const markSeen = useCallback(() => {
    if (!newest || newest <= seen) return;
    local.set(INBOX_SEEN_KEY, newest);
    setSeen(newest);
  }, [newest, seen]);

  const unread = notes?.filter((n) => n.createdAt > seen).length ?? 0;
  return { agents, notes, unread, loadAgents, loadInbox, putAgent, putProposal, markSeen };
}
