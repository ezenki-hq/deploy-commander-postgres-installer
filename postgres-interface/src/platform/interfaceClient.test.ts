import { describe, expect, it } from "vitest";
import { createInterfaceClient } from "./interfaceClient";

describe("createInterfaceClient", () => {
  it("creates one caller/event source and disposes the wire idempotently", () => {
    const client = createInterfaceClient();
    expect(client.caller).toBeDefined();
    expect(client.events.subscribe(() => undefined)).toBeTypeOf("function");
    expect(() => { client.dispose(); client.dispose(); }).not.toThrow();
  });
});
