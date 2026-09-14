import { act, cleanup, render } from "@testing-library/react";
import { FpsCounter } from "@/components/FpsCounter";
import { i18n } from "@/i18n";

describe("FpsCounter", () => {
  let callbacks: Map<number, FrameRequestCallback>;
  let nextFrame: number;

  function advanceFrame(time: number): void {
    act(() => {
      const pending = [...callbacks.values()];
      callbacks.clear();
      pending.forEach((callback) => callback(time));
    });
  }

  function setHidden(hidden: boolean): void {
    vi.spyOn(document, "hidden", "get").mockReturnValue(hidden);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    callbacks = new Map();
    nextFrame = 0;
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      callbacks.set(++nextFrame, callback);
      return nextFrame;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((frame: number) => callbacks.delete(frame)));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("averages frame intervals once per second and reflects a slower frame rate", () => {
    const { getByText } = render(<FpsCounter />);
    const value = getByText("--");
    expect(getByText("FPS")).toBeInTheDocument();
    advanceFrame(0);
    for (let frame = 1; frame < 60; frame += 1) advanceFrame(frame * 1000 / 60);
    expect(value).toHaveTextContent("--");
    advanceFrame(1000);
    expect(value).toHaveTextContent(/^60$/);
    for (let frame = 1; frame <= 30; frame += 1) advanceFrame(1000 + frame * 1000 / 30);
    expect(value).toHaveTextContent(/^30$/);
  });

  it("measures elapsed time when a frame stalls beyond the sample window", () => {
    const { getByText } = render(<FpsCounter />);
    const value = getByText("--");
    advanceFrame(0);
    for (let frame = 1; frame <= 30; frame += 1) advanceFrame(frame * 1000 / 60);
    advanceFrame(1500);
    expect(value).toHaveTextContent(/^21$/);
  });

  it("clears stale readings when hidden and excludes the hidden time after resuming", () => {
    const { getByText } = render(<FpsCounter />);
    const value = getByText("--");
    advanceFrame(0);
    for (let frame = 1; frame <= 60; frame += 1) advanceFrame(frame * 1000 / 60);
    expect(value).toHaveTextContent(/^60$/);
    setHidden(true);
    expect(value).toHaveTextContent("--");
    expect(callbacks.size).toBe(0);
    setHidden(false);
    advanceFrame(100000);
    for (let frame = 1; frame <= 30; frame += 1) advanceFrame(100000 + frame * 1000 / 30);
    expect(value).toHaveTextContent(/^30$/);
  });

  it("does not sample an initially hidden window and stops after unmounting", () => {
    setHidden(true);
    const { unmount } = render(<FpsCounter />);
    expect(callbacks.size).toBe(0);
    setHidden(false);
    expect(callbacks.size).toBe(1);
    unmount();
    expect(callbacks.size).toBe(0);
    setHidden(false);
    expect(callbacks.size).toBe(0);
  });
});
