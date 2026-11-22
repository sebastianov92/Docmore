import {
  MeetingItem,
  MeetingSpeaker,
  applyModelOps,
  applyUserOp,
  beforeTheChange,
  cleanItems,
  cleanSegments,
  cleanSpeakers,
  defaultLabel,
  labelForms,
  labelPattern,
  mentions,
  mergeFinalItems,
  parseJson,
  parseOps,
  pickLang,
  renameOwners,
  renderNotes,
  speakerLabel,
  speakerStats,
  transcriptLines,
  turns,
} from './meeting-notes';

const ana: MeetingSpeaker = { id: 'r1', number: 1, side: 'room', name: 'Ana' };
const two: MeetingSpeaker = { id: 'r2', number: 2, side: 'room', name: null };
const far: MeetingSpeaker = { id: 'x1', number: 3, side: 'remote', name: null };

function item(patch: Partial<MeetingItem>): MeetingItem {
  return { id: 'i1', kind: 'agreement', text: 'Entregar el viernes', owner: null, due: null, status: 'active', locked: false, at: 10, updatedBy: 'ai', history: [], ...patch };
}

describe('what clients send', () => {
  it('keeps valid speakers, each with its own number', () => {
    const out = cleanSpeakers([
      { id: 'r1', number: 1, side: 'room', name: '  Ana   María ' },
      { id: 'BAD ID', number: 2 },
      { id: 'r1', number: 5 },
      { id: 'x1', number: 1, side: 'elsewhere', name: '' },
      { id: 'x2' },
    ]);
    expect(out).toEqual([
      { id: 'r1', number: 1, side: 'room', name: 'Ana María' },
      { id: 'x1', number: 2, side: null, name: null },
      { id: 'x2', number: 3, side: null, name: null },
    ]);
    expect(cleanSpeakers('nope')).toEqual([]);
  });

  it('keeps segments with text, speaker and side only when valid', () => {
    const out = cleanSegments([
      { start: 1, end: 2, text: ' hola ', speaker: 'r1', side: 'room' },
      { start: 3, end: 4, text: '   ' },
      { start: 'x', end: 5, text: 'sin tiempos', speaker: 'Not Valid', side: 'moon' },
    ]);
    expect(out).toEqual([
      { start: 1, end: 2, text: 'hola', speaker: 'r1', side: 'room' },
      { start: 0, end: 5, text: 'sin tiempos' },
    ]);
  });
});

describe('labels', () => {
  it('uses the name, else a numbered default, with the side in virtual meetings', () => {
    expect(speakerLabel(ana, 'virtual', 'es')).toBe('Ana');
    expect(speakerLabel(two, 'in_person', 'es')).toBe('Persona 2');
    expect(speakerLabel(two, 'virtual', 'es')).toBe('Persona 2 (sala)');
    expect(speakerLabel(far, 'virtual', 'es')).toBe('Persona 3 (remoto)');
    expect(speakerLabel(far, 'virtual', 'en')).toBe('Speaker 3 (remote)');
    expect(defaultLabel(far, 'virtual', 'en', false)).toBe('Speaker 3');
  });

  it('picks the language of the person, else the one spoken', () => {
    expect(pickLang('es-ES', 'en')).toBe('es');
    expect(pickLang('en-US', 'es')).toBe('en');
    expect(pickLang(null, 'es')).toBe('es');
    expect(pickLang(undefined, null)).toBe('en');
  });

  it('matches whole labels only, the longest form first', () => {
    const forms = labelForms(far, 'virtual');
    expect(forms[0].length).toBeGreaterThanOrEqual(forms[forms.length - 1].length);
    expect(forms).toEqual(expect.arrayContaining(['Persona 3 (remoto)', 'Persona 3', 'Speaker 3 (remote)', 'Speaker 3']));
    const pattern = labelPattern(forms)!;
    const text = 'Persona 3 (remoto): hola. Persona 3 dijo que Persona 33 y Persona 3. Speaker 3 too';
    expect(text.replace(pattern, 'Luis')).toBe('Luis: hola. Luis dijo que Persona 33 y Luis. Luis too');
    expect(labelForms(ana, 'virtual')).toEqual(['Ana']);
    expect('Ana y Anabel y Mariana'.replace(labelPattern(['Ana'])!, 'Ana María')).toBe('Ana María y Anabel y Mariana');
    expect(labelPattern([])).toBeNull();
  });
});

