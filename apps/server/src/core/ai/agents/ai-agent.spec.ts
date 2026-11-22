import { agentPrompt, collect } from './ai-agent.service';
import { withFragment } from '../../page/suggestions/page-suggestion.service';

const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

describe('scheduled agents', () => {
  it('tells the model when it is, what it may do and where the result goes', () => {
    const base = {
      agentName: 'Weekly digest',
      workspaceName: 'Acme',
      personName: 'Ana',
      now: new Date('2026-11-23T13:00:00Z'),
      timezone: 'America/Guayaquil',
      lastRunAt: new Date('2026-11-16T13:00:00Z'),
      spaceName: null,
      canWrite: false,
      suggestEdits: true,
      output: 'page' as const,
      targetTitle: null,
    };
    const prompt = agentPrompt(base);
    expect(prompt).toContain('"Weekly digest"');
    expect(prompt).toContain('Today is Monday, 2026-11-23 (America/Guayaquil)');
    expect(prompt).toContain('previous run was on 2026-11-16');
    expect(prompt).toContain('never ask a question');
    expect(prompt).toContain('You cannot create or change pages');
    expect(prompt).toContain('becomes a new page');
    expect(prompt).toContain('every space Ana can see');

    const first = agentPrompt({ ...base, lastRunAt: null, spaceName: 'Product', canWrite: true, output: 'append', targetTitle: 'Log' });
    expect(first).toContain('first run');
    expect(first).toContain('only inside the space "Product"');
    expect(first).toContain('suggest_page_edit');
    expect(first).toContain('added under today\'s date to the page "Log"');

    const direct = agentPrompt({ ...base, canWrite: true, suggestEdits: false, output: 'notify' });
    expect(direct).toContain('change only what the task names');
    expect(direct).toContain('sent to Ana as a notification');
  });

  it('keeps what a run did with its tools', () => {
    const into = { suggestions: [], created: [], steps: [] } as any;
    collect(
      [
        {
          toolCalls: [
            { toolCallId: '1', toolName: 'list_changed_pages', input: {} },
            { toolCallId: '2', toolName: 'get_page', input: { pageId: 'abc' } },
          ],
          toolResults: [
            { toolCallId: '1', output: { pages: [] } },
            { toolCallId: '2', output: { error: 'Not found' } },
          ],
        },
        {
          toolCalls: [
            { toolCallId: '3', toolName: 'suggest_page_edit', input: { pageId: 'p1' } },
            { toolCallId: '4', toolName: 'create_page', input: { title: 'Notes' } },
          ],
          toolResults: [
            { toolCallId: '3', output: { proposed: true, suggestionId: 's1', title: 'Roadmap', reviewUrl: '/s/g/p/x?suggestion=s1' } },
            { toolCallId: '4', output: { created: true, id: 'p9', title: 'Notes', url: '/s/g/p/y' } },
          ],
        },
      ],
      into,
    );
    expect(into.steps).toEqual([
      { name: 'list_changed_pages', detail: '' },
      { name: 'get_page', detail: 'abc (Not found)' },
      { name: 'suggest_page_edit', detail: 'p1' },
      { name: 'create_page', detail: 'Notes' },
    ]);
    expect(into.suggestions).toEqual([{ suggestionId: 's1', title: 'Roadmap', reviewUrl: '/s/g/p/x?suggestion=s1' }]);
    expect(into.created).toEqual([{ id: 'p9', title: 'Notes', url: '/s/g/p/y' }]);
  });

  it('adds a piece to a page at one end', () => {
    const page = { type: 'doc', content: [p('one'), p('two')] };
    const piece = { type: 'doc', content: [p('new')] };
    expect((withFragment(page, piece, 'append') as any).content.map((n: any) => n.content[0].text)).toEqual(['one', 'two', 'new']);
    expect((withFragment(page, piece, 'prepend') as any).content.map((n: any) => n.content[0].text)).toEqual(['new', 'one', 'two']);
    expect(withFragment(page, piece, 'replace')).toBe(piece);
    // an empty page is one empty paragraph: the piece takes its place
    expect((withFragment({ type: 'doc', content: [{ type: 'paragraph' }] }, piece, 'append') as any).content).toHaveLength(1);
    expect((withFragment(null, piece, 'append') as any).content).toHaveLength(1);
  });
});
