// Keep the table grid full width while its wrapper handles narrow screens.
export function wrapTables() {
  return {
    name: "docs-table-wrapper",
    element: {
      filter: ["table"],
      visit(node) {
        return {
          type: "element",
          tagName: "div",
          properties: { class: "docs-table" },
          children: [node],
        };
      },
    },
  };
}
