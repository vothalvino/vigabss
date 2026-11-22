// The provider form's request body, and the field that chooses the model
// used to transcribe WhatsApp voice notes.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { providerPayload, VoiceModelField, type ProviderForm } from '../aiProviderForm';

const FORM: ProviderForm = {
  name: 'OpenRouter', kind: 'openrouter', model: 'anthropic/claude-haiku', endpoint: '', deployment: '',
  voiceModel: '', api_key: '', priority: 10, is_enabled: true,
};

describe('providerPayload', () => {
  it('sends the chosen voice-note model inside extra_config', () => {
    expect(providerPayload({ ...FORM, voiceModel: ' google/gemini-2.5-pro ' }).extra_config)
      .toEqual({ transcription_model: 'google/gemini-2.5-pro' });
  });

  it('sends no extra_config for a new provider with nothing to put in it', () => {
    expect(providerPayload(FORM)).not.toHaveProperty('extra_config');
  });

  it('clearing the model on an edit removes it and keeps what else was stored', () => {
    const body = providerPayload(FORM, { transcription_model: 'old/model', deployment: null, region: 'x' } as never);
    expect(body.extra_config).toEqual({ region: 'x' });
  });

  it('keeps the Azure deployment, and ignores a voice model on a kind that cannot transcribe', () => {
    const body = providerPayload({ ...FORM, kind: 'azure_openai', deployment: 'gpt4', voiceModel: 'x' });
    expect(body.extra_config).toEqual({ deployment: 'gpt4' });
  });

  it('leaves the API key out when it was not typed', () => {
    expect(providerPayload(FORM)).not.toHaveProperty('api_key');
    expect(providerPayload({ ...FORM, api_key: 'example-key' }).api_key).toBe('example-key');
  });
});

describe('VoiceModelField', () => {
  const styles = { labelStyle: {}, inputStyle: {}, hintStyle: {} };

  it('shows for OpenRouter with its default as the placeholder', async () => {
    const onChange = vi.fn();
    render(<VoiceModelField kind="openrouter" value="" onChange={onChange} {...styles} />);
    const input = screen.getByLabelText(/Voice note model/);
    expect(input).toHaveAttribute('placeholder', 'google/gemini-2.5-flash');
    expect(screen.getByText(/Leave empty to use google\/gemini-2\.5-flash/)).toBeInTheDocument();
    await userEvent.type(input, 'a');
    expect(onChange).toHaveBeenCalledWith('a');
  });

  it('shows for OpenAI with its own default', () => {
    render(<VoiceModelField kind="openai" value="" onChange={() => {}} {...styles} />);
    expect(screen.getByLabelText(/Voice note model/)).toHaveAttribute('placeholder', 'gpt-transcribe');
  });

  it('is absent for a provider that cannot transcribe', () => {
    const { container } = render(<VoiceModelField kind="anthropic" value="" onChange={() => {}} {...styles} />);
    expect(container).toBeEmptyDOMElement();
  });
});