describe('turns', () => {
  const segments = [
    { start: 0, end: 4, text: 'Buenos días.', speaker: 'r1', side: 'room' as const },
    { start: 4, end: 8, text: 'Empecemos.', speaker: 'r1', side: 'room' as const },
    { start: 9, end: 14, text: 'Hola a todos.', speaker: 'x1', side: 'remote' as const },
    { start: 15, end: 18, text: 'Sin voz conocida.', side: 'remote' as const },
    { start: 19, end: 22, text: 'Otra vez yo.', speaker: 'r1', side: 'room' as const },
  ];

  it('starts a paragraph whenever the voice changes', () => {
    const list = turns(segments, '', [ana, two, far], 'virtual', 'es');
    expect(list).toEqual([
      { start: 0, label: 'Ana', text: 'Buenos días. Empecemos.' },
      { start: 9, label: 'Persona 3 (remoto)', text: 'Hola a todos.' },
      { start: 15, label: 'Remoto', text: 'Sin voz conocida.' },
      { start: 19, label: 'Ana', text: 'Otra vez yo.' },
    ]);
    expect(transcriptLines(list)).toContain('[00:09] Persona 3 (remoto): Hola a todos.');
    expect(transcriptLines(list, false).split('\n')[0]).toBe('Ana: Buenos días. Empecemos.');
  });

  it('falls back to the plain text when there are no segments', () => {
    const list = turns([], 'Una frase. Otra frase.', [], null, 'es');
    expect(list).toEqual([{ start: null, label: null, text: 'Una frase. Otra frase.' }]);
  });

  it('counts what each speaker said', () => {
    const stats = speakerStats(segments);
    expect(stats.get('r1')).toEqual({ seconds: 11, segments: 3, sample: 'Buenos días.' });
    expect(stats.get('x1')?.segments).toBe(1);
    expect(stats.has('r2')).toBe(false);
  });
});

