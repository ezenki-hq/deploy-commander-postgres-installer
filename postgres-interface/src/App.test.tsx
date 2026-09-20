import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import App from "./App";

it("renders the scaffold root", () => {
  const view = render(<App />);
  expect(view.container).toBeEmptyDOMElement();
});
