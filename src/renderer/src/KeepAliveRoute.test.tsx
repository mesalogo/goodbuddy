import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeepAliveRoute } from "./KeepAliveRoute";

afterEach(cleanup);

function Child({ label, onRender }: { label: string; onRender: () => void }): React.JSX.Element {
  onRender();
  return <span>{label}</span>;
}

describe("KeepAliveRoute render boundary", () => {
  it("does not re-render a hidden route when the parent re-renders with new children", () => {
    const renders = vi.fn();
    const view = (label: string, active: boolean) => (
      <KeepAliveRoute active={active} route="knowledge">
        <Child label={label} onRender={renders} />
      </KeepAliveRoute>
    );
    const { container, rerender } = render(view("first", false));
    expect(renders).toHaveBeenCalledTimes(1);
    // A chat delta re-renders App, which creates new children for every route.
    rerender(view("second", false));
    rerender(view("third", false));
    expect(renders).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-route='knowledge']")?.hasAttribute("hidden")).toBe(true);
    expect(screen.getByText("first", { selector: "span" })).toBeTruthy();
  });

  it("catches up with the latest children when shown again", () => {
    const renders = vi.fn();
    const view = (label: string, active: boolean) => (
      <KeepAliveRoute active={active} route="knowledge">
        <Child label={label} onRender={renders} />
      </KeepAliveRoute>
    );
    const { container, rerender } = render(view("first", false));
    rerender(view("second", false));
    rerender(view("latest", true));
    expect(renders).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("latest");
    expect(container.querySelector("[data-route='knowledge']")?.hasAttribute("hidden")).toBe(false);
  });

  it("re-renders the visible route and renders once more when it is hidden", () => {
    const renders = vi.fn();
    const view = (label: string, active: boolean) => (
      <KeepAliveRoute active={active} route="chat">
        <Child label={label} onRender={renders} />
      </KeepAliveRoute>
    );
    const { rerender } = render(view("a", true));
    rerender(view("b", true));
    expect(renders).toHaveBeenCalledTimes(2);
    // Hiding renders once so children see that they are inactive.
    rerender(view("c", false));
    expect(renders).toHaveBeenCalledTimes(3);
    rerender(view("d", false));
    expect(renders).toHaveBeenCalledTimes(3);
  });
});