describe('the list the model keeps', () => {
  it('adds, never twice, and numbers ids', () => {
    const first = applyModelOps([], [{ op: 'add', kind: 'task', text: 'Enviar la cotización', owner: 'Ana', due: 'viernes' }], 30);
    expect(first.changed).toBe(true);
    expect(first.items).toEqual([
      { id: 'i1', kind: 'task', text: 'Enviar la cotización', owner: 'Ana', due: 'viernes', status: 'active', locked: false, at: 30, updatedBy: 'ai', history: [] },
    ]);
    const again = applyModelOps(first.items, [{ op: 'add', kind: 'task', text: 'enviar la cotizacion.' }, { op: 'add', text: 'Otra cosa' }], 40);
    expect(again.items.map((i) => i.id)).toEqual(['i1', 'i2']);
    expect(again.items[1].kind).toBe('agreement');
  });

  it('changes an entry and remembers what it said before', () => {
    const out = applyModelOps([item({})], [{ op: 'update', id: 'i1', text: 'Entregar el lunes', due: 'lunes' }], 95);
    expect(out.changed).toBe(true);
    expect(out.items[0]).toMatchObject({ text: 'Entregar el lunes', due: 'lunes', at: 95, updatedBy: 'ai' });
    expect(out.items[0].history).toEqual([{ text: 'Entregar el viernes', owner: null, due: null, status: 'active', at: 10, by: 'ai' }]);
  });

  it('cancels and restores', () => {
    const cancelled = applyModelOps([item({})], [{ op: 'cancel', id: 'i1' }], 50);
    expect(cancelled.items[0].status).toBe('cancelled');
    const back = applyModelOps(cancelled.items, [{ op: 'restore', id: 'i1' }], 60);
    expect(back.items[0].status).toBe('active');
    expect(back.items[0].history).toHaveLength(2);
  });

  it('leaves locked entries and unknown ids alone, and reports nothing changed', () => {
    const locked = item({ locked: true, updatedBy: 'user' });
    const out = applyModelOps([locked], [{ op: 'update', id: 'i1', text: 'Otra' }, { op: 'cancel', id: 'i1' }, { op: 'cancel', id: 'i9' }, { op: 'update', id: 'i1' }], 70);
    expect(out.changed).toBe(false);
    expect(out.items).toEqual([locked]);
    expect(applyModelOps([item({})], [{ op: 'update', id: 'i1', text: 'Entregar el viernes' }], 70).changed).toBe(false);
  });

  it('with the new text at hand, only changes entries that text is about', () => {
    const list = [item({}), item({ id: 'i2', kind: 'task', text: 'Enviar la cotización', owner: 'Luis', due: 'mañana' })];
    const fresh = '[01:00] Ana: Pensándolo mejor, el viernes no llegamos. Mejor entregamos el informe el lunes.';
    const ops = [
      { op: 'update' as const, id: 'i1', text: 'Entregar el lunes' },
      { op: 'update' as const, id: 'i2', due: 'lunes' },
      { op: 'cancel' as const, id: 'i2' },
      { op: 'add' as const, kind: 'task' as const, text: 'Avisar al cliente' },
    ];
    const out = applyModelOps(list, ops, 70, fresh);
    expect(out.items[0].text).toBe('Entregar el lunes');
    // nobody talked about the quote: it stays as it was
    expect(out.items[1]).toMatchObject({ due: 'mañana', status: 'active', history: [] });
    expect(out.items[2].text).toBe('Avisar al cliente');
    // said in other words of the same family, it does count
    expect(applyModelOps(list, [{ op: 'cancel', id: 'i2' }], 80, 'Luis: la cotizacion ya no hace falta.').items[1].status).toBe('cancelled');
    // one common word shared with a long entry is not a mention of it
    const report = 'Paulina: Volviendo a la entrega, el viernes no llegamos. La entrega del informe al cliente pasa al lunes.';
    expect(mentions(report, { text: 'Enviar la cotización al cliente mañana' })).toBe(false);
    expect(mentions(report, { text: 'Entregamos el informe al cliente el viernes' })).toBe(true);
    expect(mentions(report, { text: '¿Y?' })).toBe(true);
    expect(mentions('The quote goes out on Monday', { text: 'Send the quote' })).toBe(true);
    expect(mentions('We will meet then, after that', { text: 'Send the quote' })).toBe(false);
  });

  it('moves the date or the owner along when the model only rewrites the sentence', () => {
    const report = item({ text: 'Entregamos el informe al cliente el viernes', due: 'viernes' });
    const moved = applyModelOps([report], [{ op: 'update', id: 'i1', text: 'Entregamos el informe al cliente el lunes.' }], 70);
    expect(moved.items[0]).toMatchObject({ text: 'Entregamos el informe al cliente el lunes.', due: 'lunes' });
    expect(moved.items[0].history).toEqual([expect.objectContaining({ text: 'Entregamos el informe al cliente el viernes', due: 'viernes' })]);
    // a date of several words keeps the words that did not change
    const morning = item({ text: 'Llamar al cliente el viernes por la mañana', due: 'viernes por la mañana' });
    expect(applyModelOps([morning], [{ op: 'update', id: 'i1', text: 'Llamar al cliente el lunes por la mañana' }], 70).items[0].due).toBe('lunes por la mañana');
    // the owner too
    const quote = item({ kind: 'task', text: 'Ana envía la cotización', owner: 'Ana', due: 'mañana' });
    expect(applyModelOps([quote], [{ op: 'update', id: 'i1', text: 'Luis envía la cotización' }], 70).items[0]).toMatchObject({ owner: 'Luis', due: 'mañana' });
    // what the model says itself wins
    expect(applyModelOps([report], [{ op: 'update', id: 'i1', text: 'Entregamos el informe al cliente el lunes', due: 'lunes 14' }], 70).items[0].due).toBe('lunes 14');
    expect(applyModelOps([report], [{ op: 'update', id: 'i1', text: 'Entregamos el informe al cliente el lunes', due: null }], 70).items[0].due).toBeNull();
    // a field the sentence never said, or a sentence written anew, is left alone
    const apart = item({ text: 'Entregamos el informe al cliente', due: 'viernes' });
    expect(applyModelOps([apart], [{ op: 'update', id: 'i1', text: 'Entregamos el informe al cliente el lunes' }], 70).items[0].due).toBe('viernes');
    expect(applyModelOps([quote], [{ op: 'update', id: 'i1', text: 'Enviar la cotización al cliente' }], 70).items[0].owner).toBe('Ana');
    expect(applyModelOps([report], [{ op: 'update', id: 'i1', text: 'El informe del cliente se entrega cuando esté la revisión completa de todo el equipo' }], 70).items[0].due).toBe('viernes');
  });

  it('rewrites the sentence when the model only changes the date or the owner', () => {
    const report = item({ text: 'Entregamos el informe al cliente el Viernes', due: 'viernes' });
    const moved = applyModelOps([report], [{ op: 'update', id: 'i1', due: 'lunes' }], 70);
    expect(moved.items[0]).toMatchObject({ text: 'Entregamos el informe al cliente el lunes', due: 'lunes' });
    expect(moved.items[0].history).toEqual([expect.objectContaining({ text: 'Entregamos el informe al cliente el Viernes', due: 'viernes' })]);
    // the same sentence given back with a full stop counts as left alone
    expect(applyModelOps([report], [{ op: 'update', id: 'i1', text: 'entregamos el informe al cliente el viernes.', due: 'lunes 9:00' }], 70).items[0].text).toBe('entregamos el informe al cliente el lunes 9:00.');
    const quote = item({ kind: 'task', text: 'Ana envía la cotización (urgente)', owner: 'Ana', due: 'mañana' });
    expect(applyModelOps([quote], [{ op: 'update', id: 'i1', owner: 'Luis' }], 70).items[0]).toMatchObject({ text: 'Luis envía la cotización (urgente)', owner: 'Luis', due: 'mañana' });
    // a date taken away, or one the sentence never said, leaves the sentence alone
    expect(applyModelOps([report], [{ op: 'update', id: 'i1', due: null }], 70).items[0]).toMatchObject({ text: 'Entregamos el informe al cliente el Viernes', due: null });
    const apart = item({ text: 'Entregamos el informe al cliente', due: 'viernes' });
    expect(applyModelOps([apart], [{ op: 'update', id: 'i1', due: 'lunes' }], 70).items[0]).toMatchObject({ text: 'Entregamos el informe al cliente', due: 'lunes' });
    // "Ana" inside another word is not the owner
    const anabel = item({ kind: 'task', text: 'Anabel envía la cotización', owner: 'Ana' });
    expect(applyModelOps([anabel], [{ op: 'update', id: 'i1', owner: 'Luis' }], 70).items[0].text).toBe('Anabel envía la cotización');
    // the final pass keeps them in step too, both ways
    const live = [item({ text: 'Entregamos el informe el viernes', due: 'viernes' }), item({ id: 'i2', kind: 'task', text: 'Ana envía la cotización', owner: 'Ana' })];
    const final = mergeFinalItems(
      live,
      [
        { id: 'i1', kind: 'agreement', text: 'Entregamos el informe el viernes', due: 'lunes', status: 'active' },
        { id: 'i2', kind: 'task', text: 'Luis envía la cotización', owner: 'Ana', due: null, status: 'active' },
      ],
      600,
    );
    expect(final[0]).toMatchObject({ text: 'Entregamos el informe el lunes', due: 'lunes' });
    expect(final[1]).toMatchObject({ text: 'Luis envía la cotización', owner: 'Luis' });
  });

  it('takes the word "null" for an empty owner or date', () => {
    const out = applyModelOps([], [{ op: 'add', kind: 'task', text: 'Cancelar la demo interna', owner: 'Diego', due: 'null' }, { op: 'add', text: 'Lanzar el lunes', owner: ' N/A ', due: '-' }], 30);
    expect(out.items.map((i) => [i.owner, i.due])).toEqual([['Diego', null], [null, null]]);
    const cleared = applyModelOps([item({ kind: 'task', owner: 'Ana', due: 'viernes' })], [{ op: 'update', id: 'i1', owner: 'None', due: 'Sin fecha' }], 40);
    expect(cleared.items[0]).toMatchObject({ owner: null, due: null });
    expect(mergeFinalItems([], [{ id: null, kind: 'task', text: 'Avisar al cliente', owner: 'null', due: 'undefined', status: 'active' }], 50)[0]).toMatchObject({ owner: null, due: null });
    // what an earlier version stored that way reads as empty too
    expect(cleanItems([{ id: 'i1', kind: 'task', text: 'Avisar', owner: 'null', due: 'NULL', status: 'active' }])[0]).toMatchObject({ owner: null, due: null });
  });

  it('keeps no "before" for an entry the model turned into another matter', () => {
    const delivery = item({ text: 'Entregamos el viernes', history: [{ text: 'Entregamos el jueves', owner: null, due: null, status: 'active', at: 5, by: 'ai' }] });
    const other = applyModelOps([delivery], [{ op: 'update', id: 'i1', text: 'Preparar la presentación para el cliente' }], 60);
    expect(other.items[0]).toMatchObject({ text: 'Preparar la presentación para el cliente', history: [] });
    // the same matter in other words keeps its story
    const same = applyModelOps([delivery], [{ op: 'update', id: 'i1', text: 'La entrega pasa al lunes' }], 60);
    expect(same.items[0].history.map((h) => h.text)).toEqual(['Entregamos el jueves', 'Entregamos el viernes']);
    // the final pass too
    const final = mergeFinalItems([delivery, item({ id: 'i2', kind: 'task', text: 'Preparar la presentación' })], [{ id: 'i1', kind: 'task', text: 'Actualizar el calendario del proyecto', owner: 'Luis', status: 'active' }], 600);
    expect(final[0]).toMatchObject({ id: 'i1', text: 'Actualizar el calendario del proyecto', owner: 'Luis', history: [] });
  });

  it('takes the same sentence with another date as a change, not as a new entry', () => {
    const launch = item({ text: 'lanzar el viernes 28 de noviembre', due: 'viernes 28 de noviembre' });
    const notes = item({ id: 'i2', kind: 'task', text: 'Preparar las notas', owner: 'Diego', due: 'jueves' });
    const out = applyModelOps([launch, notes], [{ op: 'add', kind: 'agreement', text: 'lanzar el lunes 1 de diciembre', due: 'lunes 1 de diciembre' }], 80);
    expect(out.items).toHaveLength(2);
    expect(out.items[0]).toMatchObject({ id: 'i1', text: 'lanzar el lunes 1 de diciembre', due: 'lunes 1 de diciembre' });
    expect(out.items[0].history.map((h) => h.text)).toEqual(['lanzar el viernes 28 de noviembre']);
    // the date in its own field only: the sentence is the same word for word
    const moved = applyModelOps([launch, notes], [{ op: 'add', kind: 'task', text: 'preparar las notas.', owner: 'Diego', due: 'viernes' }], 80);
    expect(moved.items).toHaveLength(2);
    expect(moved.items[1]).toMatchObject({ id: 'i2', due: 'viernes', owner: 'Diego' });
    // the same date said with more or fewer words is no change
    expect(applyModelOps([launch, notes], [{ op: 'add', kind: 'task', text: 'Preparar las notas', due: 'el jueves' }], 80).changed).toBe(false);
    // another person, a locked entry or a cancelled one: a new entry
    expect(applyModelOps([launch, notes], [{ op: 'add', kind: 'task', text: 'Preparar las notas del lunes', owner: 'Ana', due: 'lunes' }], 80).items).toHaveLength(3);
    const locked = item({ text: 'lanzar el viernes', due: 'viernes', locked: true, updatedBy: 'user' });
    const beside = applyModelOps([locked], [{ op: 'add', text: 'lanzar el lunes', due: 'lunes' }], 80);
    expect(beside.items.map((i) => i.text)).toEqual(['lanzar el viernes', 'lanzar el lunes']);
    const off = item({ text: 'lanzar el viernes', due: 'viernes', status: 'cancelled' });
    expect(applyModelOps([off], [{ op: 'add', text: 'lanzar el lunes', due: 'lunes' }], 80).items).toHaveLength(2);
    // with the new text at hand, only when that text is about the entry
    const about = applyModelOps([launch, notes], [{ op: 'add', text: 'lanzar el lunes 1 de diciembre', due: 'lunes 1 de diciembre' }], 80, 'Ana: Mejor lanzamos el lunes 1 de diciembre.');
    expect(about.items).toHaveLength(2);
    const elsewhere = applyModelOps([launch, notes], [{ op: 'add', text: 'Preparar las notas', owner: 'Diego', due: 'viernes' }], 80, 'Ana: Mejor lanzamos el lunes.');
    expect(elsewhere.items[1].due).toBe('jueves');
    expect(elsewhere.items).toHaveLength(2);
  });

  it('reads what a model answers, however it wraps it', () => {
    expect(parseOps(parseJson('```json\n{"ops":[{"op":"ADD","kind":"task","text":"x","owner":null}]}\n```'))).toEqual([
      { op: 'add', id: undefined, kind: 'task', text: 'x', owner: null, due: undefined },
    ]);
    expect(parseOps(parseJson('Sure! {"ops": [{"op":"explode"},{"op":"cancel","id":"i2"}]} done'))).toEqual([
      { op: 'cancel', id: 'i2', kind: undefined, text: undefined, owner: undefined, due: undefined },
    ]);
    expect(parseOps(parseJson('not json at all'))).toEqual([]);
  });
});

