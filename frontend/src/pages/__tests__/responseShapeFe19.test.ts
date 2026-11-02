// FE-19 — invoice line tax %, and the SNMP flag of a device with SNMP off.
import { describe, expect, it } from 'vitest';
import { taxPercent } from '../InvoiceDetail';
import { snmpEnabledText } from '../DeviceDetail';

const t = (key: string) => ({ 'common.yes': 'Yes', 'common.no': 'No' }[key] ?? key);

describe('taxPercent', () => {
  it('renders the fractional rate as a percentage', () => {
    expect(taxPercent('0.1600')).toBe('16%');
    expect(taxPercent(0.08)).toBe('8%');
    expect(taxPercent('0.0000')).toBe('0%');
  });
  it('shows a dash when the rate is missing', () => {
    expect(taxPercent(null)).toBe('—');
    expect(taxPercent(undefined)).toBe('—');
  });
});

describe('snmpEnabledText', () => {
  it('reads the 0/1 BOOLEAN the API returns', () => {
    expect(snmpEnabledText(0, t)).toBe('No');
    expect(snmpEnabledText(1, t)).toBe('Yes');
    expect(snmpEnabledText(false, t)).toBe('No');
    expect(snmpEnabledText(null, t)).toBeNull();
  });
});
