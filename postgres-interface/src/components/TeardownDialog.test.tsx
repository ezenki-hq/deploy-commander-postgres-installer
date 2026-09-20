import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TeardownDialog } from './TeardownDialog';

describe('TeardownDialog', () => {
  it('uses an in-app destructive confirmation', async () => {
    const decide = vi.fn();
    render(<TeardownDialog busy={false} onDecision={decide} />);
    expect(screen.getByRole('dialog', { name: /teardown postgresql/i })).toBeVisible();
    expect(screen.getByText(/service and every database/i)).toBeVisible();
    await userEvent.setup().click(screen.getByRole('button', { name: /cancel/i }));
    expect(decide).toHaveBeenCalledWith(false);
  });

  it('requires an explicit destructive confirmation', async () => {
    const decide = vi.fn();
    render(<TeardownDialog busy={false} onDecision={decide} />);
    await userEvent.setup().click(screen.getByRole('button', { name: /confirm teardown/i }));
    expect(decide).toHaveBeenCalledWith(true);
  });
});