describe('the list the person edits', () => {
  it('adds a locked entry and locks what it touches', () => {
    const added = applyUserOp([item({})], { op: 'add', kind: 'task', text: 'Llamar al cliente', owner: 'Luis' }, 80);
    expect(added[1]).toMatchObject({ id: 'i2', kind: 'task', owner: 'Luis', locked: true, updatedBy: 'user' });
    const edited = applyUserOp(added, { op: 'update', id: 'i1', due: 'martes' }, 90);
    expect(edited[0]).toMatchObject({ due: 'martes', locked: true, updatedBy: 'user' });
    expect(edited[0].history).toHaveLength(1);
    const cancelled = applyUserOp(edited, { op: 'cancel', id: 'i2' }, 91);
    expect(cancelled[1].status).toBe('cancelled');
    expect(applyUserOp(cancelled, { op: 'restore', id: 'i2' }, 92)[1].status).toBe('active');
    expect(applyUserOp(cancelled, { op: 'remove', id: 'i1' }, 93).map((i) => i.id)).toEqual(['i2']);
  });

  it('refuses an empty text and an unknown entry', () => {
    expect(() => applyUserOp([], { op: 'add', text: '   ' }, 0)).toThrow('needs its text');
    expect(() => applyUserOp([item({})], { op: 'update', id: 'i1', text: '' }, 0)).toThrow('needs its text');
    expect(() => applyUserOp([item({})], { op: 'cancel', id: 'i7' }, 0)).toThrow('not in the list');
  });
});

