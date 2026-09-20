import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ActionButton } from './ActionButton';
import { ManagerShell } from './ManagerShell';
import { ModalDialog } from './ModalDialog';

describe('visual primitives', () => {
  it('renders the Deploy Commander shell and semantic status badge', () => {
    render(<ManagerShell badge={{ label: 'Installed', tone: 'success' }}>content</ManagerShell>);
    expect(screen.getByRole('heading', { name: /postgresql manager/i })).toBeVisible();
    expect(screen.getByText('Installed')).toHaveClass('bg-emerald-50');
  });

  it('traps focus, rejects on Escape, and restores prior focus', async () => {
    const user = userEvent.setup();
    const reject = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          {open && (
            <ModalDialog
              title="Confirm teardown"
              onCancel={() => {
                reject();
                setOpen(false);
              }}
              actions={
                <>
                  <button>Cancel</button>
                  <button>Confirm</button>
                </>
              }
            >
              <p>Remove PostgreSQL</p>
            </ModalDialog>
          )}
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    screen.getByRole('button', { name: 'Cancel' }).focus();
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(reject).toHaveBeenCalledOnce();
    expect(opener).toHaveFocus();
  });

  it('renders a busy action button without allowing interaction', () => {
    render(<ActionButton busy>Install PostgreSQL</ActionButton>);
    expect(screen.getByRole('button', { name: /install postgresql/i })).toBeDisabled();
  });
});
