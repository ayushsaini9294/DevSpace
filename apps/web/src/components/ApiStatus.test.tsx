import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiStatus } from './ApiStatus';

describe('ApiStatus', () => {
  it.each([
    ['checking', 'API: checking…'],
    ['ok', 'API: ok'],
    ['error', 'API: error'],
  ] as const)('shows the %s state', (state, text) => {
    render(<ApiStatus state={state} />);
    expect(screen.getByTestId('api-status').textContent).toBe(text);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