describe('the final list', () => {
  it('lays the model answer over the live list', () => {
    const live = [
      item({}),
      item({ id: 'i2', kind: 'task', text: 'Enviar la cotización', owner: 'Ana' }),
      item({ id: 'i3', text: 'Usar el proveedor nuevo', locked: true, updatedBy: 'user' }),
      item({ id: 'i4', text: 'Nadie lo devolvió' }),
    ];
    const out = mergeFinalItems(
      live,
      [
        { id: 'i1', kind: 'agreement', text: 'Entregar el lunes', due: 'lunes', status: 'active' },
        { id: null, kind: 'task', text: 'enviar la cotizacion', owner: 'Ana', due: 'jueves', status: 'active' },
        { id: 'i3', kind: 'agreement', text: 'Cambiado por el modelo', status: 'cancelled' },
        { id: null, kind: 'task', text: 'Reservar la sala', owner: null, due: null, status: 'active' },
        { id: null, text: '   ' },
      ],
      600,
    );
    expect(out.map((i) => i.id)).toEqual(['i1', 'i2', 'i3', 'i4', 'i5']);
    expect(out[0]).toMatchObject({ text: 'Entregar el lunes', due: 'lunes' });
    expect(out[0].history[0].text).toBe('Entregar el viernes');
    // found by its text, kept its id and gained the date
    expect(out[1]).toMatchObject({ id: 'i2', due: 'jueves', owner: 'Ana' });
    expect(out[2]).toMatchObject({ text: 'Usar el proveedor nuevo', status: 'active', locked: true });
    expect(out[3].text).toBe('Nadie lo devolvió');
    expect(out[4]).toMatchObject({ kind: 'task', text: 'Reservar la sala', updatedBy: 'ai' });
    expect(mergeFinalItems(live, 'garbage', 1)).toEqual(live);
  });

  it('goes by the text when the model mixes the ids, and keeps no entry twice', () => {
    const live = [
      item({ text: 'lanzar el viernes 28 de noviembre', due: 'viernes 28 de noviembre' }),
      item({ id: 'i2', text: 'lanzar el lunes 1 de diciembre', due: 'lunes 1 de diciembre' }),
      item({ id: 'i3', text: 'Llamar al proveedor', locked: true, updatedBy: 'user' }),
    ];
    const out = mergeFinalItems(
      live,
      [
        { id: 'i1', kind: 'agreement', text: 'lanzar el lunes 1 de diciembre', due: 'lunes 1 de diciembre', status: 'active' },
        // the id of the second entry with the text of the third
        { id: 'i2', kind: 'agreement', text: 'Llamar al proveedor', status: 'active' },
        { id: null, kind: 'task', text: 'llamar al proveedor.', owner: 'Ana', status: 'active' },
      ],
      600,
    );
    // the first entry took the final date and its double is gone; the entry of
    // the person was not copied over another one, nor changed
    expect(out.map((i) => [i.id, i.text])).toEqual([
      ['i1', 'lanzar el lunes 1 de diciembre'],
      ['i3', 'Llamar al proveedor'],
    ]);
    expect(out[0].history.map((h) => h.text)).toEqual(['lanzar el viernes 28 de noviembre']);
    expect(out[1]).toMatchObject({ locked: true, owner: null });
    // two alike in the live list: one stays, and the person's wins over the model's
    const twice = [item({ text: 'Lanzar el lunes' }), item({ id: 'i2', text: 'lanzar el lunes.' }), item({ id: 'i3', text: 'Avisar al cliente' }), item({ id: 'i4', text: 'avisar al cliente', locked: true, updatedBy: 'user' })];
    expect(mergeFinalItems(twice, [], 600).map((i) => i.id)).toEqual(['i1', 'i4']);
    // a cancelled entry and an active one with the same words are two things
    const both = [item({ text: 'Lanzar el lunes', status: 'cancelled' }), item({ id: 'i2', text: 'Lanzar el lunes' })];
    expect(mergeFinalItems(both, 'garbage', 600)).toHaveLength(2);
  });

  it('goes by the words when the model gives the list back with the ids crossed', () => {
    const live = [
      item({ text: 'Queda aprobado el presupuesto de doce mil dólares.' }),
      item({
        id: 'i2',
        kind: 'task',
        text: 'Yo le envío el contrato al proveedor antes del miércoles.',
        owner: 'Marta',
        due: 'miércoles',
        history: [{ text: 'Yo le envío el contrato al proveedor antes del miércoles.', owner: 'Carla', due: 'miércoles', status: 'active', at: 20, by: 'ai' }],
      }),
      item({ id: 'i3', kind: 'task', text: 'Yo preparo la demostración para el cliente, la tengo lista el jueves.', owner: 'Luis', due: 'jueves' }),
    ];
    const out = mergeFinalItems(
      live,
      [
        { id: 'i1', kind: 'agreement', text: 'Queda aprobado el presupuesto de doce mil dólares.', status: 'active' },
        // each of the two under the id of the other, one of them with the day the meeting moved it to
        { id: 'i2', kind: 'task', text: 'Yo preparo la demostración para el cliente, la tengo lista el martes.', owner: 'Luis', due: 'martes', status: 'active' },
        { id: 'i3', kind: 'task', text: 'Yo le envío el contrato al proveedor antes del miércoles.', owner: 'Marta', due: 'miércoles', status: 'active' },
        { id: null, kind: 'task', text: 'Pedir las fotos al fotógrafo', owner: 'Luis', status: 'active' },
      ],
      600,
    );
    expect(out.map((i) => [i.id, i.owner, i.due])).toEqual([
      ['i1', null, null],
      ['i2', 'Marta', 'miércoles'],
      ['i3', 'Luis', 'martes'],
      ['i4', 'Luis', null],
    ]);
    // each entry kept its own past, and the one that moved says from when
    expect(out[1].history.map((h) => h.owner)).toEqual(['Carla']);
    expect(out[2].history.map((h) => h.due)).toEqual(['jueves']);
    expect(beforeTheChange(out[2])).toContain('jueves');

    // the entry of that id does not come back: nothing says the ids are
    // crossed, so the id decides as it always did
    const reused = mergeFinalItems(
      [item({ text: 'Página de precios lista para revisión' }), item({ id: 'i2', kind: 'task', text: 'Avisar al cliente del cambio de fecha' })],
      [{ id: 'i1', kind: 'task', text: 'Avisar al cliente del cambio de fecha', status: 'active' }],
      600,
    );
    expect(reused.map((i) => [i.id, i.text, i.history.length])).toEqual([['i1', 'Avisar al cliente del cambio de fecha', 0]]);

    // two entries that read alike, each given back under its own id with a new day: nothing is crossed
    const alike = mergeFinalItems(
      [item({ kind: 'task', text: 'Preparar el informe de ventas para el lunes' }), item({ id: 'i2', kind: 'task', text: 'Preparar el informe de compras para el lunes' })],
      [
        { id: 'i1', kind: 'task', text: 'Preparar el informe de ventas para el martes', status: 'active' },
        { id: 'i2', kind: 'task', text: 'Preparar el informe de compras para el martes', status: 'active' },
      ],
      600,
    );
    expect(alike.map((i) => [i.id, i.text, i.history.map((h) => h.text)])).toEqual([
      ['i1', 'Preparar el informe de ventas para el martes', ['Preparar el informe de ventas para el lunes']],
      ['i2', 'Preparar el informe de compras para el martes', ['Preparar el informe de compras para el lunes']],
    ]);
  });

  it('follows a speaker that got a name', () => {
    const items = [
      item({ kind: 'task', owner: 'Persona 3 (remoto)', history: [{ text: 'Lo hace Persona 3', owner: 'Persona 3 (remoto)', due: null, status: 'active', at: 1, by: 'ai' }] }),
      item({ id: 'i2', owner: 'Persona 33' }),
      item({ id: 'i3', text: 'Persona 3 revisa el contrato' }),
    ];
    const out = renameOwners(items, labelPattern(labelForms(far, 'virtual')), 'Luis');
    expect(out.map((i) => i.owner)).toEqual(['Luis', 'Persona 33', null]);
    expect(out[0].history[0]).toMatchObject({ text: 'Lo hace Luis', owner: 'Luis' });
    expect(out[2].text).toBe('Luis revisa el contrato');
  });
});

