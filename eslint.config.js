import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const appSources = ["src/**/*.{ts,tsx}"];
const testSources = ["**/*.{test,spec}.{ts,tsx}", "src/test/**/*.{ts,tsx}"];
const ipcAdapter = "src/lib/api.ts";
const ipcMessage = "Call a typed api method from src/lib/api.ts for Tauri commands.";
const coreImport = {
  name: "@tauri-apps/api/core",
  allowImportNames: ["Channel"],
  message: ipcMessage,
};
const tauriImports = [
  {
    name: "@tauri-apps/api/event",
    allowImportNames: ["listen"],
    message: "Use listen for native events. " + ipcMessage,
  },
  {
    name: "@tauri-apps/api/window",
    allowImportNames: ["getCurrentWindow"],
    message: "Use getCurrentWindow for native window controls. " + ipcMessage,
  },
  {
    name: "@tauri-apps/plugin-dialog",
    allowImportNames: ["open"],
    message: "Use open for the native file picker. Review capabilities before adding dialog APIs.",
  },
];
const otherRestrictedImports = [
  {
    regex: "^@tauri-apps/(?!(?:api/(?:core|event|window)|plugin-dialog)$)",
    message: "Use the approved named Tauri imports. " + ipcMessage,
  },
  {
    regex: "^lucide-react$",
    importNamePattern: "^(?:Clipboard|Copy).",
    message: "Use Copy for copy actions and Clipboard for paste.",
  },
];
const noDynamicTauriImport = {
  selector: String.raw`ImportExpression:matches([source.value=/^@tauri-apps\x2f/], [source.quasis.0.value.cooked=/^@tauri-apps\x2f/])`,
  message: "Use approved named imports for Tauri APIs. " + ipcMessage,
};

export default tseslint.config(
  { ignores: ["dist", "node_modules", "src-tauri/target", "docs", ".claude"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2024,
      globals: globals.browser,
    },
  },
  {
    files: testSources,
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    files: appSources,
    ignores: testSources,
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [coreImport, ...tauriImports], patterns: otherRestrictedImports },
      ],
      "no-restricted-globals": [
        "error",
        {
          checkGlobalObject: true,
          globals: [
            { name: "confirm", message: "Use the in-app ConfirmDialog for confirmation." },
            { name: "__TAURI__", message: ipcMessage },
            { name: "__TAURI_INTERNALS__", message: ipcMessage },
          ],
        },
      ],
      "no-restricted-syntax": ["error", noDynamicTauriImport],
    },
  },
  {
    files: [ipcAdapter],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ ...coreImport, allowImportNames: ["Channel", "invoke"] }, ...tauriImports],
          patterns: otherRestrictedImports,
        },
      ],
    },
  },
  {
    files: [
      "src/components/ReleaseNotes.tsx",
      "src/components/UpdateIndicator.tsx",
      "src/components/WhatsNewDialog.tsx",
      "src/lib/release-notes.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        noDynamicTauriImport,
        {
          selector:
            "JSXAttribute[name.name='dangerouslySetInnerHTML'], Property:matches([key.name='dangerouslySetInnerHTML'], [key.value='dangerouslySetInnerHTML'])",
          message: "Render release notes as text. Use the ReleaseNotes component in updater UI.",
        },
      ],
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      globals: globals.node,
    },
  },
);
