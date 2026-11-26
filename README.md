# Agentic Workbench

Agentic Workbench is a standalone desktop editor built from Microsoft's [Code - OSS](https://github.com/microsoft/vscode) source. The app has its own macOS bundle identifier, icon, CLI, and settings profile. Agent and workflow tools come with the desktop build.

## Run the macOS app

On Apple Silicon, open **Agentic Workbench.app** under `release/VSCode-darwin-arm64/`. To open a folder from your current terminal:

```sh
open -a "$PWD/release/VSCode-darwin-arm64/Agentic Workbench.app" .
```

The app also ships a CLI at `Agentic Workbench.app/Contents/Resources/app/bin/agentic-workbench`.

1. Open a project and trust the workspace.
2. Select **Open Agentic Workbench** on the Welcome screen or select its icon in the Activity Bar.
3. Run **Agentic: Connect AI Provider** and choose a connection.
4. Run **Agentic: Run Code Factory**, select a planning mode, and enter a coding task. Start with **Unstructure**. **OpenSpec** and **SpecKit** use their respective CLIs.

Code Factory plans the change, edits workspace files, sends the result to the LLM Judge, and replans when the judge requests a revision. After approval, it opens a human testing guide. See [provider and workflow setup](extensions/agentic-workbench/README.md).

## Build the desktop product

Use macOS with the Xcode command-line tools, the Node.js version in [`.nvmrc`](.nvmrc), and npm 10. The first dependency install and package build download the Electron runtime and built-in components.

```sh
nvm use
npm ci
./scripts/package-agentic-macos.sh
```

The packaging script places the app in `release/VSCode-darwin-<architecture>/` and ad hoc signs it for local use. Distributing the app to other Macs through Gatekeeper requires Developer ID signing and notarization.

The editor source is under `src/vs/`. The agent and workflow component is under `extensions/agentic-workbench/` and builds with the editor. Upstream licensing and notices are in [LICENSE.txt](LICENSE.txt) and [ThirdPartyNotices.txt](ThirdPartyNotices.txt).

## Test the workbench

```sh
npm --prefix extensions/agentic-workbench test
AGENTIC_FRAMEWORK_TESTS=1 npm --prefix extensions/agentic-workbench test
```

The opt-in framework tests use OpenSpec and Spec Kit installed on PATH.

To check a packaged app from a clean profile, run its desktop smoke test. It connects to a local fixture provider and exercises Code Factory through the editor UI.

```sh
node extensions/agentic-workbench/test/desktop-smoke.cjs
```
