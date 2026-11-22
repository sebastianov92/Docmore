import { htmlToJson, jsonToNode } from '../../../collaboration/collaboration.util';

describe('server document schema', () => {
  it('keeps the blocks of this fork when a page goes through the server', () => {
    const json: any = htmlToJson(
      '<div data-type="base-button" data-label="Tasks" data-page-id="p1" data-automation-id="a1"></div>' +
        '<div data-type="bookmark" data-url="https://example.com" data-title="Example"></div>' +
        '<div data-type="base-embed" data-page-id="p1" data-view-id="v1"></div>',
    );
    const kinds = json.content.map((n: any) => [n.type, n.attrs]);
    expect(kinds[0]).toEqual(['baseButton', expect.objectContaining({ label: 'Tasks', pageId: 'p1', automationId: 'a1' })]);
    expect(kinds[1]).toEqual(['bookmark', expect.objectContaining({ url: 'https://example.com', title: 'Example' })]);
    expect(kinds[2]).toEqual(['base', expect.objectContaining({ pageId: 'p1', viewId: 'v1' })]);
    expect(() => jsonToNode(json)).not.toThrow();
  });
});