describe('the page', () => {
  const list = turns(
    [
      { start: 0, end: 5, text: 'Entregamos el viernes.', speaker: 'r1' },
      { start: 65, end: 70, text: 'Mejor el lunes.', speaker: 'r2' },
    ],
    '',
    [ana, two],
    'in_person',
    'es',
  );
  const items: MeetingItem[] = [
    item({ text: 'Entregar el lunes', due: 'lunes', history: [{ text: 'Entregar el viernes', owner: null, due: 'viernes', status: 'active', at: 5, by: 'ai' }] }),
    item({ id: 'i2', kind: 'task', text: 'Enviar la cotización', owner: 'Ana', due: 'jueves' }),
    item({ id: 'i3', text: 'Contratar otro proveedor', status: 'cancelled' }),
  ];

  it('writes the notes in the language of the person', () => {
    const md = renderNotes({ title: 'Entrega', summary: 'Se movió la entrega.', topics: ['Entrega', 'Cotización'] }, items, list, {
      fileName: 'Reunión',
      durationSeconds: 75,
      language: 'es',
      mode: 'in_person',
      lang: 'es',
    });
    expect(md).toContain('## Resumen\n\nSe movió la entrega.');
    expect(md).toContain('**Temas:** Entrega · Cotización');
    expect(md).toContain('## Acuerdos\n\n- Entregar el lunes · lunes\n');
    expect(md).toContain('## Tareas\n\n- [ ] Enviar la cotización — Ana · jueves\n');
    expect(md).toContain('## Cambios durante la reunión\n\n- ~~Entregar el viernes · viernes~~ → Entregar el lunes · lunes\n- ~~Contratar otro proveedor~~ (cancelado)');
    expect(md).toContain('_Reunión · 01:15 · es · Presencial_');
    expect(md).toContain('**[00:00] Ana:** Entregamos el viernes.');
    expect(md).toContain('**[01:05] Persona 2:** Mejor el lunes.');
    // a cancelled entry is not among the agreements
    expect(md.split('## Cambios')[0]).not.toContain('Contratar otro proveedor');
  });

  it('shows what an entry first said only when the meeting changed it', () => {
    const friday = { text: 'Entregar el viernes', owner: null, due: null, status: 'active' as const, at: 5, by: 'ai' as const };
    const monday = { text: 'Entregar el lunes', owner: null, due: null, status: 'active' as const, at: 60, by: 'ai' as const };
    // the meeting moved it, then the person added the hour: the story is Friday -> now
    expect(beforeTheChange(item({ text: 'Entregar el lunes', due: '9:00', updatedBy: 'user', locked: true, history: [friday, monday] }))).toBe('Entregar el viernes');
    // only the person reworded it
    expect(beforeTheChange(item({ text: 'Entrega final el viernes', updatedBy: 'user', locked: true, history: [friday] }))).toBeNull();
    // changed and changed back
    expect(beforeTheChange(item({ text: 'Entregar el viernes', history: [friday, monday] }))).toBe('Entregar el lunes');
    expect(beforeTheChange(item({ history: [] }))).toBeNull();
  });

  it('keeps the English headings old notes had, and leaves out empty sections', () => {
    const md = renderNotes({ title: '', summary: '', topics: [] }, [], turns([], 'Just text.', [], null, 'en'), {
      fileName: 'call.m4a',
      durationSeconds: null,
      language: null,
      mode: null,
      lang: 'en',
    });
    expect(md).toBe('## Transcript\n\n_call.m4a_\n\nJust text.\n');
    const full = renderNotes({ title: '', summary: 'S', topics: [] }, [item({ text: 'Ship', kind: 'agreement' }), item({ id: 'i2', kind: 'task', text: 'Call' })], [], {
      fileName: 'm',
      durationSeconds: 5,
      language: 'en',
      mode: 'virtual',
      lang: 'en',
    });
    expect(full).toContain('## Summary');
    expect(full).toContain('## Decisions\n\n- Ship');
    expect(full).toContain('## Action items\n\n- [ ] Call');
    expect(full).not.toContain('Changes during');
    expect(full).toContain('_m · 00:05 · en · Virtual_');
  });
});
