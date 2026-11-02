// =============================================================================
// useMutation that always runs the options of the latest committed render
// =============================================================================
// TanStack Query hands new options to its observer in an effect after each
// render, and mutate() snapshots whatever options the observer holds. A click
// between a commit and that effect ran the previous render's mutationFn with
// the previous render's state: Backup settings saved the blank defaults when
// Save was clicked as the saved settings appeared (#52). Every page imports
// useMutation from here instead (src/api/__tests__/useMutation.test.tsx).
// =============================================================================

import { useLayoutEffect, useRef } from 'react';
import {
  useMutation as useTanstackMutation,
  type DefaultError,
  type QueryClient,
  type UseMutationOptions,
  type UseMutationResult,
} from '@tanstack/react-query';

export function useMutation<TData = unknown, TError = DefaultError, TVariables = void, TOnMutateResult = unknown>(
  options: UseMutationOptions<TData, TError, TVariables, TOnMutateResult>,
  queryClient?: QueryClient,
): UseMutationResult<TData, TError, TVariables, TOnMutateResult> {
  const latest = useRef(options);
  // A layout effect runs inside the commit, before any later event handler.
  useLayoutEffect(() => {
    latest.current = options;
  });

  return useTanstackMutation<TData, TError, TVariables, TOnMutateResult>({
    ...options,
    mutationFn: options.mutationFn && ((...args) => latest.current.mutationFn!(...args)),
    onMutate: options.onMutate && ((...args) => latest.current.onMutate?.(...args) as TOnMutateResult),
    onSuccess: options.onSuccess && ((...args) => latest.current.onSuccess?.(...args)),
    onError: options.onError && ((...args) => latest.current.onError?.(...args)),
    onSettled: options.onSettled && ((...args) => latest.current.onSettled?.(...args)),
  }, queryClient);
}
