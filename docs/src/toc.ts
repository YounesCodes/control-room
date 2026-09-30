class DocsTOC extends HTMLElement {
  private links: HTMLAnchorElement[] = [];
  private chosenLink?: HTMLAnchorElement;
  private manualScroll = false;
  private listeners?: AbortController;

  private set current(selected: HTMLAnchorElement) {
    for (const link of this.links) {
      if (link === selected) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
    const display = this.querySelector(".display-current");
    if (display) display.textContent = selected.textContent;
  }

  connectedCallback() {
    this.links = [...this.querySelectorAll("a")];
    if (!this.links.length) return;
    this.listeners = new AbortController();
    const { signal } = this.listeners;
    const selectHash = () => {
      const link = this.links.find((a) => a.hash === (location.hash || "#_top"));
      this.chosenLink = link;
      this.manualScroll = false;
      this.updateCurrent();
    };
    const scrollIntent = () => {
      this.manualScroll = true;
    };

    this.addEventListener(
      "click",
      (event) => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
          return;
        const link = (event.target as Element).closest("a");
        if (!link) return;
        this.chosenLink = link;
        this.manualScroll = false;
        this.current = link;
        const details = this.querySelector("details");
        if (details) details.open = false;
      },
      { signal },
    );

    window.addEventListener("hashchange", selectHash, { signal });
    window.addEventListener("wheel", scrollIntent, { passive: true, signal });
    window.addEventListener("touchmove", scrollIntent, { passive: true, signal });
    window.addEventListener("pointerdown", scrollIntent, { signal });
    window.addEventListener(
      "keydown",
      (event) => {
        if (
          ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
        ) {
          scrollIntent();
        }
        const details = this.querySelector("details");
        if (event.key === "Escape" && details?.open) {
          if (details.contains(document.activeElement)) details.querySelector("summary")?.focus();
          details.open = false;
        }
      },
      { signal },
    );
    window.addEventListener(
      "click",
      (event) => {
        const details = this.querySelector("details");
        if (details && !this.contains(event.target as Node)) details.open = false;
      },
      { signal },
    );
    window.addEventListener(
      "scroll",
      () => {
        if (this.manualScroll) this.chosenLink = undefined;
        this.updateCurrent();
      },
      { passive: true, signal },
    );

    window.addEventListener("resize", () => this.updateCurrent(), { signal });
    // Keep explicit navigation selected even when its heading cannot scroll to the top.
    if (location.hash) selectHash();
    else this.updateCurrent();
  }

  private updateCurrent() {
    const top =
      (document.querySelector("header")?.getBoundingClientRect().height || 0) +
      (this.querySelector("summary")?.getBoundingClientRect().height || 0) +
      32;
    const link =
      this.chosenLink ||
      [...this.links].reverse().find((a) => {
        const heading = document.getElementById(decodeURIComponent(a.hash.slice(1)));
        return heading && heading.getBoundingClientRect().top <= top;
      }) ||
      this.links[0];
    if (link) this.current = link;
  }

  disconnectedCallback() {
    this.listeners?.abort();
  }
}

customElements.define("docs-toc", DocsTOC);
customElements.define("docs-mobile-toc", class extends DocsTOC {});
