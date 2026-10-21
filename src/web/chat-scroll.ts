export type ChatScrollController = {
  alignLatest(): void;
  jumpToLatest(): void;
  onScroll(element: HTMLElement): void;
  interrupt(): void;
  cancel(): void;
};

type Options = {
  getContainer: () => HTMLElement | null;
  getGeneration: () => number;
  getPinned: () => boolean;
  setPinned: (pinned: boolean) => void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
};

type SavedStyle = {
  element: HTMLElement;
  overflow: string;
  overflowPriority: string;
  behavior: string;
  behaviorPriority: string;
};

export function createChatScrollController(
  options: Options,
): ChatScrollController {
  let serial = 0;
  let frame: number | undefined;
  let explicit: { element: HTMLElement; generation: number } | undefined;
  let active = false;
  let savedStyle: SavedStyle | undefined;

  const request = (callback: FrameRequestCallback) =>
    (options.requestFrame ?? ((cb) => window.requestAnimationFrame(cb)))(
      callback,
    );
  const cancelScheduled = () => {
    const pending = frame;
    frame = undefined;
    if (pending === undefined) return;
    try {
      (options.cancelFrame ?? ((id) => window.cancelAnimationFrame(id)))(
        pending,
      );
    } catch {
      // Invalidating the serial still makes an uncancelled callback harmless.
    }
  };
  const restore = () => {
    const saved = savedStyle;
    savedStyle = undefined;
    active = false;
    if (!saved) return;
    try {
      if (saved.overflow)
        saved.element.style.setProperty(
          "overflow-y",
          saved.overflow,
          saved.overflowPriority,
        );
      else saved.element.style.removeProperty("overflow-y");
    } catch {
      // Continue restoring the other temporary property.
    }
    try {
      if (saved.behavior)
        saved.element.style.setProperty(
          "scroll-behavior",
          saved.behavior,
          saved.behaviorPriority,
        );
      else saved.element.style.removeProperty("scroll-behavior");
    } catch {
      // Cleanup must not prevent releasing the controller state.
    }
  };
  const stop = (releaseIntent: boolean) => {
    serial++;
    cancelScheduled();
    try {
      restore();
    } finally {
      if (releaseIntent) explicit = undefined;
    }
  };
  const current = (id: number, element: HTMLElement, generation: number) =>
    id === serial &&
    options.getContainer() === element &&
    options.getGeneration() === generation;
  const align = (element: HTMLElement) => {
    element.scrollTop = element.scrollHeight;
  };
  const positionPinned = (element: HTMLElement) =>
    element.scrollHeight - element.scrollTop - element.clientHeight <= 48;
  const updatePinnedIfCurrent = (element: HTMLElement, generation: number) => {
    try {
      if (
        options.getContainer() === element &&
        options.getGeneration() === generation
      )
        options.setPinned(positionPinned(element));
    } catch {
      // The element may have failed during cleanup.
    }
  };
  const fail = (id: number, element: HTMLElement, generation: number) => {
    if (id !== serial) return;
    stop(true);
    updatePinnedIfCurrent(element, generation);
  };
  const schedule = (
    id: number,
    element: HTMLElement,
    generation: number,
    callback: () => void,
  ) => {
    try {
      const scheduled = request(() => {
        if (id !== serial) return;
        frame = undefined;
        if (!current(id, element, generation)) {
          stop(true);
          return;
        }
        callback();
      });
      if (id === serial) frame = scheduled;
      else {
        try {
          (
            options.cancelFrame ??
            ((frameId) => window.cancelAnimationFrame(frameId))
          )(scheduled);
        } catch {
          // The callback is stale by serial even if it cannot be cancelled.
        }
      }
    } catch {
      fail(id, element, generation);
    }
  };

  return {
    alignLatest() {
      if (active) return;
      if (explicit) {
        const intent = explicit;
        if (
          options.getContainer() !== intent.element ||
          options.getGeneration() !== intent.generation
        ) {
          stop(true);
        } else {
          try {
            align(intent.element);
            if (
              !active &&
              intent.element.scrollHeight -
                intent.element.scrollTop -
                intent.element.clientHeight >
                2
            ) {
              explicit = undefined;
              updatePinnedIfCurrent(intent.element, intent.generation);
            }
          } catch {
            const id = serial;
            fail(id, intent.element, intent.generation);
          }
          return;
        }
      }
      const element = options.getContainer();
      if (!element || !options.getPinned()) return;
      cancelScheduled();
      const id = ++serial;
      const generation = options.getGeneration();
      let count = 0;
      try {
        align(element);
        const tick = () => {
          if (!options.getPinned()) {
            stop(false);
            return;
          }
          try {
            align(element);
            if (++count < 2) schedule(id, element, generation, tick);
          } catch {
            fail(id, element, generation);
          }
        };
        schedule(id, element, generation, tick);
      } catch {
        fail(id, element, generation);
      }
    },
    jumpToLatest() {
      stop(true);
      const element = options.getContainer();
      if (!element) return;
      const generation = options.getGeneration();
      const id = ++serial;
      explicit = { element, generation };
      try {
        savedStyle = {
          element,
          overflow: element.style.getPropertyValue("overflow-y"),
          overflowPriority: element.style.getPropertyPriority("overflow-y"),
          behavior: element.style.getPropertyValue("scroll-behavior"),
          behaviorPriority:
            element.style.getPropertyPriority("scroll-behavior"),
        };
        active = true;
        element.style.setProperty("overflow-y", "hidden", "important");
        element.style.setProperty("scroll-behavior", "auto", "important");
        void element.clientHeight;
        align(element);
        schedule(id, element, generation, () => {
          try {
            if (savedStyle?.overflow)
              element.style.setProperty(
                "overflow-y",
                savedStyle.overflow,
                savedStyle.overflowPriority,
              );
            else element.style.removeProperty("overflow-y");
            void element.clientHeight;
            align(element);
            schedule(id, element, generation, () => {
              try {
                align(element);
                restore();
                if (
                  element.scrollHeight -
                    element.scrollTop -
                    element.clientHeight <=
                  2
                ) {
                  options.setPinned(true);
                } else {
                  explicit = undefined;
                  options.setPinned(false);
                }
              } catch {
                fail(id, element, generation);
              }
            });
          } catch {
            fail(id, element, generation);
          }
        });
      } catch {
        fail(id, element, generation);
      }
    },
    onScroll(element) {
      if (explicit) {
        const intent = explicit;
        if (
          options.getContainer() === intent.element &&
          options.getGeneration() === intent.generation
        ) {
          try {
            align(intent.element);
            if (
              !active &&
              intent.element.scrollHeight -
                intent.element.scrollTop -
                intent.element.clientHeight >
                2
            ) {
              explicit = undefined;
              updatePinnedIfCurrent(intent.element, intent.generation);
            }
          } catch {
            fail(serial, intent.element, intent.generation);
          }
          return;
        }
        stop(true);
      }
      try {
        options.setPinned(positionPinned(element));
      } catch {
        // A detached or failing element cannot provide a trustworthy position.
      }
    },
    interrupt() {
      stop(true);
    },
    cancel() {
      stop(true);
    },
  };
}
