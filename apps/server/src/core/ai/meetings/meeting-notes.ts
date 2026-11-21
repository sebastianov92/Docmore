// The parts of meeting notes that need no database and no model: shapes,
// cleaning what clients send, speaker labels, the list of agreements and
// tasks (what the model and the person may do to it) and the page text.

export type MeetingMode = 'in_person' | 'virtual';
export type MeetingSide = 'room' | 'remote';
export type MeetingLang = 'es' | 'en';

export interface MeetingSpeaker {
  id: string;
  number: number;
  side: MeetingSide | null;
  name: string | null;
}

export interface MeetingSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
  side?: MeetingSide;
}

export type ItemKind = 'agreement' | 'task';
export type ItemStatus = 'active' | 'cancelled';

export interface MeetingItemVersion {
  text: string;
  owner: string | null;
  due: string | null;
  status: ItemStatus;
  at: number | null;
  by: 'ai' | 'user';
}

export interface MeetingItem {
  id: string;
  kind: ItemKind;
  text: string;
  owner: string | null;
  due: string | null;
  status: ItemStatus;
  // edited by the person: the model no longer touches it
  locked: boolean;
  // seconds into the meeting when it was last changed
  at: number | null;
  updatedBy: 'ai' | 'user';
  history: MeetingItemVersion[];
}

export interface NotesText {
  title: string;
  summary: string;
  topics: string[];
}

const SPEAKER_ID = /^[a-z0-9_-]{1,40}$/;
export const MAX_SEGMENTS = 20_000;
const MAX_SPEAKERS = 200;
const MAX_ITEMS = 300;
const MAX_HISTORY = 20;

export function isMode(value: unknown): value is MeetingMode {
  return value === 'in_person' || value === 'virtual';
}

function side(value: unknown): MeetingSide | null {
  return value === 'room' || value === 'remote' ? value : null;
}

