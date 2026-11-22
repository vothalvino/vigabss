// "Voice notes: ready / not ready, and why" on the WhatsApp and Providers screens.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const mockApiFetch = vi.fn();
vi.mock('@/api/apiFetch', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));

import { VoiceNotesStatus } from '../aiSettings/VoiceNotesStatus';

beforeEach(() => vi.clearAllMocks());

describe('VoiceNotesStatus', () => {
  it('says voice notes are ready, by which provider and model', async () => {
    mockApiFetch.mockResolvedValue({ data: { ready: true, reason: null, provider: { id: 2, name: 'OpenRouter', kind: 'openrouter' }, model: 'google/gemini-2.5-flash' } });
    render(<VoiceNotesStatus />);
    expect(await screen.findByTestId('voice-notes-status'))
      .toHaveTextContent('Voice notes: ready. Transcribed by OpenRouter with google/gemini-2.5-flash.');
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/ai/voice-notes/status');
  });

  it.each([
    ['channel_off', /Enable the WhatsApp channel under General/],
    ['assistant_off', /Turn the AI assistant on/],
    ['no_provider', /Add an enabled OpenAI or OpenRouter provider/],
    ['over_budget', /budget is used up/],
    ['not_connected', /not connected through Meta/],
  ])('says what stops them: %s', async (reason, text) => {
    mockApiFetch.mockResolvedValue({ data: { ready: false, reason, provider: null, model: null } });
    render(<VoiceNotesStatus />);
    expect(await screen.findByTestId('voice-notes-status')).toHaveTextContent(text);
  });

  it('shows nothing when the server cannot say', async () => {
    mockApiFetch.mockRejectedValue(new Error('403'));
    const { container } = render(<VoiceNotesStatus />);
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('asks again when its refresh key changes', async () => {
    mockApiFetch.mockResolvedValue({ data: { ready: false, reason: 'no_provider', provider: null, model: null } });
    const { rerender } = render(<VoiceNotesStatus refreshKey="a" />);
    await screen.findByTestId('voice-notes-status');
    rerender(<VoiceNotesStatus refreshKey="b" />);
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));
  });
});
