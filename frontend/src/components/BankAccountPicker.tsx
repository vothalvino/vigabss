// The bank account a payment by transfer, card or check reached. Shown only
// when the organization has bank accounts; the money tie-out uses the answer
// to show what each account received.
import { useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';

export function BankAccountPicker({ value, onChange, disabled, labelStyle, inputStyle }: {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  labelStyle?: React.CSSProperties;
  inputStyle?: React.CSSProperties;
}) {
  const { t } = useTranslation();
  const id = useId();
  const { data } = useQuery({
    queryKey: ['payment-bank-accounts'],
    queryFn: async () => {
      const { data: body, error } = await api.GET('/payments/bank-accounts');
      if (error) throw new Error('bank accounts');
      return body?.data ?? [];
    },
    staleTime: 60_000,
    retry: false,
  });
  const accounts = data ?? [];
  if (accounts.length === 0) return null;
  return (
    <>
      <label htmlFor={id} style={labelStyle}>{t('recordPayment.bankAccount')}</label>
      <select id={id} style={inputStyle} value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
        <option value="">{t('recordPayment.bankAccountNone')}</option>
        {accounts.map(a => (
          <option key={a.id} value={a.id}>
            {[a.name, a.account_hint].filter(Boolean).join(' · ')}
          </option>
        ))}
      </select>
    </>
  );
}
