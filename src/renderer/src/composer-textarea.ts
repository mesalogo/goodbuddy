// Composer textarea sizing and attachment size formatting, moved out of App.tsx.

export function formatAttachmentSize(size: number): string {
  return `${Math.max(1, Math.ceil(size / 1024))} KB`;
}

const composerTextareaMinHeight = 72;
const composerTextareaMaxHeight = 220;

const composerTextareaSizes = new WeakMap<
  HTMLTextAreaElement,
  { height: number; value: string }
>();

function clampComposerTextareaHeight(height: number): number {
  return Math.max(
    composerTextareaMinHeight,
    Math.min(height, composerTextareaMaxHeight),
  );
}

// Sizing reads scrollHeight, which forces a synchronous layout of the whole
// window. Skip the read when the result is known, and avoid the extra
// "auto" reset layout when text was only appended (it can only grow).
export function resizeComposerTextarea(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) {
    return;
  }
  const value = textarea.value;
  const previous = composerTextareaSizes.get(textarea);
  const previousHeightApplied =
    previous !== undefined &&
    textarea.style.height === `${previous.height}px`;
  let height: number;
  if (previousHeightApplied && value === previous.value) {
    height = previous.height;
  } else if (
    previousHeightApplied &&
    previous.value !== "" &&
    value.startsWith(previous.value)
  ) {
    height =
      previous.height >= composerTextareaMaxHeight
        ? composerTextareaMaxHeight
        : clampComposerTextareaHeight(textarea.scrollHeight);
  } else {
    textarea.style.height = "auto";
    height = clampComposerTextareaHeight(textarea.scrollHeight);
  }
  const nextHeight = `${height}px`;
  if (textarea.style.height !== nextHeight) {
    textarea.style.height = nextHeight;
  }
  composerTextareaSizes.set(textarea, { height, value });
}
