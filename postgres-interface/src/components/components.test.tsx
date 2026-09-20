import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { CreateConnectionDialog } from "./CreateConnectionDialog";

it("requires explicit approval and returns the selected access", async () => {
  const onDecision = vi.fn();
  render(<CreateConnectionDialog context={{ callingManagerId: "consumer-1", requestedAccess: { scope: "database", operation: "create", database: "orders" }, callerLabels: {}, databaseNames: ["orders"] }} onDecision={onDecision} />);
  expect(screen.getByRole("dialog", { name: /approve postgresql connection/i })).toBeVisible();
  await userEvent.setup().click(screen.getByRole("button", { name: /^approve$/i }));
  expect(onDecision).toHaveBeenCalledWith({ allowed: true, access: { scope: "database", operation: "create", database: "orders" } });
});
