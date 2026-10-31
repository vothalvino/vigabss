// Test helper: choose a client in a ClientPicker (search box + option list).
import { screen, fireEvent } from '@testing-library/react';

export async function pickClient(name: string, label: string = 'Client'): Promise<void> {
  const input = screen.getByRole('textbox', { name: label });
  // Focus loads the newest clients with no typing (no debounce).
  fireEvent.focus(input);
  fireEvent.click(await screen.findByRole('option', { name: new RegExp(name) }));
}
