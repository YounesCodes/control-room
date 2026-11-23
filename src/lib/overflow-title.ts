import type { MouseEvent } from "react";

export function showOverflowTitle({ currentTarget }: MouseEvent<HTMLElement>) {
  if (currentTarget.scrollWidth > currentTarget.clientWidth) {
    currentTarget.title = currentTarget.textContent ?? "";
  } else {
    currentTarget.removeAttribute("title");
  }
}
