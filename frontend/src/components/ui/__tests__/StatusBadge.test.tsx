// FE-23: one status pill instead of fifty local copies.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from '../StatusBadge';

const COLORS = { paid: { bg: '#d1fae5', color: '#065f46' } };

describe('StatusBadge', () => {
  it('colours a known status from the page\'s map', () => {
    render(<StatusBadge status="paid" colors={COLORS} />);
    const pill = screen.getByText('paid');
    expect(pill.style.background).toBe('rgb(209, 250, 229)');
    expect(pill.style.padding).toBe('2px 8px');
  });

  it('greys a status missing from the map', () => {
    render(<StatusBadge status="weird" colors={COLORS} />);
    expect(screen.getByText('weird').style.color).toBe('rgb(55, 65, 81)');
  });

  it('md is the larger header pill', () => {
    render(<StatusBadge status="paid" colors={COLORS} size="md" />);
    expect(screen.getByText('paid').style.fontSize).toBe('0.78rem');
  });
});
