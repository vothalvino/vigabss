// The panels the contract page shows under its header: the technology
// transition and the connection check. Kept together so the contract page
// mounts them with one line.
import { can } from '@/auth/permissions';
import { useAuth } from '@/auth/AuthContext';
import { ContractTransition } from './ContractTransition';
import { ContractNetworkPath } from './ContractNetworkPath';

type TransitionProps = Parameters<typeof ContractTransition>[0];

export function ContractPanels(props: TransitionProps) {
  const { user } = useAuth();
  return (
    <>
      <ContractTransition {...props} />
      {can(user, 'contracts.view') && <ContractNetworkPath contractId={props.contractId} canKeep={can(user, 'contracts.update')} />}
    </>
  );
}
