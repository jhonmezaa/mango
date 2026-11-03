import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../i18n';
import { ApiError } from '../api/errors';
import { RateWaitButton, RateWaitLine } from './RateWait';
import { RATE_FALLBACK_S, retryAtOf } from './rateLimitWait';

const NOW = Date.parse('2026-11-02T12:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('RateWait · design round 34', () => {
  it('takes the wait of a 429 from Retry-After, or the edge fixed wait', () => {
    expect(retryAtOf(new ApiError(429, 'rate_limited', 'x', 45), NOW)).toBe(NOW + 45_000);
    expect(retryAtOf(new ApiError(429, 'http_429', 'x'), NOW)).toBe(NOW + RATE_FALLBACK_S * 1000);
    expect(retryAtOf(new ApiError(503, 'unavailable', 'x'), NOW)).toBeNull();
    expect(retryAtOf(new TypeError('network'), NOW)).toBeNull();
  });

  it('keeps «Reintentar» disabled with the countdown and enables it at zero', () => {
    const onRetry = vi.fn();
    render(
      <p>
        <RateWaitLine until={NOW + 178_000} />
        <RateWaitButton until={NOW + 178_000} onRetry={onRetry} />
      </p>,
    );
    expect(screen.getByText('Puedes volver a intentarlo en 3 minutos.')).toBeInTheDocument();
    const waiting = screen.getByRole('button', { name: 'Reintentar en 2:58' });
    expect(waiting).toBeDisabled();
    act(() => {
      vi.advanceTimersByTime(130_000);
    });
    expect(screen.getByRole('button', { name: 'Reintentar en 48 s' })).toBeDisabled();
    expect(screen.getByText('Puedes volver a intentarlo en unos segundos.')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(48_000);
    });
    expect(screen.getByText('Ya puedes volver a intentarlo.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
