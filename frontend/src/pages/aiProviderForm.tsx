// =============================================================================
// VigaBSS 5.0 — AI provider form: request body and the voice-note model field
// =============================================================================
// Split out of AIAssistantSettings.tsx (page-size limit).
// =============================================================================

import type React from 'react';
import { useTranslation } from 'react-i18next';

export interface ProviderForm {
  name: string;
  kind: string;
  model: string;
  endpoint: string;
  deployment: string;
  /** Model that transcribes WhatsApp voice notes; '' = the default for the kind. */
  voiceModel: string;
  api_key: string;
  priority: number;
  is_enabled: boolean;
}

export interface ProviderExtraConfig {
  deployment?: string | null;
  transcription_model?: string | null;
}

/** Provider kinds that can transcribe a voice note, with the model used when none is chosen. */
export const VOICE_MODEL_DEFAULTS: Record<string, string> = {
  openai: 'gpt-transcribe',
  openrouter: 'google/gemini-2.5-flash',
};

/**
 * The body for POST/PUT /ai/providers. `extra_config` is sent whole, with
 * whatever else the stored one holds, so clearing the voice-note model (or
 * the deployment) really removes it.
 */
export function providerPayload(form: ProviderForm, existing?: ProviderExtraConfig | null): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: form.name, kind: form.kind,
    priority: Number(form.priority),
    enabled: form.is_enabled,
  };
  if (form.model) body.model = form.model;
  if (form.endpoint) body.endpoint_url = form.endpoint;
  if (form.api_key) body.api_key = form.api_key;

  const extra: Record<string, unknown> = { ...(existing ?? {}) };
  delete extra.deployment;
  delete extra.transcription_model;
  if (form.deployment) extra.deployment = form.deployment;
  const voiceModel = form.voiceModel.trim();
  if (voiceModel && form.kind in VOICE_MODEL_DEFAULTS) extra.transcription_model = voiceModel;
  if (Object.keys(extra).length > 0 || existing) body.extra_config = extra;
  return body;
}

interface VoiceModelFieldProps {
  kind: string;
  value: string;
  onChange: (value: string) => void;
  labelStyle: React.CSSProperties;
  inputStyle: React.CSSProperties;
  hintStyle: React.CSSProperties;
}

/** Shown for the kinds that can transcribe; nothing for the others. */
export function VoiceModelField({ kind, value, onChange, labelStyle, inputStyle, hintStyle }: VoiceModelFieldProps) {
  const { t } = useTranslation();
  const fallback = VOICE_MODEL_DEFAULTS[kind];
  if (!fallback) return null;
  return (
    <label style={labelStyle}>{t('aiAssistantSettings.providers.form.voiceModel')}
      <input style={inputStyle} value={value} maxLength={100} placeholder={fallback}
        onChange={e => onChange(e.target.value)} />
      <span style={hintStyle}>{t('aiAssistantSettings.providers.form.voiceModelHint', { model: fallback })}</span>
    </label>
  );
}
