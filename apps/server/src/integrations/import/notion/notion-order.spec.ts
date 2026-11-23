import { numberedOrder } from './notion-import.service';

describe('the order of the columns of an imported board', () => {
  const ids = (names: string[]) => names.map((name, index) => ({ id: `c${index}`, name }));

  it('puts options that are one name with a number in the order of the number', () => {
    expect(numberedOrder(ids(['Day 3', 'Day 2', 'Day 1', 'Day 5', 'Day 4']))).toEqual(['c2', 'c1', 'c0', 'c4', 'c3']);
    // by the number, not by the letters: 10 after 9
    expect(numberedOrder(ids(['Week 10', 'Week 9', 'week 1']))).toEqual(['c2', 'c1', 'c0']);
    expect(numberedOrder(ids(['Q2', 'Q1']))).toEqual(['c1', 'c0']);
    expect(numberedOrder(ids(['2 stars', '1 stars']))).toEqual(['c1', 'c0']);
  });

  it('leaves alone options that are not such a series', () => {
    expect(numberedOrder(ids(['To do', 'Doing', 'Done']))).toBeNull();
    expect(numberedOrder(ids(['Day 1', 'Night 2']))).toBeNull();
    expect(numberedOrder(ids(['Day 1', 'Later']))).toBeNull();
    expect(numberedOrder(ids(['Day 1']))).toBeNull();
    expect(numberedOrder([])).toBeNull();
  });
});
