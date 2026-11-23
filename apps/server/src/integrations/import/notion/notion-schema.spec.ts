import { cellOf, fileRef, fileRefs, ImportNote, mapSchema, mapView } from './notion-schema';

const rich = (text: string) => [{ type: 'text', plain_text: text }];

const schema = {
  Name: { id: 'title', name: 'Name', type: 'title', title: {} },
  Notes: { id: 'a1', name: 'Notes', type: 'rich_text', rich_text: {} },
  Budget: { id: 'a2', name: 'Budget', type: 'number', number: { format: 'euro' } },
  Share: { id: 'a3', name: 'Share', type: 'number', number: { format: 'percent' } },
  Kind: { id: 'a4', name: 'Kind', type: 'select', select: { options: [{ id: 'o1', name: 'Bug', color: 'red' }, { id: 'o2', name: 'Idea', color: 'purple' }] } },
  Tags: { id: 'a5', name: 'Tags', type: 'multi_select', multi_select: { options: [{ id: 't1', name: 'Web', color: 'blue' }, { id: 't2', name: 'iOS', color: 'default' }] } },
  State: {
    id: 'a6',
    name: 'State',
    type: 'status',
    status: {
      options: [{ id: 's1', name: 'Not started', color: 'default' }, { id: 's2', name: 'Doing', color: 'blue' }, { id: 's3', name: 'Done', color: 'green' }],
      groups: [{ id: 'g1', name: 'To-do', option_ids: ['s1'] }, { id: 'g2', name: 'In progress', option_ids: ['s2'] }, { id: 'g3', name: 'Complete', option_ids: ['s3'] }],
    },
  },
  When: { id: 'a7', name: 'When', type: 'date', date: {} },
  Done: { id: 'a8', name: 'Done', type: 'checkbox', checkbox: {} },
  Link: { id: 'a9', name: 'Link', type: 'url', url: {} },
  Mail: { id: 'b1', name: 'Mail', type: 'email', email: {} },
  Phone: { id: 'b2', name: 'Phone', type: 'phone_number', phone_number: {} },
  Owner: { id: 'b3', name: 'Owner', type: 'people', people: {} },
  Total: { id: 'b4', name: 'Total', type: 'formula', formula: { expression: 'prop("Budget") * 2' } },
  Project: { id: 'b5', name: 'Project', type: 'relation', relation: { data_source_id: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', type: 'single_property', single_property: {} } },
  Docs: { id: 'b6', name: 'Docs', type: 'files', files: {} },
  Ref: { id: 'b7', name: 'Ref', type: 'unique_id', unique_id: { prefix: 'TASK' } },
  Press: { id: 'b8', name: 'Press', type: 'button', button: {} },
  Made: { id: 'b9', name: 'Made', type: 'created_time', created_time: {} },
  Sum: { id: 'c1', name: 'Sum', type: 'rollup', rollup: { function: 'sum' } },
  notes: { id: 'c2', name: 'notes', type: 'rich_text', rich_text: {} },
};

const row = {
  Name: { type: 'title', title: rich(' Ship it ') },
  Notes: { type: 'rich_text', rich_text: rich('Two words') },
  Budget: { type: 'number', number: 1200.5 },
  Share: { type: 'number', number: null },
  Kind: { type: 'select', select: { id: 'o2', name: 'Idea', color: 'purple' } },
  Tags: { type: 'multi_select', multi_select: [{ id: 't1', name: 'Web' }, { id: 'gone', name: 'iOS' }, { id: 'x', name: 'Unknown' }] },
  State: { type: 'status', status: { id: 's2', name: 'Doing' } },
  When: { type: 'date', date: { start: '2026-12-01', end: '2026-12-03T10:00:00.000-05:00', time_zone: null } },
  Done: { type: 'checkbox', checkbox: true },
  Link: { type: 'url', url: ' https://example.com/x ' },
  Mail: { type: 'email', email: 'ana@example.com' },
  Phone: { type: 'phone_number', phone_number: '+593 99 123 4567' },
  Owner: { type: 'people', people: [{ object: 'user', id: 'u1', name: 'Ana' }, { object: 'user', id: 'u2' }, { object: 'user', id: 'u3', name: 'Luis' }] },
  Total: { type: 'formula', formula: { type: 'number', number: 2401 } },
  Project: { type: 'relation', relation: [{ id: 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB' }], has_more: false },
  Docs: { type: 'files', files: [] },
  Ref: { type: 'unique_id', unique_id: { prefix: 'TASK', number: 42 } },
  Press: { type: 'button', button: {} },
  Made: { type: 'created_time', created_time: '2026-11-20T15:00:00.000Z' },
  Sum: { type: 'rollup', rollup: { type: 'number', number: 7, function: 'sum' } },
  notes: { type: 'rich_text', rich_text: [] },
};

describe('notion data source to a base', () => {
  const notes: ImportNote[] = [];
  const properties = mapSchema(schema, [row], notes);
  const by = (name: string) => properties.find((p) => p.name === name)!;

  it('maps the columns, the title first', () => {
    expect(properties[0]).toMatchObject({ name: 'Name', type: 'text', primary: true });
    expect(properties.filter((p) => p.type).map((p) => `${p.name}:${p.type}`)).toEqual([
      'Name:text',
      'Notes:text',
      'Budget:number',
      'Share:number',
      'Kind:select',
      'Tags:multiSelect',
      'State:status',
      'When:date',
      'When (end):date',
      'Done:checkbox',
      'Link:url',
      'Mail:email',
      'Phone:phone',
      'Owner:text',
      'Total:number',
      'Project:relation',
      'Docs:file',
      'Ref:text',
      'Made:date',
      'Sum:number',
      // a second column with the same name (apart from case) gets a number
      'notes 2:text',
    ]);
    expect(properties.filter((p) => !p.type).map((p) => p.notionName)).toEqual(['Press']);
    expect(by('Budget').typeOptions).toEqual({ format: 'currency', currencySymbol: '€' });
    expect(by('Share').typeOptions).toEqual({ format: 'percent' });
    expect(by('Kind').typeOptions).toEqual({
      choices: [{ id: 'p4c1', name: 'Bug', color: 'red' }, { id: 'p4c2', name: 'Idea', color: 'violet' }],
      choiceOrder: ['p4c1', 'p4c2'],
    });
    expect((by('State').typeOptions as any).choices.map((c: any) => c.category)).toEqual(['todo', 'inProgress', 'complete']);
    expect(by('When').typeOptions).toEqual({ includeTime: false });
    expect(by('When (end)')).toMatchObject({ endOf: 'When', typeOptions: { includeTime: true } });
    expect(by('Project').relationTarget).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(notes).toEqual(
      expect.arrayContaining([
        { code: 'people_as_names', name: 'Owner' },
        { code: 'formula_as_values', name: 'Total' },
        { code: 'column_type', name: 'Press', detail: 'button' },
        { code: 'rollup_as_values', name: 'Sum' },
      ]),
    );
  });

  it('reads each cell', () => {
    const cell = (name: string) => cellOf(by(name), (row as any)[by(name).notionName]);
    expect(cell('Name')).toBe('Ship it');
    expect(cell('Notes')).toBe('Two words');
    expect(cell('Budget')).toBe(1200.5);
    expect(cell('Share')).toBeUndefined();
    expect(cell('Kind')).toBe('p4c2');
    expect(cell('Tags')).toEqual(['p5c1', 'p5c2']);
    expect(cell('State')).toBe('p6c2');
    expect(cell('When')).toBe('2026-12-01T00:00:00.000Z');
    expect(cell('When (end)')).toBe('2026-12-03T15:00:00.000Z');
    expect(cell('Done')).toBe(true);
    expect(cell('Link')).toBe('https://example.com/x');
    expect(cell('Mail')).toBe('ana@example.com');
    expect(cell('Phone')).toBe('+593 99 123 4567');
    expect(cell('Owner')).toBe('Ana, Luis');
    expect(cell('Total')).toBe(2401);
    expect(cell('Project')).toEqual(['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']);
    expect(cell('Ref')).toBe('TASK-42');
    expect(cell('Made')).toBe('2026-11-20T15:00:00.000Z');
    expect(cell('Sum')).toBe(7);
    expect(cell('notes 2')).toBeUndefined();
  });

  it('leaves out what would not be accepted', () => {
    expect(cellOf(by('Link'), { type: 'url', url: 'not a link' })).toBeUndefined();
    expect(cellOf(by('Mail'), { type: 'email', email: 'nope' })).toBeUndefined();
    expect(cellOf(by('Phone'), { type: 'phone_number', phone_number: 'call me' })).toBeUndefined();
    expect(cellOf(by('Done'), { type: 'checkbox', checkbox: false })).toBeUndefined();
    expect(cellOf(by('Kind'), { type: 'select', select: null })).toBeUndefined();
    expect(cellOf(by('When'), { type: 'date', date: null })).toBeUndefined();
    expect(cellOf(by('Name'), undefined)).toBeUndefined();
  });

  it('gives a base without a title one, and types computed columns by what they hold', () => {
    const more: ImportNote[] = [];
    const mapped = mapSchema(
      { Flag: { id: 'f', name: 'Flag', type: 'formula', formula: {} }, Day: { id: 'd', name: 'Day', type: 'formula', formula: {} }, Label: { id: 'l', name: 'Label', type: 'formula', formula: {} } },
      [
        { Flag: { type: 'formula', formula: { type: 'boolean', boolean: true } }, Day: { type: 'formula', formula: { type: 'date', date: { start: '2026-01-02' } } }, Label: { type: 'formula', formula: { type: 'string', string: 'A' } } },
      ],
      more,
    );
    expect(mapped.map((p) => `${p.name}:${p.type}${p.primary ? '*' : ''}`)).toEqual(['Name:text*', 'Flag:checkbox', 'Day:date', 'Label:text']);
  });

  it('maps views and what they are set to', () => {
    const viewNotes: ImportNote[] = [];
    const board = mapView(
      { name: 'Board', type: 'board', filter: { property: 'Done', checkbox: { equals: false } }, sorts: [{ property: 'a2', direction: 'descending' }, { timestamp: 'created_time', direction: 'ascending' }], configuration: { type: 'board', group_by: { type: 'status', property_id: 'a6', sort: { type: 'manual' } }, properties: [{ property_id: 'title', visible: true }, { property_id: 'Notes', visible: false }, { property_id: 'zz', visible: true }] } },
      properties,
      viewNotes,
    );
    expect(board).toEqual({ name: 'Board', type: 'kanban', config: { groupBy: 'State', visible: ['Name'], hidden: ['Notes'], sorts: [{ property: 'Budget', direction: 'desc' }] } });
    expect(viewNotes).toContainEqual({ code: 'view_filter', name: 'Board' });
    expect(mapView({ name: 'Cal', type: 'calendar', configuration: { type: 'calendar', date_property_id: 'a7' } }, properties, viewNotes)).toEqual({ name: 'Cal', type: 'calendar', config: { calendarBy: 'When' } });
    expect(mapView({ name: 'Plan', type: 'timeline', configuration: { type: 'timeline', date_property_id: 'When' } }, properties, viewNotes)).toEqual({ name: 'Plan', type: 'timeline', config: { timelineStart: 'When', timelineEnd: 'When (end)' } });
    expect(mapView({ name: 'Cards', type: 'gallery', configuration: { type: 'gallery', cover_size: 'large' } }, properties, viewNotes)).toEqual({ name: 'Cards', type: 'gallery', config: { cardSize: 'large' } });
    expect(mapView({ name: '', type: 'table', configuration: null }, properties, viewNotes)).toEqual({ name: 'Table', type: 'table', config: {} });
    expect(mapView({ name: 'Untitled', type: 'gallery', configuration: null }, properties, viewNotes)!.name).toBe('Gallery');
    expect(mapView({ name: 'untitled', type: 'board', configuration: { type: 'board', group_by: { property_id: 'a6' } } }, properties, viewNotes)!.name).toBe('Board');
    // a board by a column that cannot group here comes as a table, and says so
    expect(mapView({ name: 'By owner', type: 'board', configuration: { type: 'board', group_by: { type: 'person', property_id: 'b3' } } }, properties, viewNotes)).toMatchObject({ name: 'By owner', type: 'table' });
    expect(viewNotes).toContainEqual({ code: 'board_as_table', name: 'By owner', detail: 'person b3' });
    // a board by a multi-select stays a board: a card shows under each of its options
    expect(mapView({ name: 'Days', type: 'board', configuration: { type: 'board', group_by: { type: 'multi_select', property_id: 'a5' } } }, properties, viewNotes)).toEqual({ name: 'Days', type: 'kanban', config: { groupBy: 'Tags' } });
    expect(viewNotes).not.toContainEqual({ code: 'board_as_table', name: 'Days' });
    // the picture of a card: a files column, or what the caller copies from each row's page
    expect(mapView({ name: 'Shots', type: 'gallery', configuration: { type: 'gallery', cover: { type: 'property', property_id: 'b6' }, cover_size: 'small' } }, properties, viewNotes)).toEqual({ name: 'Shots', type: 'gallery', config: { cover: 'Docs', cardSize: 'small' } });
    expect(mapView({ name: 'Covers', type: 'gallery', configuration: { type: 'gallery', cover: { type: 'page_cover' } } }, properties, viewNotes)!.config).toEqual({ coverFrom: 'page_cover' });
    expect(mapView({ name: 'First image', type: 'gallery', configuration: { type: 'gallery', cover: { type: 'page_content' } } }, properties, viewNotes)!.config).toEqual({ coverFrom: 'page_content' });
    expect(mapView({ name: 'No picture', type: 'gallery', configuration: { type: 'gallery', cover: null } }, properties, viewNotes)!.config).toEqual({});
    // the id of a column comes url-encoded in the schema and plain in a view, or the other way round
    const odd = mapSchema({ Name: { id: 'title', name: 'Name', type: 'title', title: {} }, Day: { id: '%3AvK%7B', name: 'Day', type: 'multi_select', multi_select: { options: [{ id: 'd1', name: 'Day 1', color: 'green' }] } }, Tags: { id: 'tg%40', name: 'Tags', type: 'multi_select', multi_select: { options: [] } } }, [], []);
    expect(mapView({ name: 'Days', type: 'board', configuration: { type: 'board', group_by: { type: 'multi_select', property_id: ':vK{', hide_empty_groups: true } } }, odd, viewNotes)).toEqual({ name: 'Days', type: 'kanban', config: { groupBy: 'Day', hideEmptyGroups: true } });
    expect(mapView({ name: 'By tags', type: 'board', configuration: { type: 'board', group_by: { type: 'multi_select', property_id: 'tg@' }, properties: [{ property_id: ':vK{', visible: false }] } }, odd, viewNotes)!.config).toEqual({ groupBy: 'Tags', hidden: ['Day'] });
    // an id the schema does not have: the kind of column and the name of the view say which one
    expect(mapView({ name: 'Days', type: 'board', configuration: { type: 'board', group_by: { type: 'multi_select', property_id: 'zzzz' } } }, odd, viewNotes)!.config.groupBy).toBe('Day');
    // two columns of that kind and a name that points at neither: a table, and what Notion asked for is kept
    expect(mapView({ name: 'Plan', type: 'board', configuration: { type: 'board', group_by: { type: 'multi_select', property_id: 'zzzz' } } }, odd, viewNotes)).toMatchObject({ type: 'table' });
    expect(viewNotes).toContainEqual({ code: 'board_as_table', name: 'Plan', detail: 'multi_select zzzz' });
    // a board that names no column groups by the status column
    expect(mapView({ name: 'Plain board', type: 'board', configuration: null }, properties, viewNotes)!.config.groupBy).toBe('State');
    expect(mapView({ name: 'Form', type: 'form', configuration: { type: 'form' } }, properties, viewNotes)).toBeNull();
    expect(viewNotes).toContainEqual({ code: 'view_type', name: 'Form', detail: 'form' });
  });

  it('reads the files of a cell as references for the caller to copy', () => {
    const docs = by('Docs');
    expect(cellOf(docs, { type: 'files', files: [] })).toBeUndefined();
    expect(
      cellOf(docs, {
        type: 'files',
        files: [
          { name: 'plan.pdf', type: 'file', file: { url: 'https://files.notion.test/plan.pdf?sig=1', expiry_time: '2026-01-01T00:00:00.000Z' } },
          { name: 'https://example.com/a.png', type: 'external', external: { url: 'https://example.com/a.png' } },
          { name: 'broken', type: 'file', file: {} },
        ],
      }),
    ).toEqual([
      { url: 'https://files.notion.test/plan.pdf?sig=1', name: 'plan.pdf', hosted: true },
      { url: 'https://example.com/a.png', name: 'https://example.com/a.png', hosted: false },
    ]);
    // the cover of a page has the same shape, without a name
    expect(fileRef({ type: 'external', external: { url: 'https://example.com/cover.jpg' } })).toEqual({ url: 'https://example.com/cover.jpg', name: null, hosted: false });
    expect(fileRef(null)).toBeNull();
    expect(fileRefs(undefined)).toEqual([]);
  });
});