function short(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

export function cleanSpeakers(input: unknown): MeetingSpeaker[] {
  if (!Array.isArray(input)) return [];
  const out: MeetingSpeaker[] = [];
  const seen = new Set<string>();
  const numbers = new Set<number>();
  for (const raw of input.slice(0, MAX_SPEAKERS)) {
    const id = typeof raw?.id === 'string' ? raw.id : '';
    if (!SPEAKER_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    let number = Number.isInteger(raw?.number) && raw.number >= 1 ? Number(raw.number) : 0;
    // every speaker needs its own number: the default label is made of it
    if (!number || numbers.has(number)) {
      number = 1;
      while (numbers.has(number)) number += 1;
    }
    numbers.add(number);
    out.push({ id, number, side: side(raw?.side), name: short(raw?.name, 80) });
  }
  return out;
}

export function cleanSegments(input: unknown): MeetingSegment[] {
  if (!Array.isArray(input)) return [];
  const out: MeetingSegment[] = [];
  for (const raw of input.slice(0, MAX_SEGMENTS)) {
    const text = typeof raw?.text === 'string' ? raw.text.trim().slice(0, 4000) : '';
    if (!text) continue;
    const segment: MeetingSegment = { start: Number(raw.start) || 0, end: Number(raw.end) || 0, text };
    if (typeof raw.speaker === 'string' && SPEAKER_ID.test(raw.speaker)) segment.speaker = raw.speaker;
    const s = side(raw.side);
    if (s) segment.side = s;
    out.push(segment);
  }
  return out;
}

// ---------------------------------------------------------------- labels

const WORDS = {
  es: {
    person: 'Persona',
    room: 'sala',
    remote: 'remoto',
    Room: 'Sala',
    Remote: 'Remoto',
    summary: 'Resumen',
    topics: 'Temas',
    agreements: 'Acuerdos',
    tasks: 'Tareas',
    changes: 'Cambios durante la reunión',
    cancelled: 'cancelado',
    transcript: 'Transcripción',
    in_person: 'Presencial',
    virtual: 'Virtual',
    meeting: 'Reunión',
    notesTitle: 'Notas de la reunión',
  },
  en: {
    person: 'Speaker',
    room: 'room',
    remote: 'remote',
    Room: 'Room',
    Remote: 'Remote',
    summary: 'Summary',
    topics: 'Topics',
    agreements: 'Decisions',
    tasks: 'Action items',
    changes: 'Changes during the meeting',
    cancelled: 'cancelled',
    transcript: 'Transcript',
    in_person: 'In person',
    virtual: 'Virtual',
    meeting: 'Meeting',
    notesTitle: 'Meeting notes',
  },
} as const;

export function meetingWords(lang: MeetingLang) {
  return WORDS[lang];
}

// The language of the headings and default labels: the person's own
// language when it is set, else the one that was spoken.
export function pickLang(locale: string | null | undefined, spoken: string | null | undefined): MeetingLang {
  const mine = (locale ?? '').toLowerCase();
  if (mine) return mine.startsWith('es') ? 'es' : 'en';
  return (spoken ?? '').toLowerCase().startsWith('es') ? 'es' : 'en';
}

// "Persona 3", and in a virtual meeting "Persona 3 (remoto)".
export function defaultLabel(speaker: MeetingSpeaker, mode: MeetingMode | null, lang: MeetingLang, withSide = true): string {
  const w = WORDS[lang];
  const base = `${w.person} ${speaker.number}`;
  if (!withSide || mode !== 'virtual' || !speaker.side) return base;
  return `${base} (${speaker.side === 'remote' ? w.remote : w.room})`;
}

export function speakerLabel(speaker: MeetingSpeaker, mode: MeetingMode | null, lang: MeetingLang): string {
  return speaker.name || defaultLabel(speaker, mode, lang);
}

// Every way a speaker may be written in the notes, longest first.
export function labelForms(speaker: MeetingSpeaker, mode: MeetingMode | null): string[] {
  if (speaker.name) return [speaker.name];
  const forms = new Set<string>();
  for (const lang of ['es', 'en'] as const) {
    forms.add(defaultLabel(speaker, mode, lang, true));
    forms.add(defaultLabel(speaker, mode, lang, false));
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

// A matcher for whole labels: "Persona 1" never matches inside "Persona 12".
export function labelPattern(forms: string[]): RegExp | null {
  const parts = forms.filter(Boolean).map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!parts.length) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join('|')})(?![\\p{L}\\p{N}])`, 'gu');
}

export interface Turn {
  start: number | null;
  label: string | null;
  text: string;
}

// Paragraphs of roughly 500 characters; a new one whenever the voice changes.
export function turns(
  segments: MeetingSegment[],
  fallback: string,
  speakers: MeetingSpeaker[],
  mode: MeetingMode | null,
  lang: MeetingLang,
): Turn[] {
  if (!segments.length) {
    return fallback
      .split(/\n{2,}|(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ])/)
      .reduce<string[]>((acc, s) => {
        const last = acc[acc.length - 1];
        if (last && last.length + s.length < 500) acc[acc.length - 1] = `${last} ${s}`;
        else acc.push(s);
        return acc;
      }, [])
      .map((text) => ({ start: null, label: null, text: text.trim() }))
      .filter((b) => b.text);
  }
  const byId = new Map(speakers.map((s) => [s.id, s]));
  const w = WORDS[lang];
  const out: Turn[] = [];
  let current: (Turn & { key: string; start: number }) | null = null;
  for (const s of segments) {
    const speaker = s.speaker ? byId.get(s.speaker) : undefined;
    const label = speaker ? speakerLabel(speaker, mode, lang) : s.side ? (s.side === 'remote' ? w.Remote : w.Room) : null;
    const key = speaker ? `s:${speaker.id}` : s.side ? `d:${s.side}` : '';
    if (current && current.key === key && current.text.length + s.text.length < 500 && s.start - current.start < 120) {
      current.text = `${current.text} ${s.text}`;
    } else {
      if (current) out.push({ start: current.start, label: current.label, text: current.text });
      current = { key, start: s.start, label, text: s.text };
    }
  }
  if (current) out.push({ start: current.start, label: current.label, text: current.text });
  return out;
}

export function stamp(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

// What the model reads: "[02:15] Ana: ..." one line per turn.
export function transcriptLines(list: Turn[], stamps = true): string {
  return list
    .map((t) => `${!stamps || t.start === null ? '' : `[${stamp(t.start)}] `}${t.label ? `${t.label}: ` : ''}${t.text}`)
    .join('\n');
}

// What a speaker said, for the screen where names are given.
export function speakerStats(segments: MeetingSegment[]): Map<string, { seconds: number; segments: number; sample: string }> {
  const out = new Map<string, { seconds: number; segments: number; sample: string }>();
  for (const s of segments) {
    if (!s.speaker) continue;
    const entry = out.get(s.speaker) ?? { seconds: 0, segments: 0, sample: '' };
    entry.seconds += Math.max(0, s.end - s.start);
    entry.segments += 1;
    // the longest sentence is the easiest to recognise a person by
    if (s.text.length > entry.sample.length) entry.sample = s.text;
    out.set(s.speaker, entry);
  }
  for (const entry of out.values()) {
    entry.seconds = Math.round(entry.seconds);
    if (entry.sample.length > 160) entry.sample = `${entry.sample.slice(0, 157)}...`;
  }
  return out;
}

// ------------------------------------------------------------------ items

export function cleanItems(input: unknown): MeetingItem[] {
  if (!Array.isArray(input)) return [];
  const out: MeetingItem[] = [];
  for (const raw of input.slice(0, MAX_ITEMS)) {
    const text = short(raw?.text, 500);
    if (!text || typeof raw?.id !== 'string') continue;
    out.push({
      id: raw.id,
      kind: raw.kind === 'task' ? 'task' : 'agreement',
      text,
      owner: short(raw.owner, 120),
      due: short(raw.due, 120),
      status: raw.status === 'cancelled' ? 'cancelled' : 'active',
      locked: Boolean(raw.locked),
      at: typeof raw.at === 'number' ? raw.at : null,
      updatedBy: raw.updatedBy === 'user' ? 'user' : 'ai',
      history: Array.isArray(raw.history) ? raw.history.slice(-MAX_HISTORY) : [],
    });
  }
  return out;
}

function nextId(items: MeetingItem[]): string {
  let max = 0;
  for (const item of items) {
    const m = /^i(\d+)$/.exec(item.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `i${max + 1}`;
}

function plain(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function version(item: MeetingItem): MeetingItemVersion {
  return { text: item.text, owner: item.owner, due: item.due, status: item.status, at: item.at, by: item.updatedBy };
}

// One change to an entry: the earlier version goes to its history.
function change(
  item: MeetingItem,
  patch: { kind?: unknown; text?: unknown; owner?: unknown; due?: unknown; status?: ItemStatus },
  at: number | null,
  by: 'ai' | 'user',
): boolean {
  const next = {
    kind: patch.kind === 'task' || patch.kind === 'agreement' ? patch.kind : item.kind,
    text: patch.text === undefined ? item.text : (short(patch.text, 500) ?? item.text),
    owner: patch.owner === undefined ? item.owner : short(patch.owner, 120),
    due: patch.due === undefined ? item.due : short(patch.due, 120),
    status: patch.status ?? item.status,
  };
  const same =
    next.kind === item.kind && next.text === item.text && next.owner === item.owner && next.due === item.due && next.status === item.status;
  if (same) return false;
  item.history = [...item.history, version(item)].slice(-MAX_HISTORY);
  Object.assign(item, next);
  item.at = at;
  item.updatedBy = by;
  return true;
}

export interface ModelOp {
  op: 'add' | 'update' | 'cancel' | 'restore';
  id?: string;
  kind?: ItemKind;
  text?: string;
  owner?: string | null;
  due?: string | null;
}

export function parseJson(text: string): any | null {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function parseOps(raw: unknown): ModelOp[] {
  const list = Array.isArray((raw as any)?.ops) ? (raw as any).ops : Array.isArray(raw) ? raw : [];
  const out: ModelOp[] = [];
  for (const entry of list.slice(0, 40)) {
    const op = String(entry?.op ?? '').toLowerCase();
    if (op !== 'add' && op !== 'update' && op !== 'cancel' && op !== 'restore') continue;
    out.push({
      op,
      id: typeof entry.id === 'string' ? entry.id : undefined,
      kind: entry.kind === 'task' || entry.kind === 'agreement' ? entry.kind : undefined,
      text: typeof entry.text === 'string' ? entry.text : undefined,
      owner: entry.owner === undefined ? undefined : entry.owner === null ? null : String(entry.owner),
      due: entry.due === undefined ? undefined : entry.due === null ? null : String(entry.due),
    });
  }
  return out;
}

const STOP_WORDS = new Set([
  'para', 'pero', 'como', 'cuando', 'donde', 'este', 'esta', 'esto', 'estos', 'estas', 'entre', 'sobre', 'desde', 'hasta', 'todo', 'toda', 'todos', 'todas',
  'tiene', 'tienen', 'hacer', 'antes', 'despues', 'luego', 'ahora', 'mejor', 'entonces', 'tambien', 'porque', 'cada', 'otro', 'otra', 'unos', 'unas',
  'with', 'that', 'this', 'these', 'those', 'from', 'have', 'will', 'would', 'should', 'could', 'about', 'after', 'before', 'then', 'they', 'them', 'their',
  'there', 'what', 'when', 'where', 'which', 'into', 'over', 'next', 'been', 'being', 'does', 'done', 'make',
]);

// The words of a text that say what it is about, cut to five letters so
// "entrega" and "entregamos" count as the same word.
function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of plain(text).split(' ')) {
    if (word.length < 4 || STOP_WORDS.has(word)) continue;
    out.add(word.slice(0, 5));
  }
  return out;
}

// True when the new part of the transcript mentions something the entry is
// about. A small model now and then moves the date of a task nobody talked
// about; this keeps such a change out of the list (the final pass, which
// reads everything, can still make it).
export function mentions(fresh: string, item: { text: string }): boolean {
  const said = stems(fresh);
  const own = [...stems(item.text)];
  // an entry with no telling word of its own cannot be checked
  if (!own.length) return true;
  // one shared word is not enough for a long entry: "cliente" is in half of them
  const needed = Math.ceil(own.length / 3);
  return own.filter((stem) => said.has(stem)).length >= needed;
}

// What the model asked for, applied. Locked entries are never changed, an
// entry is not added twice, and with `fresh` (the text the model has just
// read) an entry is only changed when that text is about it.
export function applyModelOps(items: MeetingItem[], ops: ModelOp[], at: number | null, fresh?: string): { items: MeetingItem[]; changed: boolean } {
  const next = items.map((i) => ({ ...i, history: [...i.history] }));
  let changed = false;
  for (const op of ops) {
    if (op.op === 'add') {
      const text = short(op.text, 500);
      if (!text || next.length >= MAX_ITEMS) continue;
      const key = plain(text);
      if (next.some((i) => plain(i.text) === key)) continue;
      next.push({
        id: nextId(next),
        kind: op.kind ?? 'agreement',
        text,
        owner: short(op.owner, 120),
        due: short(op.due, 120),
        status: 'active',
        locked: false,
        at,
        updatedBy: 'ai',
        history: [],
      });
      changed = true;
      continue;
    }
    const item = next.find((i) => i.id === op.id);
    if (!item || item.locked) continue;
    if (fresh !== undefined && !mentions(fresh, item)) continue;
    if (op.op === 'update') {
      changed = change(item, { kind: op.kind, text: op.text, owner: op.owner, due: op.due }, at, 'ai') || changed;
    } else {
      changed = change(item, { status: op.op === 'cancel' ? 'cancelled' : 'active' }, at, 'ai') || changed;
    }
  }
  return { items: next, changed };
}

export interface UserOp {
  op: 'add' | 'update' | 'cancel' | 'restore' | 'remove';
  id?: string;
  kind?: ItemKind;
  text?: string;
  owner?: string | null;
  due?: string | null;
}

// What the person did by hand. It locks the entry.
export function applyUserOp(items: MeetingItem[], op: UserOp, at: number | null): MeetingItem[] {
  const next = items.map((i) => ({ ...i, history: [...i.history] }));
  if (op.op === 'add') {
    const text = short(op.text, 500);
    if (!text) throw new Error('An entry needs its text');
    if (next.length >= MAX_ITEMS) throw new Error('The list is full');
    next.push({
      id: nextId(next),
      kind: op.kind === 'task' ? 'task' : 'agreement',
      text,
      owner: short(op.owner, 120),
      due: short(op.due, 120),
      status: 'active',
      locked: true,
      at,
      updatedBy: 'user',
      history: [],
    });
    return next;
  }
  const index = next.findIndex((i) => i.id === op.id);
  if (index < 0) throw new Error('That entry is not in the list');
  if (op.op === 'remove') {
    next.splice(index, 1);
    return next;
  }
  const item = next[index];
  if (op.op === 'update') {
    if (op.text !== undefined && !short(op.text, 500)) throw new Error('An entry needs its text');
    change(item, { kind: op.kind, text: op.text, owner: op.owner, due: op.due }, at, 'user');
  } else {
    change(item, { status: op.op === 'cancel' ? 'cancelled' : 'active' }, at, 'user');
  }
  item.locked = true;
  item.updatedBy = 'user';
  return next;
}

// The list the model gives back after reading the whole transcript, laid
// over the one kept during the meeting. An entry the model left out stays
// as it was: only an explicit "cancelled" removes something from the notes.
export function mergeFinalItems(items: MeetingItem[], returned: unknown, at: number | null): MeetingItem[] {
  const next = items.map((i) => ({ ...i, history: [...i.history] }));
  const list = Array.isArray(returned) ? returned.slice(0, MAX_ITEMS) : [];
  for (const raw of list) {
    const text = short(raw?.text, 500);
    if (!text) continue;
    const status: ItemStatus = raw.status === 'cancelled' ? 'cancelled' : 'active';
    const known = typeof raw.id === 'string' ? next.find((i) => i.id === raw.id) : undefined;
    const same = known ?? next.find((i) => plain(i.text) === plain(text));
    if (same) {
      if (!same.locked) change(same, { kind: raw.kind, text, owner: raw.owner ?? null, due: raw.due ?? null, status }, at, 'ai');
      continue;
    }
    if (next.length >= MAX_ITEMS) break;
    next.push({
      id: nextId(next),
      kind: raw.kind === 'task' ? 'task' : 'agreement',
      text,
      owner: short(raw.owner, 120),
      due: short(raw.due, 120),
      status,
      locked: false,
      at,
      updatedBy: 'ai',
      history: [],
    });
  }
  return next;
}

// A speaker got a name (or lost it): owners written with the old label follow.
export function renameOwners(items: MeetingItem[], pattern: RegExp | null, to: string): MeetingItem[] {
  if (!pattern) return items;
  const fix = <T extends { text: string; owner: string | null }>(v: T): T => ({
    ...v,
    text: v.text.replace(pattern, to),
    owner: v.owner ? v.owner.replace(pattern, to) : v.owner,
  });
  return items.map((i) => ({ ...fix(i), history: i.history.map(fix) }));
}

// ---------------------------------------------------------------- prompts

function forModel(items: MeetingItem[]) {
  return items.map((i) => ({ id: i.id, kind: i.kind, text: i.text, owner: i.owner, due: i.due, status: i.status, locked: i.locked }));
}

export const LIVE_SYSTEM =
  'You keep the running list of agreements and tasks of a meeting while it happens. ' +
  'You get the list so far (JSON) and the newest part of the transcript. Answer with one JSON object and nothing else: ' +
  '{"ops": [{"op": "add", "kind": "agreement"|"task", "text": string, "owner": string|null, "due": string|null} | ' +
  '{"op": "update", "id": string, "text"?: string, "owner"?: string|null, "due"?: string|null} | ' +
  '{"op": "cancel", "id": string} | {"op": "restore", "id": string}]}. ' +
  'Rules: an agreement is something the group decided; a task is something a person took on or was asked to do and accepted. ' +
  'Only what was actually said: never invent owners or dates; ideas, questions and options that were not settled are not entries. ' +
  'When the meeting changes its mind about an entry already in the list (another date, another owner, a different decision), ' +
  'update that entry with its id instead of adding a new one. When something is called off, cancel it. ' +
  'Change only the entry the new part is about and leave every other entry exactly as it is. ' +
  'Entries with "locked": true were edited by a person: never update or cancel them and never add a duplicate of them. ' +
  'Most new parts of a transcript change nothing: then answer {"ops": []}. ' +
  'One short sentence per entry, in the language of the transcript, every word spelled correctly in that language with its accents and capital letters. ' +
  'The owner and the date go in their own fields: do not repeat them inside the text. ' +
  'As owner use the name or label of the person exactly as the transcript writes it.';

export function livePrompt(items: MeetingItem[], earlier: string, fresh: string): string {
  return [
    `List so far:\n${JSON.stringify(forModel(items))}`,
    earlier ? `Earlier in the meeting (already read, only for context):\n${earlier}` : '',
    `New part of the transcript:\n${fresh}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export const FINAL_SYSTEM =
  'You turn a meeting transcript into notes. You also get the list of agreements and tasks that was kept while the meeting ran ' +
  '(it may be empty); check it against the whole transcript and give back the final list: fix what is wrong, add what is missing, ' +
  'mark as cancelled what was called off later, and when the meeting changed its mind keep only the final version in the entry. ' +
  'Give back every entry of the list with its id; use null as id for a new one. Entries with "locked": true were edited by a person: give them back unchanged. ' +
  'An agreement is something the group decided; a task is something a person took on or was asked to do and accepted. ' +
  'Answer with one JSON object and nothing else: ' +
  '{"title": string, "summary": string (2-5 sentences), "topics": string[], ' +
  '"items": [{"id": string|null, "kind": "agreement"|"task", "text": string, "owner": string|null, "due": string|null, "status": "active"|"cancelled"}]}. ' +
  'Write in the language of the transcript. Never invent decisions, owners or dates that were not said. ' +
  'The owner and the date go in their own fields: do not repeat them inside the text. ' +
  'Write the names and labels of the people exactly as the transcript does.';

export function finalPrompt(label: string, items: MeetingItem[], transcript: string): string {
  return `Meeting: ${label}\n\nList kept during the meeting:\n${JSON.stringify(forModel(items))}\n\nTranscript:\n${transcript}`;
}

// ------------------------------------------------------------------ page

function describe(v: { text: string; owner: string | null; due: string | null }): string {
  return `${v.text}${v.owner ? ` — ${v.owner}` : ''}${v.due ? ` · ${v.due}` : ''}`;
}

// What an entry first said, when the meeting itself changed it afterwards.
// A rewording by the person is not the meeting changing its mind.
export function beforeTheChange(item: MeetingItem): string | null {
  const versions = [...item.history, { text: item.text, owner: item.owner, due: item.due, status: item.status, at: item.at, by: item.updatedBy }];
  const now = describe(item);
  for (let i = 0; i < versions.length - 1; i += 1) {
    const changedByMeeting = versions.slice(i + 1).some((v) => v.by === 'ai');
    if (changedByMeeting && versions[i].status === 'active' && describe(versions[i]) !== now) return describe(versions[i]);
  }
  return null;
}

export function renderNotes(
  notes: NotesText,
  items: MeetingItem[],
  list: Turn[],
  info: { fileName: string; durationSeconds: number | null; language: string | null; mode: MeetingMode | null; lang: MeetingLang },
): string {
  const w = WORDS[info.lang];
  const lines: string[] = [];
  if (notes.summary) lines.push(`## ${w.summary}`, '', notes.summary, '');
  if (notes.topics.length) lines.push(`**${w.topics}:** ${notes.topics.join(' · ')}`, '');
  const active = items.filter((i) => i.status === 'active');
  const agreements = active.filter((i) => i.kind === 'agreement');
  const tasks = active.filter((i) => i.kind === 'task');
  if (agreements.length) {
    lines.push(`## ${w.agreements}`, '');
    for (const a of agreements) lines.push(`- ${describe(a)}`);
    lines.push('');
  }
  if (tasks.length) {
    lines.push(`## ${w.tasks}`, '');
    for (const t of tasks) lines.push(`- [ ] ${describe(t)}`);
    lines.push('');
  }
  // what the meeting changed its mind about: the earlier wording, struck through
  const changes: string[] = [];
  for (const item of items) {
    if (item.status === 'cancelled') {
      changes.push(`- ~~${describe(item)}~~ (${w.cancelled})`);
      continue;
    }
    const before = beforeTheChange(item);
    if (before) changes.push(`- ~~${before}~~ → ${describe(item)}`);
  }
  if (changes.length) lines.push(`## ${w.changes}`, '', ...changes, '');
  lines.push(`## ${w.transcript}`, '');
  const facts = [info.fileName, info.durationSeconds ? stamp(info.durationSeconds) : '', info.language ?? '', info.mode ? w[info.mode] : ''].filter(Boolean);
  lines.push(`_${facts.join(' · ')}_`, '');
  for (const t of list) {
    const head = [t.start === null ? '' : `[${stamp(t.start)}]`, t.label ? `${t.label}:` : ''].filter(Boolean).join(' ');
    lines.push(head ? `**${head}** ${t.text}` : t.text, '');
  }
  return lines.join('\n');
}
