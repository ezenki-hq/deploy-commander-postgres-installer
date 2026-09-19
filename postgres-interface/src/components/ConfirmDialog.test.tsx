import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConfirmDialog from './ConfirmDialog';

afterEach(cleanup);

describe('ConfirmDialog', () => {
  it('labels the destructive effect and calls confirm once', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ConfirmDialog busy={false} onCancel={vi.fn()} onConfirm={onConfirm} />);

    expect(screen.getByRole('dialog', { name: 'Teardown PostgreSQL?' })).toHaveAttribute(
      'aria-modal',
      'true',
    );
    expect(screen.getByText(/shared PostgreSQL service and its logical databases/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Confirm teardown' }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('traps focus, handles Escape, and restores focus on unmount', async () => {
    const user = userEvent.setup();
    const opener = document.createElement('button');
    opener.textContent = 'Teardown PostgreSQL';
    document.body.append(opener);
    opener.focus();
    const onCancel = vi.fn();
    const view = render(<ConfirmDialog busy={false} onCancel={onCancel} onConfirm={vi.fn()} />);

    expect(screen.getByRole('dialog')).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Confirm teardown' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledOnce();
    view.unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('disables dismissal and confirmation while busy', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<ConfirmDialog busy onCancel={onCancel} onConfirm={onConfirm} />);

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Confirm teardown' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('keeps the dialog panel scrollable within a short viewport', () => {
    render(<ConfirmDialog busy={false} onCancel={vi.fn()} onConfirm={vi.fn()} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('max-h-[calc(100dvh-2rem)]', 'overflow-y-auto');
  });
});
